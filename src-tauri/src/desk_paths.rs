//! Path computation for the desk-folder store: tree names → on-disk
//! relative paths. Split from `desk_store.rs` for the line cap.

use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Document extensions Hush recognises but never *writes*. A doc it
/// created is always `.md`; these only ever arrive by adoption.
const ADOPTED_DOC_EXTS: [&str; 2] = ["markdown", "txt"];

/// `collect_expected` names every document `.md` — right for a doc Hush
/// created, wrong for one it *adopted*. Opening a folder as a desk pulls
/// in whatever `.txt` / `.markdown` files were already there, and
/// renaming a user's files out from under them on the next tree save is
/// not ours to do. So where the expected path differs from the file's
/// current one only by that extension swap, the on-disk extension wins.
/// Everything else — a real move, a rename of the stem, a doc Hush made
/// — passes through untouched.
pub(crate) fn preserve_doc_extensions(
    new_indexes: &mut HashMap<String, HashMap<String, String>>,
    old_global: &HashMap<String, (String, String)>,
) {
    for (desk_id, files) in new_indexes.iter_mut() {
        for (id, rel) in files.iter_mut() {
            let Some((old_desk, old_rel)) = old_global.get(id) else { continue };
            if old_desk != desk_id {
                continue;
            }
            if let Some(kept) = keep_doc_ext(old_rel, rel) {
                *rel = kept;
            }
        }
    }
}

fn keep_doc_ext(old: &str, expected: &str) -> Option<String> {
    let old_ext = Path::new(old).extension()?.to_str()?.to_ascii_lowercase();
    let expected_ext = Path::new(expected).extension()?.to_str()?.to_ascii_lowercase();
    if expected_ext != "md" || !ADOPTED_DOC_EXTS.contains(&old_ext.as_str()) {
        return None;
    }
    Some(format!("{}.{}", expected.strip_suffix(".md")?, old_ext))
}

/// Walk a desk's children computing each file-backed node's relative path
/// and the set of expected directories. Sibling filenames are deduped with
/// " (n)" so two same-named nodes of different types can't collide.
pub(crate) fn collect_expected(
    nodes: &[TreeNode],
    dir_stack: &mut Vec<String>,
    files: &mut HashMap<String, String>,
    dirs: &mut HashSet<PathBuf>,
) {
    let mut used: HashSet<String> = HashSet::new();
    for node in nodes {
        match node.node_type.as_str() {
            "folder" | "project" | "desk" => {
                let seg = dedupe(&sanitize_segment(&node.name), "", &mut used);
                dir_stack.push(seg);
                dirs.insert(PathBuf::from(dir_stack.join("/")));
                collect_expected(&node.children, dir_stack, files, dirs);
                dir_stack.pop();
            }
            "document" | "notebook" | "stack" | "image" => {
                let Some(id) = node.file_id.as_ref() else { continue };
                let (base, ext) = match node.node_type.as_str() {
                    "document" => (sanitize_segment(&node.name), ".md"),
                    "notebook" => (sanitize_segment(&node.name), ".hushnote"),
                    "stack" => (sanitize_segment(&node.name), ".hushstack"),
                    // Image names already carry their extension (the
                    // filename IS the id).
                    _ => (sanitize_segment(&node.name), ""),
                };
                let filename = dedupe(&base, ext, &mut used);
                let rel = if dir_stack.is_empty() {
                    filename
                } else {
                    format!("{}/{}", dir_stack.join("/"), filename)
                };
                files.insert(id.clone(), rel);
            }
            _ => {} // pdf (registry-only) and anything unknown
        }
    }
}

pub(crate) fn dedupe(base: &str, ext: &str, used: &mut HashSet<String>) -> String {
    // Avoid double extensions when the display name already carries one.
    let base = if !ext.is_empty() && base.to_lowercase().ends_with(ext) {
        &base[..base.len() - ext.len()]
    } else {
        base
    };
    let mut candidate = format!("{}{}", base, ext);
    let mut i = 2;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{} ({}){}", base, i, ext);
        i += 1;
    }
    candidate
}

/// A tree name as a single path segment: no separators, no leading dot,
/// never empty, bounded length.
pub fn sanitize_segment(name: &str) -> String {
    let mut cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    while cleaned.starts_with('.') {
        cleaned.remove(0);
    }
    let cleaned = cleaned.trim().to_string();
    let mut out = if cleaned.is_empty() { "Untitled".to_string() } else { cleaned };
    if out.chars().count() > 150 {
        out = out.chars().take(150).collect();
    }
    out
}

