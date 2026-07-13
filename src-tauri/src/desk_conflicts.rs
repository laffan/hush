//! Provider conflicted-copy adoption.
//!
//! Hush doesn't control the transport a local desk syncs over, so it
//! handles the transport's one failure mode explicitly: when two devices
//! write the same file, providers fork a sibling next to it —
//! `Doc (nate's conflicted copy 2026-07-13).md` (Dropbox),
//! `Doc.sync-conflict-20260713-123456-ABCDEF7.md` (Syncthing). The
//! reconciler adopts such siblings instead of listing them as new files:
//! both sides are snapshotted to Versions under the *same* fileId, the
//! newer bytes (by mtime) win the real path, and the sibling is removed.
//! Nothing is ever discarded — the loser is one click away in the
//! Versions modal.
//!
//! iCloud's ambiguous `Name 2.md` pattern is deliberately not matched:
//! it collides with names users actually pick. Binary images are skipped
//! implicitly (their content doesn't read as text), which is fine — an
//! image conflict sibling simply shows up as a separate image.

use crate::desk_hashes::mtime_ms;
use crate::desk_store::{read_content_at, write_content_at, DeskStore};
use crate::snapshots::SnapshotManager;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// The filename a conflict sibling forked from, when `filename` matches
/// a known provider conflict pattern.
pub(crate) fn original_for_conflict(filename: &str) -> Option<String> {
    // Syncthing inserts ".sync-conflict-<date>-<time>-<device>" before
    // the extension.
    if let Some(idx) = filename.find(".sync-conflict-") {
        if idx == 0 {
            return None;
        }
        let base = &filename[..idx];
        let rest = &filename[idx + 1..];
        let ext = Path::new(rest).extension().and_then(|e| e.to_str());
        return Some(match ext {
            Some(e) => format!("{}.{}", base, e),
            None => base.to_string(),
        });
    }
    // Dropbox appends " (… conflicted copy …)" to the stem.
    let p = Path::new(filename);
    let stem = p.file_stem()?.to_str()?;
    let ext = p.extension().and_then(|e| e.to_str());
    if !stem.ends_with(')') {
        return None;
    }
    let open = stem.rfind(" (")?;
    if !stem[open + 2..stem.len() - 1].contains("conflicted copy") {
        return None;
    }
    let base = &stem[..open];
    if base.is_empty() {
        return None;
    }
    Some(match ext {
        Some(e) => format!("{}.{}", base, e),
        None => base.to_string(),
    })
}

impl DeskStore {
    /// Fold provider conflict siblings back into their mapped files.
    /// Runs before the add/remove scan so a sibling is never adopted as
    /// a new file. Returns how many conflicts were resolved.
    pub fn adopt_conflicted_copies(&self, desk_id: &str, index: &HashMap<String, String>) -> usize {
        let root = self.desk_dir(desk_id);
        let rel_to_id: HashMap<&str, &str> = index
            .iter()
            .map(|(id, rel)| (rel.as_str(), id.as_str()))
            .collect();
        let mut on_disk = Vec::new();
        crate::desk_scan::walk_files(&root, &root, &mut on_disk);
        let data_dir = self.desks_dir.parent().unwrap_or(&self.desks_dir);
        let snaps = SnapshotManager::new(data_dir);
        let mut count = 0;

        for rel in on_disk {
            if rel_to_id.contains_key(rel.as_str()) {
                continue; // a mapped file is never a sibling
            }
            let path = Path::new(&rel);
            let Some(fname) = path.file_name().and_then(|s| s.to_str()) else { continue };
            let Some(orig_name) = original_for_conflict(fname) else { continue };
            let orig_rel = match path.parent().filter(|d| !d.as_os_str().is_empty()) {
                Some(dir) => format!("{}/{}", dir.to_string_lossy().replace('\\', "/"), orig_name),
                None => orig_name,
            };
            let Some(&file_id) = rel_to_id.get(orig_rel.as_str()) else { continue };
            let sib_abs = root.join(&rel);
            let orig_abs = root.join(&orig_rel);
            let Ok(sib_content) = read_content_at(&sib_abs) else { continue };

            if !orig_abs.exists() {
                // The mapped side vanished under the same race — the
                // conflict copy *is* the file now.
                let _ = snaps.create_snapshot(file_id, &sib_content);
                if fs::rename(&sib_abs, &orig_abs).is_ok() {
                    count += 1;
                }
                continue;
            }
            let Ok(orig_content) = read_content_at(&orig_abs) else { continue };

            // Both sides into Versions under the same fileId; the newer
            // bytes keep the real path.
            let _ = snaps.create_snapshot(file_id, &orig_content);
            let _ = snaps.create_snapshot(file_id, &sib_content);
            if mtime_ms(&sib_abs) > mtime_ms(&orig_abs) {
                if let Ok(hash) = write_content_at(&orig_abs, &sib_content) {
                    self.record_hash(desk_id, file_id, &hash, mtime_ms(&orig_abs));
                }
            }
            let _ = fs::remove_file(&sib_abs);
            count += 1;
        }
        count
    }
}
