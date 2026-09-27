//! Content writes by fileId — split from `desk_store.rs` for the line
//! cap, and because this is where the two refusals live that keep one
//! file's text from ever landing on another's.
//!
//! 1. **A path two ids claim is written by neither.** The index is the
//!    only thing that turns a fileId into a file, so an index naming one
//!    path under two ids means two documents share one file: whichever
//!    autosaves last silently replaces the other. Placement no longer
//!    produces that shape (`place_desk_files`), and the reconciler folds
//!    it away when it finds one (`desk_scan`), but a write is the moment
//!    the damage becomes permanent, so it checks for itself.
//! 2. **A save knows what it was based on.** An editor that opened a file
//!    before the other device's version arrived — the last-open document
//!    at launch is the usual one — holds a buffer the disk has since moved
//!    past. Writing it back unconditionally is last-writer-wins at the
//!    level of the whole file: the other device's edit disappears without
//!    anyone being asked. `write_checked` takes the hash of the content
//!    the buffer was loaded from, and when the disk no longer holds that,
//!    it refuses and hands back what it found instead, so the frontend can
//!    merge the two or ask the user. Nothing is written in that case —
//!    the original is never the thing a conflict costs.

use crate::atomic::write_atomic_str;
use crate::desk_store::{is_image_rel, read_content_at, write_content_at, DeskStore};
use crate::desk_paths::sanitize_segment;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

type BoxError = Box<dyn std::error::Error>;

/// The token a save's base is compared by: FNV-1a over the content's
/// UTF-8 bytes — the internal string form, not the on-disk one, so a
/// notebook's zip packing doesn't enter into it.
pub fn content_hash(content: &str) -> String {
    crate::desk_hashes::fnv1a_hex(content.as_bytes())
}

/// fileId → hashes of the content this process wrote for it lately.
///
/// A base that no longer matches the disk means *someone else* wrote the
/// file — unless the someone is this process: a second window on the same
/// doc (which live-mirrors the first, so its buffer already carries that
/// write), a pane, a wikilink rewrite, a Courier append. Those are not the
/// other device's edits, and asking the user about them would be a false
/// alarm every time two windows share a document.
static OWN_WRITES: OnceLock<Mutex<HashMap<String, VecDeque<String>>>> = OnceLock::new();
const OWN_WRITES_KEPT: usize = 16;

fn own_writes() -> &'static Mutex<HashMap<String, VecDeque<String>>> {
    OWN_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn note_own_write(id: &str, hash: &str) {
    let mut map = own_writes().lock().unwrap();
    let ring = map.entry(id.to_string()).or_default();
    ring.retain(|h| h != hash);
    ring.push_back(hash.to_string());
    while ring.len() > OWN_WRITES_KEPT {
        ring.pop_front();
    }
}

fn is_own_write(id: &str, hash: &str) -> bool {
    own_writes().lock().unwrap().get(id).map(|r| r.iter().any(|h| h == hash)).unwrap_or(false)
}

/// What a checked save did.
#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    /// `content_hash` of what is on disk now — the base for the next
    /// save. On a conflict, the disk's hash rather than ours.
    pub hash: String,
    pub conflict: Option<SaveConflict>,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveConflict {
    /// `"changed"`: the file holds something other than the base.
    /// `"missing"`: there is no file where the index says this one is.
    pub kind: String,
    pub disk_content: Option<String>,
}

impl DeskStore {
    /// Unconditional write — every caller that has no notion of a base
    /// (new files, notebooks, panes, programmatic rewrites).
    pub fn write_by_id(&self, id: &str, content: &str) -> Result<(), BoxError> {
        self.write_checked(id, content, None).map(|_| ())
    }

    /// Write `content` for `id`, unless the file no longer holds the
    /// content whose hash is `base` — then write nothing and report what
    /// is there. See the module docs.
    pub fn write_checked(&self, id: &str, content: &str, base: Option<&str>) -> Result<SaveReport, BoxError> {
        let ours = content_hash(content);
        if let Some((desk_id, rel, index)) = self.locate_with_index(id) {
            let abs = self.abs_path(&desk_id, &rel);
            if let Some(other) = self.shares_path_with(&desk_id, &index, id, &rel) {
                crate::activity_log::note(
                    "desks",
                    "error",
                    format!("Refused to save {}: {} is also indexed as {} — writing would overwrite that file", id, rel, other),
                );
                return Err(format!("{} shares its file with {} — not saved", id, other).into());
            }
            if let Some(base) = base {
                match read_content_at(&abs) {
                    Ok(disk) => {
                        let theirs = content_hash(&disk);
                        if theirs != base && theirs != ours && !is_own_write(id, &theirs) {
                            crate::activity_log::note(
                                "desks",
                                "warn",
                                format!("Held a save of {}: it changed on disk since it was opened", rel),
                            );
                            return Ok(SaveReport {
                                hash: theirs,
                                conflict: Some(SaveConflict { kind: "changed".into(), disk_content: Some(disk) }),
                            });
                        }
                    }
                    Err(e) => {
                        if abs.exists() || crate::desk_identity::awaiting_download(&abs) {
                            // Unreadable or undelivered — not ours to guess over.
                            return Err(crate::desk_identity::undelivered_or(e, &abs));
                        }
                        return Ok(SaveReport {
                            hash: String::new(),
                            conflict: Some(SaveConflict { kind: "missing".into(), disk_content: None }),
                        });
                    }
                }
            }
            let hash = write_content_at(&abs, content)?;
            note_own_write(id, &ours);
            if !is_image_rel(&rel) {
                self.record_hash(&desk_id, id, &hash, crate::desk_hashes::mtime_ms(&abs));
            }
            crate::desk_recovery::note_desk_edit(&desk_id);
            return Ok(SaveReport { hash: ours, conflict: None });
        }
        // Not placed yet — keep (or put) it in staging; the next tree save
        // moves it to its real path.
        let staged = self.staging_path(id);
        if let Some(parent) = staged.parent() {
            fs::create_dir_all(parent)?;
        }
        // `create_file` stages a new id before its first write, so an
        // existing staging file is the normal case. Nothing there means
        // this id *was* placed and has fallen out of its desk's index.
        // Staging catches the bytes but is per-device — the edit reaches
        // no other machine — and the symptom looks exactly like nothing
        // happening, so say so.
        if !staged.exists() {
            crate::activity_log::note(
                "desks",
                "error",
                format!("Wrote {} to staging — no desk index places it", id),
            );
        }
        write_atomic_str(&staged, content)?;
        Ok(SaveReport { hash: ours, conflict: None })
    }

    /// `locate`, keeping the index it found the id in.
    fn locate_with_index(&self, id: &str) -> Option<(String, String, HashMap<String, String>)> {
        for desk_id in self.desk_ids_on_disk() {
            let index = self.load_index(&desk_id);
            if let Some(rel) = index.get(id).cloned() {
                return Some((desk_id, rel, index));
            }
        }
        None
    }

    /// Another id in `index` named for the same file as `id` — the same
    /// path, or another spelling of it on a case-insensitive volume.
    fn shares_path_with(
        &self,
        desk_id: &str,
        index: &HashMap<String, String>,
        id: &str,
        rel: &str,
    ) -> Option<String> {
        // Another spelling of one file lives in the same directory, so
        // only those entries are worth a stat — this runs on every save.
        let dir = Path::new(rel).parent();
        let mine = crate::desk_paths::file_key(&self.abs_path(desk_id, rel));
        index
            .iter()
            .find(|(other, other_rel)| {
                other.as_str() != id
                    && (other_rel.as_str() == rel
                        || (mine.is_some()
                            && Path::new(other_rel.as_str()).parent() == dir
                            && crate::desk_paths::file_key(&self.abs_path(desk_id, other_rel)) == mine))
            })
            .map(|(other, _)| other.clone())
    }

    pub fn delete_by_id(&self, id: &str) -> Result<(), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            if abs.exists() {
                fs::remove_file(&abs)?;
            }
            let mut index = self.load_index(&desk_id);
            index.remove(id);
            self.save_index(&desk_id, &index)?;
            crate::desk_recovery::note_desk_edit(&desk_id);
            return Ok(());
        }
        let staged = self.staging_path(id);
        if staged.exists() {
            fs::remove_file(&staged)?;
        }
        Ok(())
    }

    /// Rename the backing file in place (same directory, extension kept).
    /// Staged / unplaced ids are a no-op — the tree name wins at placement.
    pub fn rename_by_id(&self, id: &str, new_name: &str) -> Result<(), BoxError> {
        let Some((desk_id, rel)) = self.locate(id) else { return Ok(()) };
        let rel_path = Path::new(&rel);
        let ext = rel_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let dir = rel_path.parent().unwrap_or(Path::new(""));
        let mut base = sanitize_segment(new_name);
        if !ext.is_empty() {
            let suffix = format!(".{}", ext);
            if base.to_lowercase().ends_with(&suffix) {
                base.truncate(base.len() - suffix.len());
            }
        }
        let new_rel_path = if ext.is_empty() {
            dir.join(&base)
        } else {
            dir.join(format!("{}.{}", base, ext))
        };
        let new_rel = new_rel_path.to_string_lossy().replace('\\', "/");
        if new_rel == rel {
            return Ok(());
        }
        let src = self.abs_path(&desk_id, &rel);
        let dst = self.abs_path(&desk_id, &new_rel);
        // A different file already has this name: leave both alone. The
        // tree save that follows parks this one on a free ` (n)` name
        // (`place_desk_files`) — it never takes the other file's place.
        // The *same* file under another spelling is a case-only rename on
        // a case-insensitive volume, and goes ahead: skipping it left the
        // folder spelling the name one way and the index the other, and
        // the reconciler then minted a second id for the "new" file.
        if dst.exists() && !crate::desk_paths::same_file(&src, &dst) {
            return Ok(());
        }
        if src.exists() {
            fs::rename(&src, &dst)?;
        }
        let mut index = self.load_index(&desk_id);
        index.insert(id.to_string(), new_rel);
        self.save_index(&desk_id, &index)?;
        crate::desk_recovery::note_desk_edit(&desk_id);
        Ok(())
    }
}

#[cfg(test)]
#[path = "desk_write_tests.rs"]
mod tests;
