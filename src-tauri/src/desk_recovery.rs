//! Automatic recovery snapshots for local desks.
//!
//! A local desk operates from a folder a sync provider (iCloud Drive,
//! Dropbox, Syncthing) mutates underneath Hush, and the disk-wins
//! reconciler deliberately follows that folder. When the provider
//! misrepresents it — files not yet downloaded, `.icloud` placeholders,
//! a half-propagated adoption — following it can cost real content.
//! Until that is robustly fixed, this module keeps a rolling set of
//! whole-desk snapshots on *this* device so any such event is
//! recoverable wholesale, independent of (but containing) the per-file
//! Versions history, which rides inside each snapshot's `.hush/`.
//!
//! Mechanics: every content mutation that flows through the desk store
//! (`write_by_id`, `rename_by_id`, `delete_by_id`, image saves) stamps
//! the desk as edited in a process-wide map. A background thread wakes
//! once a minute and zips any **local** desk edited since its newest
//! snapshot, provided that snapshot is at least `SNAPSHOT_INTERVAL_SECS`
//! old — a desk with no snapshot yet is due immediately, so a first
//! session shorter than the interval is still captured. At boot the
//! stamps are seeded from content mtimes, so edits from a previous run
//! (or changes a provider synced in while Hush was closed) that postdate
//! the newest snapshot count as pending edits too. Snapshots are the
//! exact zip envelope desk archives use (desk_archive.rs), stored under
//! `{data_dir}/desk-recovery/<deskId>/<epoch>.husharchive` and pruned to
//! the newest `KEEP_PER_DESK`.
//!
//! Restoring builds a **new internal desk** through the same
//! re-identification pass archives use (fresh desk id, fresh fileIds),
//! so a recovery can never collide with the desk it snapshotted — and
//! the user's own folder is never written to. Surfaced in Settings >
//! Sync > Recovery (`settings/settings-tabs-recovery.js`).

use crate::desk_archive::{build_desk_zip, read_manifest, ArchiveInfo, ARCHIVE_EXT};
use crate::desk_store::DeskStore;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

pub const SNAPSHOT_INTERVAL_SECS: u64 = 30 * 60;
pub const KEEP_PER_DESK: usize = 16;
/// Refuse to snapshot a folder past this raw size — the zip is built in
/// memory (see `build_desk_zip`), and a runaway folder would take the
/// app down with it. The skip is logged so it's never silent.
const MAX_DESK_BYTES: u64 = 1 << 30; // 1 GiB

static EDIT_STAMPS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn stamps() -> &'static Mutex<HashMap<String, u64>> {
    EDIT_STAMPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Record that `desk_id` just received a real content mutation. Called
/// from the desk store's write seams on every save/rename/delete — cheap
/// enough for the autosave path. External changes (reconcile moves,
/// conflict adoption) deliberately don't stamp: a snapshot should be
/// driven by the user's own editing, never by a provider rearranging the
/// folder, so a synced-in wipe can't burn rotation slots on empty states.
pub fn note_desk_edit(desk_id: &str) {
    stamps().lock().unwrap().insert(desk_id.to_string(), now_secs());
}

/// A path component that arrived over IPC: must be a bare name — no
/// separators, no leading dot, no traversal.
fn safe_component(s: &str) -> Result<&str, BoxError> {
    if s.is_empty()
        || s.starts_with('.')
        || s.contains('/')
        || s.contains('\\')
        || s.contains("..")
    {
        return Err(format!("invalid path component: {}", s).into());
    }
    Ok(s)
}

/// A snapshot filename's epoch stamp, when it parses as one.
fn stamp_of(file_name: &str) -> Option<u64> {
    Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.parse().ok())
}

/// The desk's display name straight from its folder (`.hushdesk`, then
/// the tree root), so the scheduler needs no frontend help.
fn desk_display_name(root: &Path) -> String {
    let from = |path: PathBuf| -> Option<String> {
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
        Some(v.get("name")?.as_str()?.to_string())
    };
    from(root.join(".hushdesk"))
        .or_else(|| from(root.join(".hush").join("tree.json")))
        .unwrap_or_else(|| "Untitled desk".to_string())
}

impl DeskStore {
    /// Where recovery snapshots live: beside `desks/` and `desk-archives/`,
    /// one subdirectory per desk id.
    pub fn recovery_dir(&self) -> PathBuf {
        self.desks_dir
            .parent()
            .unwrap_or(&self.desks_dir)
            .join("desk-recovery")
    }

    fn desk_recovery_dir(&self, desk_id: &str) -> PathBuf {
        self.recovery_dir().join(desk_id)
    }

    /// Snapshot filenames for one desk, oldest first.
    fn snapshot_files(&self, desk_id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(rd) = fs::read_dir(self.desk_recovery_dir(desk_id)) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.path().extension().and_then(|e| e.to_str()) == Some(ARCHIVE_EXT)
                    && stamp_of(&name).is_some()
                {
                    out.push(name);
                }
            }
        }
        out.sort_by_key(|n| stamp_of(n).unwrap_or(0));
        out
    }

    /// The newest snapshot's epoch for a desk, when one exists.
    pub(crate) fn newest_snapshot_at(&self, desk_id: &str) -> Option<u64> {
        self.snapshot_files(desk_id).last().and_then(|n| stamp_of(n))
    }

    /// Zip the desk's whole folder into its recovery directory and prune
    /// old snapshots down to `KEEP_PER_DESK`.
    pub fn snapshot_desk_for_recovery(&self, desk_id: &str) -> Result<ArchiveInfo, BoxError> {
        let root = self.desk_dir(desk_id);
        if !root.join(".hush").join("tree.json").exists() {
            return Err(format!("desk {} has no folder to snapshot", desk_id).into());
        }
        let mut entries = Vec::new();
        crate::desk_archive::walk_all(&root, &root, &mut entries);
        let total: u64 = entries
            .iter()
            .map(|(_, abs)| fs::metadata(abs).map(|m| m.len()).unwrap_or(0))
            .sum();
        if total > MAX_DESK_BYTES {
            return Err(format!(
                "desk folder is {} MB — past the {} MB snapshot limit",
                total / (1024 * 1024),
                MAX_DESK_BYTES / (1024 * 1024)
            )
            .into());
        }

        let name = desk_display_name(&root);
        let was_local = crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some();
        let dir = self.desk_recovery_dir(desk_id);
        fs::create_dir_all(&dir)?;
        // Filenames are epoch stamps and double as the ordering, so they
        // must be strictly increasing — bump past the newest snapshot
        // (which also clears any same-second collision).
        let mut at = now_secs();
        if let Some(newest) = self.newest_snapshot_at(desk_id) {
            if at <= newest {
                at = newest + 1;
            }
        }
        let file_name = format!("{}.{}", at, ARCHIVE_EXT);
        let path = dir.join(&file_name);

        let (buf, files) = build_desk_zip(&root, &name, desk_id, was_local, at)?;
        let bytes = buf.len() as u64;
        fs::write(&path, &buf)?;
        self.prune_recovery_snapshots(desk_id);

        Ok(ArchiveInfo {
            file: file_name,
            path: path.to_string_lossy().into_owned(),
            name,
            desk_id: desk_id.to_string(),
            archived_at: at,
            bytes,
            files,
            was_local,
        })
    }

    fn prune_recovery_snapshots(&self, desk_id: &str) {
        let files = self.snapshot_files(desk_id);
        if files.len() <= KEEP_PER_DESK {
            return;
        }
        let dir = self.desk_recovery_dir(desk_id);
        for name in &files[..files.len() - KEEP_PER_DESK] {
            let _ = fs::remove_file(dir.join(name));
        }
    }

    /// Every recovery snapshot across every desk, newest first. Snapshots
    /// of desks that no longer exist locally stay listed — those are
    /// exactly the ones a recovery is for.
    pub fn list_recovery_snapshots(&self) -> Vec<ArchiveInfo> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(self.recovery_dir()) else { return out };
        for entry in rd.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let desk_id = entry.file_name().to_string_lossy().into_owned();
            for file in self.snapshot_files(&desk_id) {
                let path = entry.path().join(&file);
                let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let manifest = read_manifest(&path).unwrap_or_else(|| serde_json::json!({}));
                out.push(ArchiveInfo {
                    name: manifest
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Untitled desk")
                        .to_string(),
                    desk_id: desk_id.clone(),
                    archived_at: stamp_of(&file).unwrap_or(0),
                    files: manifest.get("files").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                    was_local: manifest.get("wasLocal").and_then(|v| v.as_bool()).unwrap_or(false),
                    path: path.to_string_lossy().into_owned(),
                    file,
                    bytes,
                });
            }
        }
        out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
        out
    }

    pub fn delete_recovery_snapshot(&self, desk_id: &str, file: &str) -> Result<(), BoxError> {
        let dir = self.desk_recovery_dir(safe_component(desk_id)?);
        let name = safe_component(file)?;
        if !name.ends_with(&format!(".{}", ARCHIVE_EXT)) {
            return Err(format!("not a snapshot filename: {}", file).into());
        }
        let path = dir.join(name);
        if path.is_file() {
            fs::remove_file(&path)?;
            crate::activity_log::note(
                "desks",
                "info",
                format!("Deleted recovery snapshot {} of desk {}", file, desk_id),
            );
        }
        // A desk directory emptied by deletes doesn't need to linger.
        let _ = fs::remove_dir(&dir);
        Ok(())
    }

    /// Build a brand-new internal desk named `new_name` from a snapshot.
    /// Fresh ids throughout (the same re-identify pass archives use), so
    /// recovering is safe to run any number of times, beside the live
    /// desk included. Returns the new desk id.
    pub fn restore_recovery_snapshot(
        &self,
        desk_id: &str,
        file: &str,
        new_name: &str,
    ) -> Result<String, BoxError> {
        let dir = self.desk_recovery_dir(safe_component(desk_id)?);
        let name = safe_component(file)?;
        if !name.ends_with(&format!(".{}", ARCHIVE_EXT)) {
            return Err(format!("not a snapshot filename: {}", file).into());
        }
        let new_id = self.restore_desk_zip(&dir.join(name))?;
        rename_restored_desk(&self.desks_dir.join(&new_id), new_name)?;
        crate::activity_log::note(
            "desks",
            "info",
            format!("Recovered desk \"{}\" from snapshot {} of {}", new_name, file, desk_id),
        );
        Ok(new_id)
    }
}

/// Point a just-restored desk's name at the recovery title — tree root
/// and `.hushdesk` together, the same two spots `save_forest` keeps in
/// step.
fn rename_restored_desk(root: &Path, new_name: &str) -> Result<(), BoxError> {
    let tree_path = root.join(".hush").join("tree.json");
    let mut tree: crate::TreeNode = serde_json::from_str(&fs::read_to_string(&tree_path)?)?;
    tree.name = new_name.to_string();
    crate::atomic::write_atomic_str(&tree_path, &serde_json::to_string_pretty(&tree)?)?;

    let meta_path = root.join(".hushdesk");
    let mut meta: serde_json::Value = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    meta["name"] = new_name.into();
    crate::atomic::write_atomic_str(&meta_path, &serde_json::to_string_pretty(&meta)?)?;
    Ok(())
}

// ===== Scheduler =====

/// Start the background snapshot thread — once per process, from setup.
pub fn start_scheduler(data_dir: PathBuf) {
    std::thread::spawn(move || {
        seed_stamps_from_disk(&data_dir);
        loop {
            std::thread::sleep(Duration::from_secs(60));
            tick(&data_dir);
        }
    });
}

/// Boot seeding: a local desk whose newest content mtime postdates its
/// newest snapshot has pending edits this process never saw — edits from
/// the previous run, or changes the provider synced in while Hush was
/// closed. Stamp it so the first due tick captures them. Content only
/// (the reconciler's walk skips `.hush/` and dotfiles), so a folder that
/// merely lost files — the wipe this system exists to survive — doesn't
/// read as edited.
fn seed_stamps_from_disk(data_dir: &Path) {
    let store = DeskStore::new(data_dir);
    for (desk_id, root) in crate::desk_roots::load_roots(&store.desks_dir) {
        let root = PathBuf::from(root);
        let mut rels = Vec::new();
        crate::desk_scan::walk_files(&root, &root, &mut rels);
        let newest_edit = rels
            .iter()
            .filter_map(|rel| fs::metadata(root.join(rel)).ok())
            .filter_map(|m| m.modified().ok())
            .filter_map(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .max();
        let Some(newest_edit) = newest_edit else { continue };
        if newest_edit > store.newest_snapshot_at(&desk_id).unwrap_or(0) {
            stamps().lock().unwrap().entry(desk_id).or_insert(newest_edit);
        }
    }
}

/// One scheduler pass: snapshot every local desk with edits newer than
/// its newest snapshot, once that snapshot is `SNAPSHOT_INTERVAL_SECS`
/// old (or doesn't exist). Kept separate from the thread loop so tests
/// can drive it directly.
pub(crate) fn tick(data_dir: &Path) {
    let store = DeskStore::new(data_dir);
    let roots = crate::desk_roots::load_roots(&store.desks_dir);
    if roots.is_empty() {
        return;
    }
    let now = now_secs();
    let pending: Vec<(String, u64)> = {
        let map = stamps().lock().unwrap();
        roots
            .keys()
            .filter_map(|id| map.get(id).map(|t| (id.clone(), *t)))
            .collect()
    };
    for (desk_id, edited_at) in pending {
        if let Some(at) = store.newest_snapshot_at(&desk_id) {
            if edited_at <= at {
                continue; // nothing new since the last snapshot
            }
            if now.saturating_sub(at) < SNAPSHOT_INTERVAL_SECS {
                continue; // not due yet
            }
        }
        match store.snapshot_desk_for_recovery(&desk_id) {
            Ok(info) => crate::activity_log::note(
                "desks",
                "info",
                format!(
                    "Recovery snapshot of \"{}\" ({} files, {} KB)",
                    info.name,
                    info.files,
                    info.bytes / 1024
                ),
            ),
            Err(e) => {
                // Drop the stamp so a persistent failure (an oversized
                // folder, an unreachable iOS root) logs once per edit
                // burst instead of once per minute; the next edit re-arms.
                stamps().lock().unwrap().remove(&desk_id);
                crate::activity_log::note(
                    "desks",
                    "warn",
                    format!("Recovery snapshot failed for desk {}: {}", desk_id, e),
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "desk_recovery_tests.rs"]
mod tests;
