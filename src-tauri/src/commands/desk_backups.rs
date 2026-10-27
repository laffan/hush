//! Desk backup commands — the surface for the New desk prompt's "Use
//! Backups", the Backup Desk Now / Recover Desk Version palette entries
//! and the version browser (see desk_backup.rs, desk_backup_restore.rs).
//! Zipping and unpacking a desk can take seconds, so those run off the
//! main thread.

use std::collections::HashMap;

use crate::desk_archive::ArchiveInfo;
use crate::desk_backup::BackupTarget;
use crate::desk_backup_restore::{BackupContents, RestoredBackup};
use crate::desk_store::DeskStore;

fn store() -> DeskStore {
    DeskStore::new(&crate::get_data_dir())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// deskId → backup folder, for every desk with backups on.
#[tauri::command]
pub fn desk_backup_targets() -> HashMap<String, BackupTarget> {
    store().backup_targets()
}

#[tauri::command]
pub fn desk_backup_default_folder() -> String {
    store().default_backup_folder()
}

/// Turn a desk's backups on (into `path`) or off (`path: null`).
#[tauri::command]
pub fn desk_backup_set_target(
    desk_id: String,
    path: Option<String>,
    bookmark: Option<String>,
) -> Result<(), String> {
    let target = path.map(|path| BackupTarget { path, bookmark });
    store().set_backup_target(&desk_id, target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn desk_backup_now(desk_id: String) -> Result<ArchiveInfo, String> {
    blocking(move || store().backup_desk(&desk_id).map_err(|e| e.to_string())).await
}

/// This desk's backups, newest first.
#[tauri::command]
pub async fn desk_backup_list(desk_id: String) -> Result<Vec<ArchiveInfo>, String> {
    blocking(move || Ok(store().list_backups(&desk_id))).await
}

#[tauri::command]
pub async fn desk_backup_contents(desk_id: String, file: String) -> Result<BackupContents, String> {
    blocking(move || store().backup_contents(&desk_id, &file).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn desk_backup_read_file(desk_id: String, file: String, file_id: String) -> Result<String, String> {
    blocking(move || store().backup_read_file(&desk_id, &file, &file_id).map_err(|e| e.to_string())).await
}

/// Build a new internal desk from a backup. The live desk is untouched.
#[tauri::command]
pub async fn desk_backup_restore(
    desk_id: String,
    file: String,
    new_name: String,
    reconnect_pdfs: bool,
) -> Result<RestoredBackup, String> {
    blocking(move || {
        store()
            .restore_backup(&desk_id, &file, &new_name, reconnect_pdfs)
            .map_err(|e| e.to_string())
    })
    .await
}
