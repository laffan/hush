//! Desk backups — hourly zips of a whole desk, written to a folder the
//! user chose.
//!
//! Recovery snapshots (desk_recovery.rs) live inside app data and cover
//! local desks only; a backup is the copy that lives *outside* Hush, for
//! internal and local desks alike: a folder on another drive, a synced
//! folder, anywhere the user points it. Each desk has its own target
//! (`{data_dir}/desk-backups.json`, per device — a path on this machine
//! means nothing on another one), set when the desk is made ("Use
//! Backups" in the New desk prompt) or later from the palette.
//!
//! A backup is the archive envelope (desk_archive.rs) minus PDFs: PDF
//! binaries are a per-device cache re-downloadable from Zotero, so they
//! stay out, and the registry entries that describe them ride along as
//! `pdfs.json` so a recovery can put them back (desk_backup_restore.rs).
//! Files are named `<Desk>_<YYYY-MM-DD_HHMMSS>_<deskId>.zip` in local
//! time: readable in Finder, and the desk id keeps several desks sharing
//! one folder apart — the name is what identifies a backup, so listing
//! never has to open one.
//!
//! The scheduler wakes each minute and backs up any desk whose newest
//! backup is an hour old and that has changed since — an edit stamped
//! this run (the same stamps recovery snapshots read), or failing that a
//! file in the folder newer than the backup (checked at most hourly).
//! Old backups thin out by the Versions decay policy
//! (`snapshots::decay_doomed`), so a day's hourly copies become one.

use crate::desk_archive::{build_desk_zip_with, slug, walk_all, ArchiveInfo};
use crate::desk_store::DeskStore;
use crate::TreeNode;
use chrono::{Local, NaiveDateTime, TimeZone};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

pub const BACKUP_INTERVAL_SECS: u64 = 60 * 60;
/// The zip is built in memory, as archives and recovery snapshots are;
/// past this a desk is refused rather than taking the app down.
const MAX_DESK_BYTES: u64 = 1 << 30; // 1 GiB
/// Let the launch's own reads go first (see desk_recovery's seed delay).
const START_DELAY_SECS: u64 = 45;
const CONFIG_FILE: &str = "desk-backups.json";
/// The PDF registry entries for the desk's PDFs, at the zip root.
pub const PDFS_ENTRY: &str = "pdfs.json";
const STAMP_FORMAT: &str = "%Y-%m-%d_%H%M%S";
const STAMP_LEN: usize = 17;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub path: String,
    /// iOS: the security-scoped bookmark the picker minted; the frontend
    /// re-resolves it at boot so Rust can write into the folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BackupConfig {
    #[serde(default)]
    desks: HashMap<String, BackupTarget>,
    /// The folder most recently chosen, offered first next time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_folder: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The desk id as it appears in a backup's filename.
fn id_tag(desk_id: &str) -> String {
    let tag: String = desk_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    if tag.is_empty() { "desk".to_string() } else { tag }
}

fn local_stamp(at: u64) -> String {
    Local
        .timestamp_opt(at as i64, 0)
        .single()
        .map(|t| t.format(STAMP_FORMAT).to_string())
        .unwrap_or_else(|| "1970-01-01_000000".to_string())
}

pub(crate) fn backup_file_name(desk_name: &str, desk_id: &str, at: u64) -> String {
    format!("{}_{}_{}.zip", slug(desk_name), local_stamp(at), id_tag(desk_id))
}

/// The epoch a backup filename was stamped with, when it is one of this
/// desk's backups. The stamp has to parse as well as the suffix match:
/// desk id `x-abc` can't be mistaken for desk `abc` that way.
pub(crate) fn parse_backup_name(file: &str, desk_id: &str) -> Option<u64> {
    let head = file.strip_suffix(&format!("_{}.zip", id_tag(desk_id)))?;
    if head.len() < STAMP_LEN + 2 || !head.is_char_boundary(head.len() - STAMP_LEN) {
        return None;
    }
    let (rest, stamp) = head.split_at(head.len() - STAMP_LEN);
    if !rest.ends_with('_') {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(stamp, STAMP_FORMAT).ok()?;
    let at = Local.from_local_datetime(&naive).earliest()?.timestamp();
    u64::try_from(at).ok()
}

/// Every PDF the desk's tree holds (aliases excluded — they share the
/// original's fileId), as (fileId, name).
pub(crate) fn desk_pdfs(node: &TreeNode, out: &mut Vec<(String, String)>) {
    for child in &node.children {
        if child.node_type == "pdf" && !child.pdf_alias {
            if let Some(fid) = &child.file_id {
                if !out.iter().any(|(f, _)| f == fid) {
                    out.push((fid.clone(), child.name.clone()));
                }
            }
        }
        desk_pdfs(child, out);
    }
}

pub(crate) fn read_tree(root: &Path) -> Option<TreeNode> {
    serde_json::from_str(&fs::read_to_string(root.join(".hush").join("tree.json")).ok()?).ok()
}

fn is_pdf(rel: &str) -> bool {
    rel.to_ascii_lowercase().ends_with(".pdf")
}

impl DeskStore {
    fn data_dir(&self) -> PathBuf {
        self.desks_dir.parent().unwrap_or(&self.desks_dir).to_path_buf()
    }

    fn load_backup_config(&self) -> BackupConfig {
        fs::read_to_string(self.data_dir().join(CONFIG_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_backup_config(&self, config: &BackupConfig) -> Result<(), BoxError> {
        crate::atomic::write_atomic_str(
            &self.data_dir().join(CONFIG_FILE),
            &serde_json::to_string_pretty(config)?,
        )?;
        Ok(())
    }

    pub fn backup_targets(&self) -> HashMap<String, BackupTarget> {
        self.load_backup_config().desks
    }

    pub fn backup_target(&self, desk_id: &str) -> Option<BackupTarget> {
        self.load_backup_config().desks.remove(desk_id)
    }

    /// The folder to offer a desk that has none: the last one chosen,
    /// else `Documents/Hush Backups`.
    pub fn default_backup_folder(&self) -> String {
        if let Some(last) = self.load_backup_config().last_folder {
            return last;
        }
        dirs::document_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
            .unwrap_or_else(|| self.data_dir())
            .join("Hush Backups")
            .to_string_lossy()
            .into_owned()
    }

    /// Point a desk's backups at a folder (made if missing), or turn them
    /// off with `None`. Refuses a folder inside app data or inside any
    /// desk's folder — a backup there would be zipped into the next one,
    /// and a local desk's reconciler would meet it as a stray file.
    pub fn set_backup_target(&self, desk_id: &str, target: Option<BackupTarget>) -> Result<(), BoxError> {
        let mut config = self.load_backup_config();
        match target {
            None => {
                config.desks.remove(desk_id);
            }
            Some(target) => {
                let path = PathBuf::from(&target.path);
                if !path.is_absolute() {
                    return Err("the backup folder must be an absolute path".into());
                }
                fs::create_dir_all(&path)?;
                let folder = path.canonicalize()?;
                let inside = |other: PathBuf| other.canonicalize().map(|o| folder.starts_with(o)).unwrap_or(false);
                if inside(self.data_dir()) {
                    return Err("backups can't be kept inside Hush's own data folder".into());
                }
                if inside(self.desk_dir(desk_id)) {
                    return Err("backups can't be kept inside the desk they back up".into());
                }
                // Nor inside another local desk: that desk's own backups
                // would carry these zips, and its reconciler meet them.
                if crate::desk_roots::load_roots(&self.desks_dir).values().any(|root| inside(PathBuf::from(root))) {
                    return Err("backups can't be kept inside a desk's folder".into());
                }
                config.last_folder = Some(target.path.clone());
                config.desks.insert(desk_id.to_string(), target);
            }
        }
        self.save_backup_config(&config)
    }

    /// This desk's backups in `folder`, as (filename, epoch), oldest first.
    fn backup_files(&self, folder: &Path, desk_id: &str) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(folder) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(at) = parse_backup_name(&name, desk_id) {
                    out.push((name, at));
                }
            }
        }
        out.sort_by_key(|(_, at)| *at);
        out
    }

    pub(crate) fn newest_backup_at(&self, desk_id: &str) -> Option<u64> {
        let target = self.backup_target(desk_id)?;
        self.backup_files(Path::new(&target.path), desk_id).last().map(|(_, at)| *at)
    }

    /// Zip the desk (PDFs left out, their registry entries written in) into
    /// its backup folder, then thin the folder's older backups.
    pub fn backup_desk(&self, desk_id: &str) -> Result<ArchiveInfo, BoxError> {
        let target = self
            .backup_target(desk_id)
            .ok_or("backups aren't turned on for this desk")?;
        let folder = PathBuf::from(&target.path);
        if !folder.is_dir() {
            return Err(format!("the backup folder can't be reached: {}", target.path).into());
        }
        let root = self.desk_dir(desk_id);
        let tree = read_tree(&root).ok_or_else(|| format!("desk {} has no folder to back up", desk_id))?;

        let mut entries = Vec::new();
        walk_all(&root, &root, &mut entries);
        let total: u64 = entries
            .iter()
            .filter(|(rel, _)| !is_pdf(rel))
            .map(|(_, abs)| fs::metadata(abs).map(|m| m.len()).unwrap_or(0))
            .sum();
        if total > MAX_DESK_BYTES {
            return Err(format!(
                "desk folder is {} MB — past the {} MB backup limit",
                total / (1024 * 1024),
                MAX_DESK_BYTES / (1024 * 1024)
            )
            .into());
        }

        let name = crate::desk_recovery::desk_display_name(&root);
        let was_local = crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some();
        // Stamps double as the ordering, so keep them strictly increasing.
        let mut at = now_secs();
        if let Some(newest) = self.backup_files(&folder, desk_id).last().map(|(_, t)| *t) {
            if at <= newest {
                at = newest + 1;
            }
        }
        let file_name = backup_file_name(&name, desk_id, at);
        let path = folder.join(&file_name);

        let pdfs = serde_json::to_vec_pretty(&self.pdf_entries_for(&tree))?;
        let (buf, files) = build_desk_zip_with(
            &root,
            &name,
            desk_id,
            was_local,
            at,
            &is_pdf,
            &[(PDFS_ENTRY.to_string(), pdfs)],
        )?;
        let bytes = buf.len() as u64;
        // Atomic, so a provider syncing the folder never carries a
        // half-written zip under the final name.
        crate::atomic::write_atomic(&path, &buf)?;
        self.prune_backups(&folder, desk_id);

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

    /// `{ format, version, items: { fileId: registryEntry } }` for every
    /// PDF in the tree. A PDF the registry doesn't know still gets an
    /// entry (its name as the title), so a recovery can give it a row.
    fn pdf_entries_for(&self, tree: &TreeNode) -> serde_json::Value {
        let mut pdfs = Vec::new();
        desk_pdfs(tree, &mut pdfs);
        let registry: serde_json::Value = crate::pdfs::PdfManager::new(&self.data_dir())
            .load_registry()
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let mut items = serde_json::Map::new();
        for (fid, name) in pdfs {
            let entry = registry
                .get("items")
                .and_then(|i| i.get(&fid))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "fileId": fid, "title": name }));
            items.insert(fid, entry);
        }
        serde_json::json!({ "format": "hush-backup-pdfs", "version": 1, "items": items })
    }

    fn prune_backups(&self, folder: &Path, desk_id: &str) {
        let mut files = self.backup_files(folder, desk_id);
        files.reverse(); // newest first, as the policy expects
        let secs: Vec<(usize, i64)> = files.iter().enumerate().map(|(i, (_, at))| (i, *at as i64)).collect();
        for idx in crate::snapshots::decay_doomed(&secs, now_secs() as i64) {
            let _ = fs::remove_file(folder.join(&files[idx].0));
        }
    }

    /// This desk's backups, newest first.
    pub fn list_backups(&self, desk_id: &str) -> Vec<ArchiveInfo> {
        let Some(target) = self.backup_target(desk_id) else { return Vec::new() };
        let folder = PathBuf::from(&target.path);
        let mut out: Vec<ArchiveInfo> = self
            .backup_files(&folder, desk_id)
            .into_iter()
            .map(|(file, at)| {
                let path = folder.join(&file);
                let manifest = read_zip_json(&path, "archive.json").unwrap_or_else(|| serde_json::json!({}));
                ArchiveInfo {
                    name: manifest.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled desk").to_string(),
                    desk_id: desk_id.to_string(),
                    archived_at: at,
                    bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    files: manifest.get("files").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                    was_local: manifest.get("wasLocal").and_then(|v| v.as_bool()).unwrap_or(false),
                    path: path.to_string_lossy().into_owned(),
                    file,
                }
            })
            .collect();
        out.reverse();
        out
    }

    /// A backup's path, from a filename that came over IPC: it has to be
    /// a bare name and one of this desk's backups.
    pub(crate) fn backup_path(&self, desk_id: &str, file: &str) -> Result<PathBuf, BoxError> {
        let target = self
            .backup_target(desk_id)
            .ok_or("backups aren't turned on for this desk")?;
        let bare = Path::new(file).file_name().and_then(|s| s.to_str()) == Some(file);
        if !bare || parse_backup_name(file, desk_id).is_none() {
            return Err(format!("not a backup of this desk: {}", file).into());
        }
        Ok(PathBuf::from(target.path).join(file))
    }
}

/// One JSON entry out of a zip, read through the file (the central
/// directory and that entry only — listing never loads a whole backup).
pub(crate) fn read_zip_json(path: &Path, name: &str) -> Option<serde_json::Value> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).ok()?).ok()?;
    let mut raw = String::new();
    zip.by_name(name).ok()?.read_to_string(&mut raw).ok()?;
    serde_json::from_str(&raw).ok()
}

// ===== Scheduler =====

#[derive(Default)]
struct Schedule {
    /// When each desk's folder was last walked for changes.
    scanned: HashMap<String, u64>,
    /// After a failure, when to try that desk again.
    retry_at: HashMap<String, u64>,
}

static SCHEDULE: OnceLock<Mutex<Schedule>> = OnceLock::new();

fn schedule() -> &'static Mutex<Schedule> {
    SCHEDULE.get_or_init(|| Mutex::new(Schedule::default()))
}

/// Start the background backup thread — once per process, from setup.
pub fn start_scheduler(data_dir: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(START_DELAY_SECS));
        loop {
            tick(&data_dir, now_secs());
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

/// The newest modification time of anything in the desk folder.
fn newest_mtime(root: &Path) -> u64 {
    let mut entries = Vec::new();
    walk_all(root, root, &mut entries);
    entries
        .iter()
        .filter_map(|(_, abs)| fs::metadata(abs).ok()?.modified().ok())
        .filter_map(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .max()
        .unwrap_or(0)
}

/// Whether a desk is due: no backup yet, or the newest is an hour old and
/// the desk changed after it.
pub(crate) fn backup_due(store: &DeskStore, desk_id: &str, now: u64) -> bool {
    let Some(newest) = store.newest_backup_at(desk_id) else { return true };
    if now.saturating_sub(newest) < BACKUP_INTERVAL_SECS {
        return false;
    }
    if crate::desk_recovery::edited_at(desk_id).is_some_and(|t| t > newest) {
        return true;
    }
    {
        let mut sched = schedule().lock().unwrap();
        let last = sched.scanned.get(desk_id).copied().unwrap_or(0);
        if now.saturating_sub(last) < BACKUP_INTERVAL_SECS {
            return false;
        }
        sched.scanned.insert(desk_id.to_string(), now);
    }
    newest_mtime(&store.desk_dir(desk_id)) > newest
}

/// One scheduler pass. Separate from the loop so tests can drive it.
pub(crate) fn tick(data_dir: &Path, now: u64) {
    let store = DeskStore::new(data_dir);
    for (desk_id, target) in store.backup_targets() {
        // A desk that's gone (archived, or a local folder not mounted) or
        // a backup folder that isn't there (an unplugged drive) waits.
        if !store.desk_dir(&desk_id).join(".hush").join("tree.json").exists() || !Path::new(&target.path).is_dir() {
            continue;
        }
        if schedule().lock().unwrap().retry_at.get(&desk_id).is_some_and(|t| now < *t) {
            continue;
        }
        if !backup_due(&store, &desk_id, now) {
            continue;
        }
        match store.backup_desk(&desk_id) {
            Ok(info) => crate::activity_log::note(
                "desks",
                "info",
                format!("Backed up \"{}\" ({} files, {} KB) to {}", info.name, info.files, info.bytes / 1024, info.path),
            ),
            Err(e) => {
                schedule().lock().unwrap().retry_at.insert(desk_id.clone(), now + BACKUP_INTERVAL_SECS);
                crate::activity_log::note("desks", "warn", format!("Backup failed for desk {}: {}", desk_id, e));
            }
        }
    }
}

#[cfg(test)]
#[path = "desk_backup_tests.rs"]
mod tests;
