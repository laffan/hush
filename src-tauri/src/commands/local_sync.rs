use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::local_sync::{self, LocalSyncEntry, LocalSyncFolder};
use crate::settings::AppSettings;
use crate::AppState;

fn find_local_sync_folder(
    settings: &AppSettings,
    id: &str,
) -> Result<LocalSyncFolder, String> {
    settings
        .local_sync_folders
        .iter()
        .find(|f| f.id == id)
        .cloned()
        .ok_or_else(|| format!("Local Sync folder not found: {}", id))
}

#[tauri::command]
pub fn local_sync_add(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    name: Option<String>,
    desk_id: Option<String>,
    bookmark: Option<String>,
) -> Result<LocalSyncFolder, String> {
    let path_buf = PathBuf::from(&path);
    // iOS mounts carry a security-scoped bookmark; the JS layer has
    // already resolved it through the icloud-folder plugin (access is
    // held) before calling us, so the std::fs `is_dir` check is skipped
    // for those — the path may not be directly reachable here.
    if bookmark.is_none() && !path_buf.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let final_name = name.unwrap_or_else(|| {
        path_buf
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });
    let folder = LocalSyncFolder {
        id: format!("ls_{}", uuid_like()),
        path,
        name: final_name,
        added_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        desk_id,
        bookmark,
    };
    {
        let mut settings = state.settings.lock().unwrap();
        settings.local_sync_folders.push(folder.clone());
        settings.save().map_err(|e| e.to_string())?;
    }
    // The notify-crate watcher is macOS/desktop-only; iOS mounts (those
    // with a bookmark) have no live external-change watching.
    if folder.bookmark.is_none() {
        state.local_sync_manager.watch(app, &folder)?;
    } else {
        let _ = app;
    }
    Ok(folder)
}

#[tauri::command]
pub fn local_sync_remove(state: State<AppState>, id: String) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().unwrap();
        settings.local_sync_folders.retain(|f| f.id != id);
        settings.save().map_err(|e| e.to_string())?;
    }
    state.local_sync_manager.unwatch(&id);
    Ok(())
}

#[tauri::command]
pub fn local_sync_list(state: State<AppState>) -> Vec<LocalSyncFolder> {
    state.settings.lock().unwrap().local_sync_folders.clone()
}

#[tauri::command]
pub fn local_sync_read_dir(
    state: State<AppState>,
    id: String,
    rel_path: Option<String>,
) -> Result<Vec<LocalSyncEntry>, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::list_dir(&folder, &rel_path.unwrap_or_default())
}

#[tauri::command]
pub fn local_sync_read_file(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::read_file(&folder, &rel_path)
}

#[tauri::command]
pub fn local_sync_write_file(
    state: State<AppState>,
    id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::write_file(&folder, &rel_path, &content)
}

/// Read raw bytes from a Local Sync file. Used to fetch image binaries
/// that live next to a `.md` so they can be rendered inline.
#[tauri::command]
pub fn local_sync_read_file_bytes(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<Vec<u8>, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::read_file_bytes(&folder, &rel_path)
}

/// Write raw bytes (e.g. a dropped image) into a Local Sync folder
/// auto-suffixing the name on collision. Returns the actual relative
/// path written so the caller can build the right markdown ref.
#[tauri::command]
pub fn local_sync_write_file_bytes(
    state: State<AppState>,
    id: String,
    rel_path: String,
    bytes: Vec<u8>,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    if overwrite.unwrap_or(false) {
        // Overwrite the exact path (notebook autosave) — keep the rel path.
        local_sync::write_file_bytes_exact(&folder, &rel_path, &bytes)?;
        Ok(rel_path)
    } else {
        local_sync::write_file_bytes_unique(&folder, &rel_path, &bytes)
    }
}

/// Create a new text file (doc / stack envelope) inside a mount.
#[tauri::command]
pub fn local_sync_create_file(
    state: State<AppState>,
    id: String,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::create_file_unique(&folder, &rel_path, &content)
}

/// Create a new directory inside a mount.
#[tauri::command]
pub fn local_sync_create_dir(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::create_dir_unique(&folder, &rel_path)
}

/// Rename a file or directory in place. Returns the new relative path.
#[tauri::command]
pub fn local_sync_rename(
    state: State<AppState>,
    id: String,
    rel_path: String,
    new_name: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::rename_entry(&folder, &rel_path, &new_name)
}

/// Delete a directory only if nothing but ignorable junk remains inside.
/// Returns true when removed. Used after moving a folder's contents into
/// the Hush tree so files the listing filter hid are never destroyed.
#[tauri::command]
pub fn local_sync_delete_dir_if_clean(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<bool, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::delete_dir_if_clean(&folder, &rel_path)
}

/// Permanently delete a file or directory (recursive).
#[tauri::command]
pub fn local_sync_delete(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<(), String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::delete_entry(&folder, &rel_path)
}

/// Move an entry into another directory within the same mount.
#[tauri::command]
pub fn local_sync_move(
    state: State<AppState>,
    id: String,
    src_rel: String,
    dst_dir_rel: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::move_entry(&folder, &src_rel, &dst_dir_rel)
}

/// Duplicate a file or directory (within the same parent dir).
#[tauri::command]
pub fn local_sync_copy(
    state: State<AppState>,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    let folder = find_local_sync_folder(&state.settings.lock().unwrap(), &id)?;
    local_sync::copy_entry(&folder, &rel_path)
}

fn uuid_like() -> String {
    // The app doesn't pull in `uuid`; a timestamp+rand string is good
    // enough for local-only ids that never leave disk.
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}
