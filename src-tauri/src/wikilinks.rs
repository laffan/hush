//! Library-wide `[[wikilink]]` rewriting after a rename.
//!
//! This used to live entirely in JS (`src/links/wikilink-rename.js`) and
//! worked off `state.files` — the in-memory cache that held every file's
//! content. That cache is why boot read the whole library, so the cache
//! is gone for notebooks (see `FileManager::list_files`) and the walk
//! moved here.
//!
//! Two things make that affordable. The rename runs on the naming rule's
//! **1.5 s typing-idle debounce** (README-TECHNICAL, "Naming rule"), so it
//! is a hot path and must not do more work than it has to:
//!
//!  - Notebooks are opened as zips and only `data.json` is inflated. The
//!    images inside are never touched — no base64 pass on the way in, no
//!    re-encode on the way out — because a wikilink can only live in a
//!    text shape's body. A proofread notebook is fifty full-page rasters;
//!    reading one through `hushnote::unpack` costs all fifty.
//!  - Every file gets a plain substring pretest before anything is parsed.
//!    Most renames touch nothing, and that case should cost one read.
//!
//! Matching mirrors the JS regex it replaces (`\[\[\s*name\s*\]\]`,
//! case-sensitive, whitespace inside the brackets trimmed) by scanning for
//! bracket pairs directly, so a name carrying regex metacharacters needs
//! no escaping.

use crate::desk_store::DeskStore;
use crate::hushnote;
use serde_json::Value;

/// Rewrite `[[old]]` → `[[new]]` in one markdown body. `None` when
/// nothing matched, so callers can skip the write.
pub fn rewrite_doc(content: &str, old: &str, new: &str) -> Option<String> {
    if !content.contains("[[") || !content.contains("]]") {
        return None;
    }
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    let mut changed = false;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        if let Some(close) = after.find("]]") {
            if after[..close].trim() == old {
                out.push_str(&rest[..open]);
                out.push_str("[[");
                out.push_str(new);
                out.push_str("]]");
                rest = &after[close + 2..];
                changed = true;
                continue;
            }
        }
        // No link here. Emit one byte and rescan from the next position,
        // the way a leftmost regex scan would — `[[[Name]]` holds a real
        // link starting at its second bracket. `[` is ASCII, so `open + 1`
        // is always a char boundary.
        out.push_str(&rest[..open + 1]);
        rest = &rest[open + 1..];
    }
    if !changed {
        return None;
    }
    out.push_str(rest);
    Some(out)
}

/// Rewrite the text shapes of a notebook envelope. Takes and returns the
/// `data.json` body — never the packed zip, so images stay untouched.
pub fn rewrite_notebook_data(data: &str, old: &str, new: &str) -> Option<String> {
    if !data.contains("[[") {
        return None;
    }
    let mut envelope: Value = serde_json::from_str(data).ok()?;
    let shapes = envelope.get_mut("shapes")?.as_array_mut()?;
    let mut changed = false;
    for shape in shapes.iter_mut() {
        let Some(obj) = shape.as_object_mut() else { continue };
        if obj.get("type").and_then(|v| v.as_str()) != Some("text") {
            continue;
        }
        let Some(text) = obj.get("text").and_then(|v| v.as_str()) else { continue };
        if let Some(next) = rewrite_doc(text, old, new) {
            obj.insert("text".to_string(), Value::String(next));
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    serde_json::to_string(&envelope).ok()
}

/// Walk every desk and rewrite `[[old]]` → `[[new]]` wherever it appears,
/// in documents and in notebook text shapes. Returns the fileIds actually
/// written, so the frontend knows which of its surfaces to refresh.
pub fn rename_across_library(store: &DeskStore, old: &str, new: &str) -> Vec<String> {
    let mut touched = Vec::new();
    if old.is_empty() || new.is_empty() || old == new {
        return touched;
    }
    let (indexed, _staged) = store.list_ids();
    for (id, desk_id, rel) in indexed {
        match crate::desk_scan::kind_for_rel(&rel).as_deref() {
            Some("document") => {
                let Ok((content, _, _)) = store.read_at(&desk_id, &rel) else { continue };
                let Some(next) = rewrite_doc(&content, old, new) else { continue };
                if store.write_by_id(&id, &next).is_ok() {
                    touched.push(id);
                }
            }
            Some("notebook") => {
                let bytes = match std::fs::read(store.abs_path(&desk_id, &rel)) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let Ok(data) = hushnote::read_data_json(&bytes) else { continue };
                let Some(next) = rewrite_notebook_data(&data, old, new) else { continue };
                let Ok(packed) = hushnote::replace_data_json(&bytes, &next) else { continue };
                let abs = store.abs_path(&desk_id, &rel);
                if crate::atomic::write_atomic(&abs, &packed).is_ok() {
                    crate::desk_recovery::note_desk_edit(&desk_id);
                    touched.push(id);
                }
            }
            _ => {}
        }
    }
    touched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_plain_and_padded_links() {
        let out = rewrite_doc("see [[Old]] and [[  Old  ]] here", "Old", "New").unwrap();
        assert_eq!(out, "see [[New]] and [[New]] here");
    }

    #[test]
    fn leaves_other_targets_and_prose_alone() {
        assert!(rewrite_doc("see [[Older]] and Old", "Old", "New").is_none());
        assert!(rewrite_doc("no links at all", "Old", "New").is_none());
    }

    #[test]
    fn is_case_sensitive_like_the_regex_it_replaces() {
        assert!(rewrite_doc("[[old]]", "Old", "New").is_none());
    }

    #[test]
    fn finds_a_link_starting_at_the_second_bracket() {
        let out = rewrite_doc("[[[Old]]", "Old", "New").unwrap();
        assert_eq!(out, "[[[New]]");
    }

    #[test]
    fn needs_no_escaping_for_regex_metacharacters() {
        let out = rewrite_doc("[[A (b) [c]]", "A (b) [c", "Plain").unwrap();
        assert_eq!(out, "[[Plain]]");
    }

    #[test]
    fn unterminated_brackets_are_left_as_they_are() {
        assert!(rewrite_doc("[[Old and then nothing]", "Old", "New").is_none());
    }

    #[test]
    fn rewrites_text_shapes_only() {
        let data = r#"{"format":"hushnote","version":1,"shapes":[
            {"type":"text","text":"go to [[Old]]"},
            {"type":"image","dataUrl":"images/img_1.png","text":"[[Old]]"}
        ]}"#;
        let out = rewrite_notebook_data(data, "Old", "New").unwrap();
        assert!(out.contains("go to [[New]]"));
        // The image shape carries the same string and must not be touched.
        assert!(out.contains(r#""dataUrl":"images/img_1.png""#));
        assert_eq!(out.matches("[[New]]").count(), 1);
    }

    #[test]
    fn notebook_without_the_target_is_left_unwritten() {
        let data = r#"{"format":"hushnote","version":1,"shapes":[{"type":"text","text":"[[Other]]"}]}"#;
        assert!(rewrite_notebook_data(data, "Old", "New").is_none());
    }
}
