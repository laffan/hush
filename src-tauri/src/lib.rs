use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[cfg(desktop)]
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    WindowEvent,
};

mod settings;
mod files;
mod snapshots;

use settings::AppSettings;
use files::FileManager;
use snapshots::{SnapshotManager, SnapshotEntry};

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_manager: Mutex<FileManager>,
    pub snapshot_manager: Mutex<SnapshotManager>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<TreeNode>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flagged: bool,
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
    let settings = state.settings.lock().unwrap();
    if let Some(ref folder) = settings.autosave_folder {
        fm.save_to_external(&id, &content, folder).map_err(|e| e.to_string())?;
    }
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

#[tauri::command]
fn check_obsidian_vault(path: String) -> bool {
    let path = PathBuf::from(&path);
    let mut current = Some(path.as_path());
    while let Some(dir) = current {
        if dir.join(".obsidian").is_dir() {
            return true;
        }
        current = dir.parent();
    }
    false
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
        .manage(AppState {
            settings: Mutex::new(settings),
            file_manager: Mutex::new(file_manager),
            snapshot_manager: Mutex::new(snapshot_manager),
        })
        .setup(move |_app| {
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
            check_obsidian_vault,
            #[cfg(desktop)]
            set_always_on_top,
            set_activation_policy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
