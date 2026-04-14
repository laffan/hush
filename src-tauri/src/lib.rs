use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, State};

#[cfg(desktop)]
use tauri::{
    Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    WindowEvent,
};

mod settings;
mod files;
mod snapshots;
mod sync;
mod zotero;

use settings::AppSettings;
use files::FileManager;
use snapshots::{SnapshotManager, SnapshotEntry};
use sync::{SyncManager, SyncWriteResult, SyncFolderDiff, ImportEntry, SyncedFileInfo, ExternalChange};
use zotero::ZoteroManager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_manager: Mutex<FileManager>,
    pub snapshot_manager: Mutex<SnapshotManager>,
    pub sync_manager: Mutex<SyncManager>,
    pub zotero_manager: Mutex<ZoteroManager>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub content: String,
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String, // "document" | "folder" | "project"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>, // only for documents — points to files/{uuid}.json
    // Always serialized (even when empty) so the JS frontend always
    // receives a real array — skipping empty children broke sync-folder
    // reconciliation when inserting files into previously-empty folders.
    #[serde(default)]
    pub children: Vec<TreeNode>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flagged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_style_id: Option<String>,
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: AppSettings) -> Result<(), String> {
    let mut current = state.settings.lock().unwrap();
    let data_dir = current.data_dir.clone(); // Preserve — it's #[serde(skip)]
    *current = settings.clone();
    current.data_dir = data_dir;
    current.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_files(state: State<AppState>) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().list_files().map_err(|e| e.to_string())
}

#[tauri::command]
fn load_file(state: State<AppState>, id: String) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().load_file(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(state: State<AppState>, id: String, content: String) -> Result<(), String> {
    let fm = state.file_manager.lock().unwrap();
    fm.save_file(&id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_file(state: State<AppState>) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().create_file().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(state: State<AppState>, id: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().delete_file(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_file(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().rename_file(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_file_tree(state: State<AppState>) -> Result<Vec<TreeNode>, String> {
    state.file_manager.lock().unwrap().get_file_tree().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file_tree(state: State<AppState>, tree: Vec<TreeNode>) -> Result<(), String> {
    state.file_manager.lock().unwrap().save_file_tree(&tree).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_folder(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_project(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_project(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_project_content(state: State<AppState>, project_id: String) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().load_project_content(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_snapshot(
    state: State<AppState>,
    document_id: String,
    content: String,
) -> Result<i64, String> {
    state.snapshot_manager.lock().unwrap()
        .create_snapshot(&document_id, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_snapshots(
    state: State<AppState>,
    document_id: String,
) -> Result<Vec<SnapshotEntry>, String> {
    state.snapshot_manager.lock().unwrap()
        .get_snapshots(&document_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_snapshot(state: State<AppState>, id: i64) -> Result<SnapshotEntry, String> {
    state.snapshot_manager.lock().unwrap()
        .get_snapshot(id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_document_snapshots(
    state: State<AppState>,
    document_id: String,
) -> Result<(), String> {
    state.snapshot_manager.lock().unwrap()
        .delete_document_snapshots(&document_id)
        .map_err(|e| e.to_string())
}

// ===== Dropbox OAuth =====

#[tauri::command]
async fn exchange_dropbox_token(
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
async fn refresh_dropbox_token(
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
fn scan_sync_folder(folder_path: String) -> Result<Vec<ImportEntry>, String> {
    SyncManager::scan_folder(&folder_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn register_synced_file(
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
fn unregister_sync_folder(
    state: State<AppState>,
    sync_folder_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .unregister_folder(&sync_folder_id);
    Ok(())
}

#[tauri::command]
fn write_sync_file(
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
            .update_hash(&internal_id, &content);
    }
    Ok(result)
}

#[tauri::command]
fn update_sync_hash(
    state: State<AppState>,
    internal_id: String,
    content: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .update_hash(&internal_id, &content);
    Ok(())
}

#[tauri::command]
fn get_synced_files(
    state: State<AppState>,
    sync_folder_id: String,
) -> Vec<SyncedFileInfo> {
    state.sync_manager.lock().unwrap()
        .get_folder_files(&sync_folder_id)
}

#[tauri::command]
fn get_sync_file_info(
    state: State<AppState>,
    internal_id: String,
) -> Option<SyncedFileInfo> {
    state.sync_manager.lock().unwrap()
        .get_file_info(&internal_id)
        .cloned()
}

#[tauri::command]
fn rename_sync_file(
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
fn delete_sync_file(
    state: State<AppState>,
    folder_path: String,
    internal_id: String,
) -> Result<(), String> {
    state.sync_manager.lock().unwrap()
        .delete_external_file(&folder_path, &internal_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_sync_directory(
    folder_path: String,
    relative_path: String,
) -> Result<(), String> {
    SyncManager::create_external_directory(&folder_path, &relative_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_sync_directory(
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
fn delete_sync_directory(
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
fn create_sync_file(
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
fn write_project_json(
    folder_path: String,
    relative_path: String,
    doc_names: Vec<String>,
) -> Result<(), String> {
    SyncManager::write_project_json(&folder_path, &relative_path, &doc_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn check_sync_changes(
    state: State<AppState>,
) -> Result<Vec<sync::ExternalChange>, String> {
    let settings = state.settings.lock().unwrap();
    let sync_mgr = state.sync_manager.lock().unwrap();
    let file_mgr = state.file_manager.lock().unwrap();
    let mut all_changes = Vec::new();
    for folder in &settings.sync_folders {
        if folder.sync_type == "local" {
            let mut changes = sync_mgr.check_all_external_changes(folder);
            // Fill in internal content and modification time
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
fn diff_sync_folder(
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
fn accept_external_change(
    state: State<AppState>,
    internal_id: String,
    content: String,
) -> Result<(), String> {
    // Snapshot the current internal content before overwriting (version history)
    {
        let fm = state.file_manager.lock().unwrap();
        if let Ok(existing) = fm.load_file(&internal_id) {
            if !existing.content.is_empty() && existing.content != content {
                let _ = state.snapshot_manager.lock().unwrap()
                    .create_snapshot(&internal_id, &existing.content);
            }
        }
    }
    // Save the external content as the new internal content and update hash
    state.file_manager.lock().unwrap()
        .save_file(&internal_id, &content)
        .map_err(|e| e.to_string())?;
    state.sync_manager.lock().unwrap()
        .update_hash(&internal_id, &content);
    Ok(())
}

#[tauri::command]
fn reject_external_change(
    state: State<AppState>,
    internal_id: String,
    folder_path: String,
) -> Result<(), String> {
    // Overwrite external file with internal content and update hash
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
    state.sync_manager.lock().unwrap().update_hash(&internal_id, &content);
    Ok(())
}

// ===== Zotero Commands =====

#[tauri::command]
fn save_zotero_references(state: State<AppState>, data: String) -> Result<(), String> {
    state.zotero_manager.lock().unwrap()
        .save_references(&data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_zotero_references(state: State<AppState>) -> Result<String, String> {
    state.zotero_manager.lock().unwrap()
        .load_references()
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_activation_policy(_app: AppHandle, _policy: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match _policy.as_str() {
            "regular" => _app.set_activation_policy(tauri::ActivationPolicy::Regular),
            "accessory" => _app.set_activation_policy(tauri::ActivationPolicy::Accessory),
            _ => return Err(format!("Unknown policy: {}", _policy)),
        }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn get_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hush.app")
}

#[cfg(desktop)]
fn save_window_geometry(window: &tauri::Window, state: &AppState) {
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(mut settings) = state.settings.lock() {
        if let Ok(size) = window.inner_size() {
            settings.window_width = Some(size.width as f64 / scale);
            settings.window_height = Some(size.height as f64 / scale);
        }
        if let Ok(pos) = window.outer_position() {
            settings.window_x = Some(pos.x as f64 / scale);
            settings.window_y = Some(pos.y as f64 / scale);
        }
        let _ = settings.save();
    }
}

#[cfg(desktop)]
fn setup_tray_menu(app: &AppHandle, shortcut_label: &str) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(
        app, "toggle_editor",
        &format!("Toggle Editor    {}", shortcut_label),
        true, None::<&str>,
    )?;
    let fullscreen_item = MenuItem::with_id(app, "fullscreen", "Fullscreen    ⌘⇧F", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings...    ⌘,", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hush", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&toggle, &fullscreen_item, &settings_item, &sep, &quit])?;

    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = get_data_dir();
    fs::create_dir_all(&data_dir).ok();
    fs::create_dir_all(data_dir.join("files")).ok();

    let settings = AppSettings::load(&data_dir).unwrap_or_default();

    #[cfg(desktop)]
    let shortcut_label = settings.shortcut_open_editor.clone()
        .replace("CmdOrCtrl", "⌘")
        .replace("Shift", "⇧")
        .replace("+", "");

    #[cfg(desktop)]
    let initial_visibility = settings.visibility.clone();

    let file_manager = FileManager::new(data_dir.join("files"));
    let snapshot_manager = SnapshotManager::new(&data_dir);
    let sync_manager = SyncManager::new(&data_dir);
    let zotero_manager = ZoteroManager::new(&data_dir);

    // Run snapshot cleanup on startup
    if let Err(e) = snapshot_manager.cleanup_all() {
        eprintln!("Snapshot cleanup error: {}", e);
    }

    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init());

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            file_manager: Mutex::new(file_manager),
            snapshot_manager: Mutex::new(snapshot_manager),
            sync_manager: Mutex::new(sync_manager),
            zotero_manager: Mutex::new(zotero_manager),
        })
        .setup(move |_app| {
            // Handle deep-link URLs (e.g. hushwriter://auth/callback?code=xxx)
            // Must be set up before the desktop block borrows _app.
            {
                let handle = _app.handle().clone();
                _app.listen("deep-link://new-url", move |event| {
                    if let Some(urls) = event.payload().strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                        for url_str in urls.split(',') {
                            let url_str = url_str.trim().trim_matches('"');
                            if url_str.starts_with("hushwriter://auth/callback") {
                                if let Some(query) = url_str.split('?').nth(1) {
                                    for param in query.split('&') {
                                        if let Some(code) = param.strip_prefix("code=") {
                                            let _ = handle.emit("oauth-callback", serde_json::json!({ "code": code }));
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }

            #[cfg(desktop)]
            let app = _app;
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();

                setup_tray_menu(&handle, &shortcut_label)?;

                // Tray icon click: toggle editor
                let handle_clone = handle.clone();
                if let Some(tray) = app.tray_by_id("main-tray") {
                    tray.on_tray_icon_event(move |_tray, event| {
                        match event {
                            TrayIconEvent::Click { button, button_state, .. } => {
                                if button == tauri::tray::MouseButton::Left
                                    && button_state == tauri::tray::MouseButtonState::Up
                                {
                                    if let Some(window) = handle_clone.get_webview_window("main") {
                                        if window.is_visible().unwrap_or(false) {
                                            let _ = window.hide();
                                        } else {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    });
                }

                // Menu events
                let handle_clone2 = handle.clone();
                app.on_menu_event(move |app_handle, event| {
                    match event.id().as_ref() {
                        "quit" => {
                            app_handle.exit(0);
                        }
                        "toggle_editor" => {
                            if let Some(window) = handle_clone2.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        "fullscreen" => {
                            let _ = handle_clone2.emit("toggle-fullscreen", ());
                        }
                        "settings" => {
                            let _ = handle_clone2.emit("open-settings", ());
                        }
                        _ => {}
                    }
                });

                // macOS: apply visibility setting
                #[cfg(target_os = "macos")]
                {
                    let policy = match initial_visibility.as_str() {
                        "dock" | "both" => tauri::ActivationPolicy::Regular,
                        _ => tauri::ActivationPolicy::Accessory,
                    };
                    let _ = app.set_activation_policy(policy);
                }

                // Restore window geometry and show the window
                if let Some(window) = app.get_webview_window("main") {
                    let app_state: State<AppState> = app.state();
                    let settings = app_state.settings.lock().unwrap();
                    if let (Some(w), Some(h)) = (settings.window_width, settings.window_height) {
                        let _ = window.set_size(tauri::LogicalSize::new(w, h));
                    }
                    if let (Some(x), Some(y)) = (settings.window_x, settings.window_y) {
                        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                    }
                    drop(settings);
                    let _ = window.show();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(state) = window.try_state::<AppState>() {
                            save_window_geometry(window, &state);
                        }
                        let _ = window.hide();
                    }
                    WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                        if let Some(state) = window.try_state::<AppState>() {
                            save_window_geometry(window, &state);
                        }
                    }
                    _ => {}
                }
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_files,
            load_file,
            save_file,
            create_file,
            delete_file,
            rename_file,
            get_file_tree,
            save_file_tree,
            create_folder,
            create_project,
            load_project_content,
            create_snapshot,
            get_snapshots,
            get_snapshot,
            delete_document_snapshots,
            exchange_dropbox_token,
            refresh_dropbox_token,
            scan_sync_folder,
            register_synced_file,
            unregister_sync_folder,
            write_sync_file,
            update_sync_hash,
            get_synced_files,
            get_sync_file_info,
            rename_sync_file,
            delete_sync_file,
            create_sync_directory,
            rename_sync_directory,
            delete_sync_directory,
            create_sync_file,
            write_project_json,
            check_sync_changes,
            diff_sync_folder,
            accept_external_change,
            reject_external_change,
            save_zotero_references,
            load_zotero_references,
            #[cfg(desktop)]
            set_always_on_top,
            set_activation_policy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
