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
) -> Result<LocalSyncFolder, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_dir() {
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
    };
    {
        let mut settings = state.settings.lock().unwrap();
        settings.local_sync_folders.push(folder.clone());
        settings.save().map_err(|e| e.to_string())?;
    }
    state.local_sync_manager.watch(app, &folder)?;
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
