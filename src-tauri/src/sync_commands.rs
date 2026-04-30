use tauri::State;

use crate::AppState;
use crate::sync::{SyncManager, SyncWriteResult, SyncFolderDiff, ImportEntry, SyncedFileInfo, ExternalChange};

// ===== Dropbox OAuth =====

#[tauri::command]
pub async fn exchange_dropbox_token(
    state: State<'_, AppState>,
    code: String,
    code_verifier: String,
    redirect_uri: String,
    app_key: String,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.dropboxapi.com/oauth2/token")
        .form(&[
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", code_verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", app_key.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {}", body));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // Store tokens in settings
    {
        let mut settings = state.settings.lock().unwrap();
        if let Some(at) = json.get("access_token").and_then(|v| v.as_str()) {
            settings.dropbox_access_token = Some(at.to_string());
        }
        if let Some(rt) = json.get("refresh_token").and_then(|v| v.as_str()) {
            settings.dropbox_refresh_token = Some(rt.to_string());
        }
        settings.dropbox_enabled = true;
        let _ = settings.save();
    }

    Ok(json)
}

#[tauri::command]
pub async fn refresh_dropbox_token(
    state: State<'_, AppState>,
    app_key: String,
) -> Result<String, String> {
    let refresh_token = {
        let settings = state.settings.lock().unwrap();
        settings.dropbox_refresh_token.clone()
            .ok_or("No refresh token stored")?
    };

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.dropboxapi.com/oauth2/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", app_key.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed: {}", body));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let new_token = json.get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("No access_token in response")?
        .to_string();

    // Update stored access token
    {
        let mut settings = state.settings.lock().unwrap();
        settings.dropbox_access_token = Some(new_token.clone());
        let _ = settings.save();
    }

    Ok(new_token)
}

// ===== Sync Commands =====

#[tauri::command]
pub fn scan_sync_folder(folder_path: String) -> Result<Vec<ImportEntry>, String> {
    SyncManager::scan_folder(&folder_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn register_synced_file(
    state: State<AppState>,
    internal_id: String,
    sync_folder_id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .register_file(&internal_id, &sync_folder_id, &relative_path, &content);
    Ok(())
}

#[tauri::command]
pub fn unregister_sync_folder(
    state: State<AppState>,
    sync_folder_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .unregister_folder(&sync_folder_id);
    Ok(())
}

/// Register an image binary in the sync map. The image's bytes are read
/// from disk (via `ImageManager`) and hashed so future diffs can compare
/// without re-downloading the Dropbox copy. `internal_id` for an image is
/// always its filename — the stable id the rest of the app uses.
#[tauri::command]
pub fn register_synced_image(
    state: State<AppState>,
    filename: String,
    sync_folder_id: String,
    relative_path: String,
) -> Result<(), String> {
    let (bytes, _mime) = state.image_manager.lock().unwrap()
        .load_bytes(&filename)
        .map_err(|e| e.to_string())?;
    state.sync_manager.lock().unwrap()
        .register_image(&filename, &sync_folder_id, &relative_path, &bytes);
    Ok(())
}

/// Refresh the sync hash for an image after a write. Reads bytes from
/// disk so the JS side doesn't have to ferry them across the IPC.
#[tauri::command]
pub fn update_sync_image_hash(
    state: State<AppState>,
    filename: String,
) -> Result<(), String> {
    let (bytes, _mime) = state.image_manager.lock().unwrap()
        .load_bytes(&filename)
        .map_err(|e| e.to_string())?;
    state.sync_manager.lock().unwrap()
        .update_image_hash(&filename, &bytes);
    Ok(())
}

/// Remove an image's sync mapping (e.g. when the image is deleted locally).
#[tauri::command]
pub fn unregister_synced_image(
    state: State<AppState>,
    filename: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .unregister_file(&filename);
    Ok(())
}

#[tauri::command]
pub fn write_sync_file(
    state: State<AppState>,
    folder_path: String,
    relative_path: String,
    content: String,
    internal_id: String,
) -> Result<SyncWriteResult, String> {
    let sync_mgr = state.sync_manager.lock().unwrap();
    let result = sync_mgr
        .write_external_if_current(&folder_path, &relative_path, &content, &internal_id)
        .map_err(|e| e.to_string())?;
    if result.written {
        drop(sync_mgr);
        state.sync_manager.lock().unwrap()
            .update_hash(&internal_id, &content, None);
    }
    Ok(result)
}

#[tauri::command]
pub fn update_sync_hash(
    state: State<AppState>,
    internal_id: String,
    content: String,
    synced_at: Option<i64>,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .update_hash(&internal_id, &content, synced_at);
    Ok(())
}

#[tauri::command]
pub fn get_synced_files(
    state: State<AppState>,
    sync_folder_id: String,
) -> Vec<SyncedFileInfo> {
    state.sync_manager.lock().unwrap()
        .get_folder_files(&sync_folder_id)
}

#[tauri::command]
pub fn get_sync_file_info(
    state: State<AppState>,
    internal_id: String,
) -> Option<SyncedFileInfo> {
    state.sync_manager.lock().unwrap()
        .get_file_info(&internal_id)
        .cloned()
}

#[tauri::command]
pub fn rename_sync_file(
    state: State<AppState>,
    folder_path: String,
    old_relative: String,
    new_relative: String,
    internal_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .rename_external_file(&folder_path, &old_relative, &new_relative, &internal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_sync_file(
    state: State<AppState>,
    folder_path: String,
    internal_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .delete_external_file(&folder_path, &internal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_sync_directory(
    folder_path: String,
    relative_path: String,
) -> Result<(), String> {
    SyncManager::create_external_directory(&folder_path, &relative_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_sync_directory(
    state: State<AppState>,
    folder_path: String,
    old_relative: String,
    new_relative: String,
    sync_folder_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .rename_external_directory(&folder_path, &old_relative, &new_relative, &sync_folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_sync_directory(
    state: State<AppState>,
    folder_path: String,
    relative_path: String,
    sync_folder_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .delete_external_directory(&folder_path, &relative_path, &sync_folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_sync_file(
    state: State<AppState>,
    folder_path: String,
    relative_path: String,
    content: String,
    internal_id: String,
    sync_folder_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .create_external_file(&folder_path, &relative_path, &content, &internal_id, &sync_folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_project_json(
    folder_path: String,
    relative_path: String,
    doc_names: Vec<String>,
) -> Result<(), String> {
    SyncManager::write_project_json(&folder_path, &relative_path, &doc_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_sync_changes(
    state: State<AppState>,
) -> Result<Vec<ExternalChange>, String> {
    let settings = state.settings.lock().unwrap();
    let sync_mgr = state.sync_manager.lock().unwrap();
    let file_mgr = state.file_manager.lock().unwrap();
    let mut all_changes = Vec::new();
    for folder in &settings.sync_folders {
        if folder.sync_type == "local" {
            let mut changes = sync_mgr.check_all_external_changes(folder);
            for change in &mut changes {
                if let Ok(entry) = file_mgr.load_file(&change.internal_id) {
                    change.internal_content = entry.content;
                    change.internal_modified = entry.modified as i64;
                }
            }
            all_changes.extend(changes);
        }
    }
    Ok(all_changes)
}

#[tauri::command]
pub fn diff_sync_folder(
    state: State<AppState>,
    sync_folder_id: String,
) -> Result<SyncFolderDiff, String> {
    let settings = state.settings.lock().unwrap();
    let sync_mgr = state.sync_manager.lock().unwrap();
    let folder = settings.sync_folders.iter()
        .find(|f| f.id == sync_folder_id)
        .ok_or("Sync folder not found")?;
    Ok(sync_mgr.diff_sync_folder(folder))
}

#[tauri::command]
pub fn accept_external_change(
    state: State<AppState>,
    internal_id: String,
    content: String,
    synced_at: Option<i64>,
) -> Result<(), String> {
    {
        let fm = state.file_manager.lock().unwrap();
        if let Ok(existing) = fm.load_file(&internal_id) {
            if !existing.content.is_empty() && existing.content != content {
                let _ = state.snapshot_manager.lock().unwrap()
                    .create_snapshot(&internal_id, &existing.content);
            }
        }
    }
    state.file_manager.lock().unwrap()
        .save_file(&internal_id, &content)
        .map_err(|e| e.to_string())?;
    state.sync_manager.lock().unwrap()
        .update_hash(&internal_id, &content, synced_at);
    Ok(())
}

#[tauri::command]
pub fn reject_external_change(
    state: State<AppState>,
    internal_id: String,
    folder_path: String,
) -> Result<(), String> {
    let content = {
        let fm = state.file_manager.lock().unwrap();
        fm.load_file(&internal_id).map_err(|e| e.to_string())?.content
    };
    let sync_mgr = state.sync_manager.lock().unwrap();
    let info = sync_mgr.get_file_info(&internal_id)
        .ok_or("File not synced")?;
    SyncManager::write_external(&folder_path, &info.relative_path, &content)
        .map_err(|e| e.to_string())?;
    drop(sync_mgr);
    state.sync_manager.lock().unwrap().update_hash(&internal_id, &content, None);
    Ok(())
}
