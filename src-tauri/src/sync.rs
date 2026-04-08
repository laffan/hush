use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::SyncFolder;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncWriteResult {
    pub written: bool,
    pub external_is_newer: bool,
    pub external_content: Option<String>,
    pub external_modified: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFileInfo {
    pub internal_id: String,
    pub sync_folder_id: String,
    pub relative_path: String,
    pub last_synced_hash: String,
    #[serde(default)]
    pub last_synced_at: i64, // Unix timestamp of last successful sync
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
    pub external_modified: i64,  // Unix timestamp of external file
    pub internal_modified: i64,  // Unix timestamp of internal file
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolderDiff {
    pub new_files: Vec<ImportEntry>,
    pub deleted_file_ids: Vec<String>, // internal_ids of files no longer on disk
}

pub struct SyncManager {
    sync_data_path: PathBuf,
    file_map: HashMap<String, SyncedFileInfo>, // internal_id -> SyncedFileInfo
}

impl SyncManager {
    pub fn new(data_dir: &Path) -> Self {
        let sync_data_path = data_dir.join("sync_map.json");
        let file_map = Self::load_map(&sync_data_path);
        Self {
            sync_data_path,
            file_map,
        }
    }

    fn load_map(path: &Path) -> HashMap<String, SyncedFileInfo> {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(map) = serde_json::from_str(&content) {
                    return map;
                }
            }
        }
        HashMap::new()
    }

    fn save_map(&self) {
        if let Ok(content) = serde_json::to_string_pretty(&self.file_map) {
            let _ = fs::write(&self.sync_data_path, content);
        }
    }

    /// Scan a folder for .md files, returning entries to import.
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

            // Skip hidden files/dirs
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
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let content = fs::read_to_string(&path).unwrap_or_default();
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
        Ok(())
    }

    /// Register a synced file mapping.
    pub fn register_file(
        &mut self,
        internal_id: &str,
        sync_folder_id: &str,
        relative_path: &str,
        content: &str,
    ) {
        let hash = Self::hash_content(content);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.file_map.insert(
            internal_id.to_string(),
            SyncedFileInfo {
                internal_id: internal_id.to_string(),
                sync_folder_id: sync_folder_id.to_string(),
                relative_path: relative_path.to_string(),
                last_synced_hash: hash,
                last_synced_at: now,
            },
        );
        self.save_map();
    }

    /// Remove a synced file mapping.
    pub fn unregister_file(&mut self, internal_id: &str) {
        self.file_map.remove(internal_id);
        self.save_map();
    }

    /// Remove all mappings for a sync folder.
    pub fn unregister_folder(&mut self, sync_folder_id: &str) {
        self.file_map
            .retain(|_, info| info.sync_folder_id != sync_folder_id);
        self.save_map();
    }

    /// Write content to external file.
    pub fn write_external(
        folder_path: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let path = PathBuf::from(folder_path).join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        Ok(())
    }

    /// Write content to external file only if the external file hasn't been
    /// modified since the last sync. Returns a result indicating what happened.
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
                .file_map
                .get(internal_id)
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
                // External file is newer — don't overwrite
                let external_content = fs::read_to_string(&path).ok();
                return Ok(SyncWriteResult {
                    written: false,
                    external_is_newer: true,
                    external_content,
                    external_modified: Some(external_mtime),
                });
            }
        }
        // Safe to write — external hasn't changed since last sync
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        Ok(SyncWriteResult {
            written: true,
            external_is_newer: false,
            external_content: None,
            external_modified: None,
        })
    }

    /// Read external file content.
    pub fn read_external(
        folder_path: &str,
        relative_path: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let path = PathBuf::from(folder_path).join(relative_path);
        Ok(fs::read_to_string(&path)?)
    }

    /// Update the hash after a successful sync.
    pub fn update_hash(&mut self, internal_id: &str, content: &str) {
        if let Some(info) = self.file_map.get_mut(internal_id) {
            info.last_synced_hash = Self::hash_content(content);
            info.last_synced_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            self.save_map();
        }
    }

    /// Get all synced file infos for a given sync folder.
    pub fn get_folder_files(&self, sync_folder_id: &str) -> Vec<SyncedFileInfo> {
        self.file_map
            .values()
            .filter(|info| info.sync_folder_id == sync_folder_id)
            .cloned()
            .collect()
    }

    /// Get sync info for a specific internal file.
    pub fn get_file_info(&self, internal_id: &str) -> Option<&SyncedFileInfo> {
        self.file_map.get(internal_id)
    }

    /// Check if an external file has changed since last sync.
    pub fn check_external_change(
        &self,
        folder: &SyncFolder,
        internal_id: &str,
    ) -> Option<String> {
        let info = self.file_map.get(internal_id)?;
        let path = PathBuf::from(&folder.path).join(&info.relative_path);
        let content = fs::read_to_string(&path).ok()?;
        let hash = Self::hash_content(&content);
        if hash != info.last_synced_hash {
            Some(content)
        } else {
            None
        }
    }

    /// Rename an external file and update the mapping's relative path.
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
        if let Some(info) = self.file_map.get_mut(internal_id) {
            info.relative_path = new_relative.to_string();
            self.save_map();
        }
        Ok(())
    }

    /// Delete an external file and remove its sync mapping.
    pub fn delete_external_file(
        &mut self,
        folder_path: &str,
        internal_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(info) = self.file_map.get(internal_id) {
            let full = PathBuf::from(folder_path).join(&info.relative_path);
            if full.exists() {
                fs::remove_file(&full)?;
            }
        }
        self.file_map.remove(internal_id);
        self.save_map();
        Ok(())
    }

    /// Create an external directory.
    pub fn create_external_directory(
        folder_path: &str,
        relative_path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let full = PathBuf::from(folder_path).join(relative_path);
        fs::create_dir_all(&full)?;
        Ok(())
    }

    /// Rename an external directory and update all child mappings.
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
        // Update all mappings whose relative_path starts with old_relative/
        let old_prefix = format!("{}/", old_relative.trim_end_matches('/'));
        let new_prefix = format!("{}/", new_relative.trim_end_matches('/'));
        for info in self.file_map.values_mut() {
            if info.sync_folder_id == sync_folder_id
                && info.relative_path.starts_with(&old_prefix)
            {
                info.relative_path = format!(
                    "{}{}",
                    new_prefix,
                    &info.relative_path[old_prefix.len()..]
                );
            }
        }
        self.save_map();
        Ok(())
    }

    /// Delete an external directory and all its contents.
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
        // Remove all mappings for files inside this directory
        let prefix = format!("{}/", relative_path.trim_end_matches('/'));
        self.file_map.retain(|_, info| {
            !(info.sync_folder_id == sync_folder_id
                && info.relative_path.starts_with(&prefix))
        });
        self.save_map();
        Ok(())
    }

    /// Create an external file and register it.
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

    /// Write a project ordering JSON file alongside the project directory.
    pub fn write_project_json(
        folder_path: &str,
        relative_path: &str,
        doc_names: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = PathBuf::from(folder_path).join(relative_path);
        fs::create_dir_all(&dir)?;
        let json_path = dir.join(".hush-project.json");
        let data = serde_json::json!({ "ordering": doc_names });
        fs::write(&json_path, serde_json::to_string_pretty(&data)?)?;
        Ok(())
    }

    /// Check all files in a sync folder for external changes.
    pub fn check_all_external_changes(
        &self,
        folder: &SyncFolder,
    ) -> Vec<ExternalChange> {
        let mut changes = Vec::new();
        for info in self.file_map.values() {
            if info.sync_folder_id != folder.id {
                continue;
            }
            let path = PathBuf::from(&folder.path).join(&info.relative_path);
            if let Ok(external_content) = fs::read_to_string(&path) {
                let hash = Self::hash_content(&external_content);
                if hash != info.last_synced_hash {
                    // Get external file modification time
                    let external_modified = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                        .unwrap_or(0);
                    changes.push(ExternalChange {
                        internal_id: info.internal_id.clone(),
                        relative_path: info.relative_path.clone(),
                        external_content,
                        internal_content: String::new(), // filled by caller
                        external_modified,
                        internal_modified: 0, // filled by caller
                    });
                }
            }
        }
        changes
    }

    /// Compare the filesystem contents of a local sync folder against the
    /// sync map. Returns new files (on disk but not registered) and deleted
    /// files (registered but no longer on disk).
    pub fn diff_sync_folder(&self, folder: &SyncFolder) -> SyncFolderDiff {
        use std::collections::HashSet;

        // Collect all relative paths currently registered for this folder
        let registered: HashSet<String> = self
            .file_map
            .values()
            .filter(|info| info.sync_folder_id == folder.id)
            .map(|info| info.relative_path.clone())
            .collect();

        let mut disk_files: HashSet<String> = HashSet::new();
        let mut new_files = Vec::new();

        if let Ok(entries) = Self::scan_folder(&folder.path) {
            for entry in entries {
                if !entry.is_directory {
                    disk_files.insert(entry.relative_path.clone());
                    if !registered.contains(&entry.relative_path) {
                        new_files.push(entry);
                    }
                }
            }
        }

        // Find registered files that are no longer on disk
        let deleted_file_ids: Vec<String> = self
            .file_map
            .values()
            .filter(|info| {
                info.sync_folder_id == folder.id && !disk_files.contains(&info.relative_path)
            })
            .map(|info| info.internal_id.clone())
            .collect();

        SyncFolderDiff {
            new_files,
            deleted_file_ids,
        }
    }

    fn hash_content(content: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}
