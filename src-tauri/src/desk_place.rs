//! File placement + directory pruning for `save_forest` — split from
//! `desk_store.rs` for the line cap. `place_desk_files` makes a desk's
//! files match their tree-computed paths (one `place_file` each) and
//! reports where each one really ended up; `prune_empty_dirs` clears
//! directories a save emptied.

use crate::desk_store::{write_content_at, DeskStore};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

type BoxError = Box<dyn std::error::Error>;

/// Where `place_file` left a file.
pub(crate) enum Placement {
    /// The file is at this desk-relative path — record it.
    At(String),
    /// Nothing to record: a stale id whose destination is another file's.
    Unrecorded,
    /// The destination holds another file; nothing was moved or written.
    Blocked,
}

/// `Doc (3).md` → `Doc.md`; anything else unchanged.
fn strip_numbered_suffix(rel: &str) -> String {
    let path = Path::new(rel);
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { return rel.to_string() };
    let Some(open) = stem.rfind(" (") else { return rel.to_string() };
    let digits = &stem[open + 2..];
    let Some(digits) = digits.strip_suffix(')') else { return rel.to_string() };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return rel.to_string();
    }
    let base = &stem[..open];
    let name = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{}.{}", base, ext),
        None => base.to_string(),
    };
    match path.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(dir) => format!("{}/{}", dir.to_string_lossy().replace('\\', "/"), name),
        None => name,
    }
}

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

    /// Place every file of one desk, rewriting `files` to where each one
    /// actually ended up — which is what the index must record.
    ///
    /// The index used to be written from the *tree's* answer, whatever
    /// placement managed. When a destination was occupied, `place_file`
    /// declined to clobber it (rightly) and the index took the move anyway
    /// (wrongly): the fileId then named another file's bytes. The open
    /// document autosaves through its fileId, so its text landed on top of
    /// that other file, and its own bytes — no longer named by anything —
    /// came back on the next reconcile as a brand-new "duplicate". A
    /// placement is only recorded once the file is really there.
    ///
    /// A destination can be taken for two reasons. A file that is itself
    /// about to move out of the way (two same-named siblings swapping
    /// computed paths) frees up during the pass, so blocked files get a
    /// second try once everything else has landed. Anything else is a
    /// file the tree doesn't know about — typically one the other device
    /// just delivered — and the blocked file is parked on the next free
    /// ` (n)` name beside it rather than on top of it.
    pub(crate) fn place_desk_files(
        &self,
        desk_id: &str,
        files: &mut HashMap<String, String>,
        old_global: &HashMap<String, (String, String)>,
    ) -> Result<(), BoxError> {
        let mut order: Vec<(String, String)> =
            files.iter().map(|(id, rel)| (id.clone(), rel.clone())).collect();
        order.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let mut placed: HashMap<String, String> = HashMap::new();
        let mut blocked: Vec<(String, String)> = Vec::new();
        for (id, rel) in &order {
            match self.place_file(id, desk_id, rel, old_global)? {
                Placement::At(at) => {
                    placed.insert(id.clone(), at);
                }
                Placement::Unrecorded => {}
                Placement::Blocked => blocked.push((id.clone(), rel.clone())),
            }
        }
        let mut parked: Vec<(String, String, String)> = Vec::new();
        for (id, rel) in blocked {
            match self.place_file(&id, desk_id, &rel, old_global)? {
                Placement::At(at) => {
                    placed.insert(id, at);
                }
                Placement::Unrecorded => {}
                // Still taken once everything else has moved. A file
                // already parked on a numbered spelling of this name by
                // an earlier collision stays where it is.
                Placement::Blocked if self.parked_beside(&id, desk_id, &rel, old_global) => {
                    let (_, current) = &old_global[&id];
                    placed.insert(id, current.clone());
                }
                Placement::Blocked => {
                    let taken: HashSet<String> = files
                        .values()
                        .chain(placed.values())
                        .map(|r| r.to_lowercase())
                        .collect();
                    let spare = self.free_variant(desk_id, &rel, &taken);
                    if let Placement::At(at) = self.place_file(&id, desk_id, &spare, old_global)? {
                        crate::activity_log::note(
                            "desks",
                            "warn",
                            format!("{} was taken by another file — kept this one as {}", rel, at),
                        );
                        placed.insert(id.clone(), at.clone());
                        parked.push((id, rel, at));
                    }
                }
            }
        }
        // Parked files go where the tree wanted them if that has since
        // come free (the swap case); otherwise they stay parked.
        for (id, rel, at) in parked {
            let dst = self.abs_path(desk_id, &rel);
            if dst.exists() || placed.values().any(|r| r != &at && r.eq_ignore_ascii_case(&rel)) {
                continue;
            }
            if fs::rename(self.abs_path(desk_id, &at), &dst).is_ok() {
                placed.insert(id, rel);
            }
        }
        *files = placed;
        Ok(())
    }

    /// The first ` (n)` spelling of `rel` that no file on disk and no
    /// other placement in this pass holds. A name that already carries a
    /// ` (n)` counts up from its base rather than growing a second one.
    fn free_variant(&self, desk_id: &str, rel: &str, taken: &HashSet<String>) -> String {
        let base = strip_numbered_suffix(rel);
        let mut n = 2;
        loop {
            let candidate = crate::desk_paths::numbered_variant(&base, n);
            if !taken.contains(&candidate.to_lowercase())
                && !self.abs_path(desk_id, &candidate).exists()
            {
                return candidate;
            }
            n += 1;
        }
    }

    /// Put the file for `id` at `rel`, sourcing from (in priority order)
    /// its previous indexed location, the staging area, an unclaimed file
    /// already at the target (adopt), or — for text kinds — a fresh
    /// default payload. Never writes or moves anything onto another
    /// file's bytes: an occupied destination comes back `Blocked`.
    pub(crate) fn place_file(
        &self,
        id: &str,
        desk_id: &str,
        rel: &str,
        old_global: &HashMap<String, (String, String)>,
    ) -> Result<Placement, BoxError> {
        let dst = self.abs_path(desk_id, rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }

        if let Some((old_desk, old_rel)) = old_global.get(id) {
            if old_desk == desk_id && old_rel == rel {
                return Ok(Placement::At(rel.to_string())); // already in place
            }
            let src = self.abs_path(old_desk, old_rel);
            if src.exists() {
                if dst.exists() {
                    if !crate::desk_paths::same_file(&src, &dst) {
                        return Ok(Placement::Blocked);
                    }
                    // One file, two spellings — a case-only (or Unicode
                    // normalisation) rename on a case-insensitive
                    // volume. Renaming takes the new spelling; skipping it
                    // left the index spelling the name one way and the
                    // folder the other, and the next reconcile minted a
                    // second id for the "unindexed" file.
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
                return Ok(Placement::At(rel.to_string()));
            }
        }

        let staged = self.staging_path(id);
        if staged.exists() {
            if dst.exists() {
                // Writing the staged bytes here would overwrite a file
                // the tree doesn't know about (the far device's, most
                // likely) with this new one.
                return Ok(Placement::Blocked);
            }
            let content = fs::read_to_string(&staged).unwrap_or_default();
            write_content_at(&dst, &content)?;
            let _ = fs::remove_file(&staged);
            return Ok(Placement::At(rel.to_string()));
        }

        if dst.exists() {
            // Adopt (e.g. a binary the image manager already wrote) — but
            // only a file nobody else is named for. An untraceable id
            // taking over another id's file is two ids for one file.
            if self.claimed_by_other(id, desk_id, rel, &dst, old_global) {
                return Ok(match old_global.get(id) {
                    Some((d, r)) if d == desk_id => Placement::At(r.clone()),
                    _ => Placement::Unrecorded,
                });
            }
            return Ok(Placement::At(rel.to_string()));
        }

        // Images have no default payload — the binary either exists or the
        // ref is broken; creating an empty file would mask that.
        if is_image_rel(rel) {
            return Ok(Placement::At(rel.to_string()));
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
            return Ok(Placement::At(rel.to_string()));
        }
        // An id we can't trace (not indexed, not staged, not recoverable)
        // writing into a *local* desk would drop a blank file into the
        // user's folder — the signature of a stale tree, not a real create
        // (every real create stages first). Leave it; the disk-wins
        // reconcile drops the dangling node on its next pass.
        if crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some() {
            return Ok(Placement::At(rel.to_string()));
        }
        write_content_at(&dst, "")?;
        Ok(Placement::At(rel.to_string()))
    }

    /// Whether `id` already sits in this desk on a ` (n)` spelling of `rel`.
    fn parked_beside(
        &self,
        id: &str,
        desk_id: &str,
        rel: &str,
        old_global: &HashMap<String, (String, String)>,
    ) -> bool {
        old_global
            .get(id)
            .map(|(d, r)| d == desk_id && crate::desk_paths::is_variant_of(r, rel))
            .unwrap_or(false)
    }

    /// Whether some other fileId in this desk's index is already named
    /// for the file at `dst` — by path, or by being the same file under
    /// another spelling.
    fn claimed_by_other(
        &self,
        id: &str,
        desk_id: &str,
        rel: &str,
        dst: &Path,
        old_global: &HashMap<String, (String, String)>,
    ) -> bool {
        let dir = Path::new(rel).parent();
        old_global.iter().any(|(other, (d, r))| {
            other != id
                && d == desk_id
                && (r == rel
                    || (Path::new(r).parent() == dir
                        && crate::desk_paths::same_file(&self.abs_path(d, r), dst)))
        })
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
