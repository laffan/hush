//! File placement + directory pruning for `save_forest` — split from
//! `desk_store.rs` for the line cap. `place_file` makes one fileId's
//! on-disk file match its tree-computed path; `prune_empty_dirs` clears
//! directories a save emptied.

use crate::desk_store::{write_content_at, DeskStore};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

type BoxError = Box<dyn std::error::Error>;

fn is_image_rel(rel: &str) -> bool {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    crate::local_sync::is_image_extension(&ext)
}

impl DeskStore {
    /// Let the far device's moves stand before placement enforces ours.
    ///
    /// Placement asserts the tree onto the disk, which is only ours to do
    /// for files *we* moved. Where a folder has moved one since we last
    /// committed a placement, take its answer — otherwise the save drags
    /// the far device's file back out of the Trash (or its folder) to
    /// match a tree that predates the move, and the deletion undoes
    /// itself. See `desk_index::rebase_placement` for the three-way rule.
    pub(crate) fn rebase_far_moves(
        &self,
        desks: &[&crate::TreeNode],
        new_indexes: &mut HashMap<String, HashMap<String, String>>,
        roots: &HashMap<String, String>,
        skip: &HashSet<String>,
    ) {
        for desk in desks {
            if skip.contains(&desk.id) || !roots.contains_key(&desk.id) {
                continue; // no folder, or no far device to disagree with
            }
            let root = self.desk_dir(&desk.id);
            let files = new_indexes.entry(desk.id.clone()).or_default();
            let published = self.try_load_index(&desk.id).unwrap_or_default();
            let adopted = crate::desk_index::rebase_placement(&root, &desk.id, files, &published);
            if adopted.is_empty() {
                continue;
            }
            crate::activity_log::note(
                "desks",
                "info",
                format!("Left {} file(s) where the other device moved them: {}",
                    adopted.len(), adopted.join(", ")),
            );
        }
    }

    /// Ensure the file for `id` exists at its expected location, sourcing
    /// from (in priority order) its previous indexed location, the staging
    /// area, an already-present file at the target (adopt), or — for text
    /// kinds — a fresh default payload.
    pub(crate) fn place_file(
        &self,
        id: &str,
        desk_id: &str,
        rel: &str,
        old_global: &HashMap<String, (String, String)>,
    ) -> Result<(), BoxError> {
        let dst = self.abs_path(desk_id, rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }

        if let Some((old_desk, old_rel)) = old_global.get(id) {
            if old_desk == desk_id && old_rel == rel {
                return Ok(()); // already in place
            }
            let src = self.abs_path(old_desk, old_rel);
            if src.exists() {
                if dst.exists() {
                    // Shouldn't happen (names are deduped) — don't clobber.
                    return Ok(());
                }
                fs::rename(&src, &dst)?;
                // A cross-desk move carries the file's version history
                // along so a handed-off desk stays complete.
                if old_desk != desk_id {
                    let old_versions = self.desk_dir(old_desk).join(".hush").join("versions").join(id);
                    if old_versions.is_dir() {
                        let new_versions = self.desk_dir(desk_id).join(".hush").join("versions").join(id);
                        if let Some(parent) = new_versions.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if !new_versions.exists() {
                            let _ = fs::rename(&old_versions, &new_versions);
                        }
                    }
                }
                return Ok(());
            }
        }

        let staged = self.staging_path(id);
        if staged.exists() {
            let content = fs::read_to_string(&staged).unwrap_or_default();
            write_content_at(&dst, &content)?;
            let _ = fs::remove_file(&staged);
            return Ok(());
        }

        if dst.exists() {
            return Ok(()); // adopt (e.g. a binary the image manager already wrote)
        }

        // Images have no default payload — the binary either exists or the
        // ref is broken; creating an empty file would mask that.
        if is_image_rel(rel) {
            return Ok(());
        }
        // Nothing traceable, but a retired desk folder may still hold this
        // file — the shape left behind when a desk that had (wrongly) taken
        // ownership of another desk's content was deleted. Put the real
        // bytes back rather than fabricating an empty document over them:
        // an empty doc reads as a healthy file, and the first keystroke in
        // it would make the loss permanent.
        if let Some(source) = self.find_rescue_copy(id) {
            fs::copy(&source, &dst)?;
            crate::activity_log::note(
                "desks",
                "warn",
                format!("Restored {} from a retired desk folder while placing it", rel),
            );
            return Ok(());
        }
        // An id we can't trace (not indexed, not staged, not recoverable)
        // writing into a *local* desk would drop a blank file into the
        // user's folder — the signature of a stale tree, not a real create
        // (every real create stages first). Leave it; the disk-wins
        // reconcile drops the dangling node on its next pass.
        if crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some() {
            return Ok(());
        }
        write_content_at(&dst, "")?;
        Ok(())
    }

    /// Remove directories that are now empty and no longer expected.
    /// With `managed` set (local desks), only directories in that set —
    /// ones that previously held indexed files, i.e. that Hush itself
    /// emptied by moving files out — are candidates; a user's own empty
    /// directory is never touched.
    pub(crate) fn prune_empty_dirs(
        &self,
        desk_id: &str,
        expected: &HashSet<PathBuf>,
        managed: Option<&HashSet<PathBuf>>,
    ) {
        let root = self.desk_dir(desk_id);
        let mut dirs = Vec::new();
        collect_dirs(&root, &root, &mut dirs);
        // Deepest first so nested empties collapse upward.
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for rel in dirs {
            if rel.starts_with(".hush") {
                continue;
            }
            if expected.contains(&rel) {
                continue;
            }
            if let Some(managed) = managed {
                if !managed.contains(&rel) {
                    continue;
                }
            }
            let abs = root.join(&rel);
            if fs::read_dir(&abs).map(|mut it| it.next().is_none()).unwrap_or(false) {
                let _ = fs::remove_dir(&abs);
            }
        }
    }
}

fn collect_dirs(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(rel) = path.strip_prefix(root) {
                if rel.starts_with(".hush") {
                    continue;
                }
                out.push(rel.to_path_buf());
            }
            collect_dirs(root, &path, out);
        }
    }
}
