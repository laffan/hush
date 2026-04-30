use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic::write_atomic_str;
use crate::settings::SyncFolder;
use crate::sync_db::{migrate_from_json, SyncDb};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncWriteResult {
    pub written: bool,
    pub external_is_newer: bool,
    pub external_content: Option<String>,
    pub external_modified: Option<i64>,
}

/// Per-file sync mapping. Persisted in `sync.db` via `SyncDb`. The struct
/// is kept here (rather than in `sync_db`) because it's also part of the
/// public Tauri command surface — both worlds deserialize it.
///
/// `remote_id` and `last_known_rev` are populated by Stage 3+ (Dropbox
/// cursor + echo suppression). For now they default to empty strings;
/// legacy entries migrated from `sync_map.json` start that way.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFileInfo {
    pub internal_id: String,
    pub sync_folder_id: String,
    pub relative_path: String,
    pub last_synced_hash: String,
    #[serde(default)]
    pub last_synced_at: i64,
    #[serde(default)]
    pub remote_id: String,
    #[serde(default)]
    pub last_known_rev: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    pub relative_path: String,
    pub name: String,
    pub content: String,
    pub is_directory: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChange {
    pub internal_id: String,
    pub relative_path: String,
    pub external_content: String,
    pub internal_content: String,
    pub external_modified: i64,
    pub internal_modified: i64,
}

/// One row in the durable operation log. Mutations from the UI (rename,
/// delete, upload, etc.) are appended here before being executed against
/// Dropbox; the JS-side drain worker consumes them in insertion order.
///
/// `path` is the operation's primary target — old path for renames,
/// target path for everything else. `new_path` is set only for renames.
/// Content for upload ops is *not* stored here; it's re-read from the
/// FileManager at drain time so the latest user edit always wins.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingOp {
    #[serde(default)]
    pub id: i64,
    pub kind: String,
    #[serde(default)]
    pub internal_id: Option<String>,
    #[serde(default)]
    pub remote_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub new_path: Option<String>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub attempts: i32,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolderDiff {
    pub new_files: Vec<ImportEntry>,
    pub deleted_file_ids: Vec<String>,
    pub disk_directories: Vec<String>,
}

pub struct SyncManager {
    db: SyncDb,
}

impl SyncManager {
    pub fn new(data_dir: &Path) -> Self {
        let db = SyncDb::new(data_dir);

        // One-shot migration from the legacy JSON map. After it runs the
        // file is renamed to `sync_map.json.bak` so we don't re-run.
        let json_path = data_dir.join("sync_map.json");
        if json_path.exists() {
            match migrate_from_json(&db, &json_path) {
                Ok((migrated, orphaned)) => {
                    eprintln!(
                        "sync: migrated {} entries from sync_map.json ({} orphans recorded)",
                        migrated, orphaned
                    );
                }
                Err(e) => {
                    eprintln!("sync: migration from sync_map.json failed: {}", e);
                }
            }
        }

        Self { db }
    }

    // ===== Folder scanning (filesystem helpers, unchanged) =====

    pub fn scan_folder(folder_path: &str) -> Result<Vec<ImportEntry>, Box<dyn std::error::Error>> {
        let root = PathBuf::from(folder_path);
        if !root.is_dir() {
            return Err(format!("Not a directory: {}", folder_path).into());
        }
        let mut entries = Vec::new();
        Self::scan_recursive(&root, &root, &mut entries)?;
        entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(entries)
    }

    fn scan_recursive(
        root: &Path,
        dir: &Path,
        entries: &mut Vec<ImportEntry>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            if let Some(name) = path.file_name() {
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
            }

            if path.is_dir() {
                entries.push(ImportEntry {
                    relative_path: relative.clone(),
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    content: String::new(),
                    is_directory: true,
                });
                Self::scan_recursive(root, &path, entries)?;
            } else {
                let ext = path.extension().and_then(|e| e.to_str());
                if ext == Some("md") || ext == Some("hushnote") {
                    let content = if ext == Some("md") {
                        fs::read_to_string(&path).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let name = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    entries.push(ImportEntry {
                        relative_path: relative,
                        name,
                        content,
                        is_directory: false,
                    });
                }
            }
        }
        Ok(())
    }

    // ===== Map operations (now SQLite-backed) =====

    pub fn register_file(
        &mut self,
        internal_id: &str,
        sync_folder_id: &str,
        relative_path: &str,
        content: &str,
    ) {
        let info = SyncedFileInfo {
            internal_id: internal_id.to_string(),
            sync_folder_id: sync_folder_id.to_string(),
            relative_path: relative_path.to_string(),
            last_synced_hash: Self::hash_content(content),
            last_synced_at: now_secs(),
            remote_id: String::new(),
            last_known_rev: String::new(),
        };
        if let Err(e) = self.db.upsert_file(&info) {
            eprintln!("sync: register_file failed: {}", e);
        }
    }

    pub fn unregister_file(&mut self, internal_id: &str) {
        if let Err(e) = self.db.delete(internal_id) {
            eprintln!("sync: unregister_file failed: {}", e);
        }
    }

    pub fn unregister_folder(&mut self, sync_folder_id: &str) {
        if let Err(e) = self.db.delete_folder(sync_folder_id) {
            eprintln!("sync: unregister_folder failed: {}", e);
        }
    }

    pub fn update_hash(&mut self, internal_id: &str, content: &str, synced_at: Option<i64>) {
        let hash = Self::hash_content(content);
        let ts = synced_at.unwrap_or_else(now_secs);
        if let Err(e) = self.db.update_hash(internal_id, &hash, ts) {
            eprintln!("sync: update_hash failed: {}", e);
        }
    }

    pub fn get_folder_files(&self, sync_folder_id: &str) -> Vec<SyncedFileInfo> {
        self.db.list_folder(sync_folder_id).unwrap_or_default()
    }

    pub fn get_file_info(&self, internal_id: &str) -> Option<SyncedFileInfo> {
        self.db.get(internal_id).ok().flatten()
    }

    // ===== Filesystem write/read =====

    pub fn write_external(
        folder_path: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let path = PathBuf::from(folder_path).join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic_str(&path, content)?;
        Ok(())
    }

    /// Write only if the external file hasn't been modified since the last
    /// sync. The mtime check is a coarse safety net — Stage 3+ replaces
    /// this with rev-based echo suppression.
    pub fn write_external_if_current(
        &self,
        folder_path: &str,
        relative_path: &str,
        content: &str,
        internal_id: &str,
    ) -> Result<SyncWriteResult, Box<dyn std::error::Error>> {
        let path = PathBuf::from(folder_path).join(relative_path);
        if path.exists() {
            let last_synced_at = self
                .db
                .get(internal_id)
                .ok()
                .flatten()
                .map(|info| info.last_synced_at)
                .unwrap_or(0);
            let external_mtime = fs::metadata(&path)
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64
                })
                .unwrap_or(0);
            if external_mtime > last_synced_at {
                let external_content = fs::read_to_string(&path).ok();
                return Ok(SyncWriteResult {
                    written: false,
                    external_is_newer: true,
                    external_content,
                    external_modified: Some(external_mtime),
                });
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic_str(&path, content)?;
        Ok(SyncWriteResult {
            written: true,
            external_is_newer: false,
            external_content: None,
            external_modified: None,
        })
    }

    pub fn read_external(
        folder_path: &str,
        relative_path: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let path = PathBuf::from(folder_path).join(relative_path);
        Ok(fs::read_to_string(&path)?)
    }

    pub fn check_external_change(
        &self,
        folder: &SyncFolder,
        internal_id: &str,
    ) -> Option<String> {
        let info = self.db.get(internal_id).ok().flatten()?;
        let path = PathBuf::from(&folder.path).join(&info.relative_path);
        let content = fs::read_to_string(&path).ok()?;
        let hash = Self::hash_content(&content);
        if hash != info.last_synced_hash {
            Some(content)
        } else {
            None
        }
    }

    pub fn rename_external_file(
        &mut self,
        folder_path: &str,
        old_relative: &str,
        new_relative: &str,
        internal_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let old_full = PathBuf::from(folder_path).join(old_relative);
        let new_full = PathBuf::from(folder_path).join(new_relative);
        if old_full.exists() {
            if let Some(parent) = new_full.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&old_full, &new_full)?;
        }
        self.db.update_path(internal_id, new_relative)?;
        Ok(())
    }

    pub fn delete_external_file(
        &mut self,
        folder_path: &str,
        internal_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(info) = self.db.get(internal_id)? {
            let full = PathBuf::from(folder_path).join(&info.relative_path);
            if full.exists() {
                fs::remove_file(&full)?;
            }
        }
        self.db.delete(internal_id)?;
        Ok(())
    }

    pub fn create_external_directory(
        folder_path: &str,
        relative_path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let full = PathBuf::from(folder_path).join(relative_path);
        fs::create_dir_all(&full)?;
        Ok(())
    }

    pub fn rename_external_directory(
        &mut self,
        folder_path: &str,
        old_relative: &str,
        new_relative: &str,
        sync_folder_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let old_full = PathBuf::from(folder_path).join(old_relative);
        let new_full = PathBuf::from(folder_path).join(new_relative);
        if old_full.exists() {
            if let Some(parent) = new_full.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&old_full, &new_full)?;
        }
        let old_prefix = format!("{}/", old_relative.trim_end_matches('/'));
        let new_prefix = format!("{}/", new_relative.trim_end_matches('/'));
        self.db
            .rename_prefix(sync_folder_id, &old_prefix, &new_prefix)?;
        Ok(())
    }

    pub fn delete_external_directory(
        &mut self,
        folder_path: &str,
        relative_path: &str,
        sync_folder_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let full = PathBuf::from(folder_path).join(relative_path);
        if full.exists() {
            fs::remove_dir_all(&full)?;
        }
        let prefix = format!("{}/", relative_path.trim_end_matches('/'));
        self.db.delete_prefix(sync_folder_id, &prefix)?;
        Ok(())
    }

    pub fn create_external_file(
        &mut self,
        folder_path: &str,
        relative_path: &str,
        content: &str,
        internal_id: &str,
        sync_folder_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        Self::write_external(folder_path, relative_path, content)?;
        self.register_file(internal_id, sync_folder_id, relative_path, content);
        Ok(())
    }

    pub fn write_project_json(
        folder_path: &str,
        relative_path: &str,
        doc_names: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = PathBuf::from(folder_path).join(relative_path);
        fs::create_dir_all(&dir)?;
        let json_path = dir.join(".hush-project.json");
        let data = serde_json::json!({ "ordering": doc_names });
        write_atomic_str(&json_path, &serde_json::to_string_pretty(&data)?)?;
        Ok(())
    }

    pub fn check_all_external_changes(&self, folder: &SyncFolder) -> Vec<ExternalChange> {
        let mut changes = Vec::new();
        let entries = match self.db.list_folder(&folder.id) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("sync: list_folder failed: {}", e);
                return changes;
            }
        };
        for info in entries {
            let path = PathBuf::from(&folder.path).join(&info.relative_path);
            if let Ok(external_content) = fs::read_to_string(&path) {
                let hash = Self::hash_content(&external_content);
                if hash != info.last_synced_hash {
                    let external_modified = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs() as i64
                        })
                        .unwrap_or(0);
                    changes.push(ExternalChange {
                        internal_id: info.internal_id.clone(),
                        relative_path: info.relative_path.clone(),
                        external_content,
                        internal_content: String::new(),
                        external_modified,
                        internal_modified: 0,
                    });
                }
            }
        }
        changes
    }

    pub fn diff_sync_folder(&self, folder: &SyncFolder) -> SyncFolderDiff {
        use std::collections::HashSet;

        let registered_entries = self.db.list_folder(&folder.id).unwrap_or_default();
        let registered: HashSet<String> = registered_entries
            .iter()
            .map(|info| info.relative_path.clone())
            .collect();

        let mut disk_files: HashSet<String> = HashSet::new();
        let mut disk_directories: Vec<String> = Vec::new();
        let mut new_files = Vec::new();

        if let Ok(entries) = Self::scan_folder(&folder.path) {
            for entry in entries {
                if entry.is_directory {
                    disk_directories.push(entry.relative_path.clone());
                } else {
                    disk_files.insert(entry.relative_path.clone());
                    if !registered.contains(&entry.relative_path) {
                        new_files.push(entry);
                    }
                }
            }
        }

        let deleted_file_ids: Vec<String> = registered_entries
            .iter()
            .filter(|info| !disk_files.contains(&info.relative_path))
            .map(|info| info.internal_id.clone())
            .collect();

        SyncFolderDiff {
            new_files,
            deleted_file_ids,
            disk_directories,
        }
    }

    // ===== Hashing helpers =====

    fn hash_content(content: &str) -> String {
        Self::hash_bytes(content.as_bytes())
    }

    pub fn hash_bytes(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    // ===== Image-specific helpers =====

    pub fn register_image(
        &mut self,
        internal_id: &str,
        sync_folder_id: &str,
        relative_path: &str,
        bytes: &[u8],
    ) {
        let info = SyncedFileInfo {
            internal_id: internal_id.to_string(),
            sync_folder_id: sync_folder_id.to_string(),
            relative_path: relative_path.to_string(),
            last_synced_hash: Self::hash_bytes(bytes),
            last_synced_at: now_secs(),
            remote_id: String::new(),
            last_known_rev: String::new(),
        };
        if let Err(e) = self.db.upsert_file(&info) {
            eprintln!("sync: register_image failed: {}", e);
        }
    }

    pub fn update_image_hash(&mut self, internal_id: &str, bytes: &[u8]) {
        let hash = Self::hash_bytes(bytes);
        if let Err(e) = self.db.update_hash(internal_id, &hash, now_secs()) {
            eprintln!("sync: update_image_hash failed: {}", e);
        }
    }

    // ===== Operation log =====

    /// Append a pending op. The drain worker (JS-side) picks these up in
    /// insertion order and executes them against Dropbox.
    pub fn enqueue_op(
        &self,
        kind: &str,
        internal_id: Option<String>,
        remote_id: Option<String>,
        path: &str,
        new_path: Option<String>,
        payload: Option<String>,
    ) -> Result<i64, rusqlite::Error> {
        let op = PendingOp {
            id: 0,
            kind: kind.to_string(),
            internal_id,
            remote_id,
            path: path.to_string(),
            new_path,
            payload,
            created_at: now_secs(),
            attempts: 0,
            last_error: None,
        };
        self.db.enqueue_op(&op)
    }

    pub fn peek_ops(&self, limit: usize) -> Vec<PendingOp> {
        self.db.peek_ops(limit).unwrap_or_default()
    }

    pub fn op_succeeded(&self, id: i64) {
        if let Err(e) = self.db.op_succeeded(id) {
            eprintln!("sync: op_succeeded({}) failed: {}", id, e);
        }
    }

    pub fn op_failed(&self, id: i64, error: &str) {
        if let Err(e) = self.db.op_failed(id, error) {
            eprintln!("sync: op_failed({}) failed: {}", id, e);
        }
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
