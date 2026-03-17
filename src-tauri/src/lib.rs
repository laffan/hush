use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    AppHandle, Emitter, Manager, State, WindowEvent,
};

mod settings;
mod files;

use settings::AppSettings;
use files::FileManager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_manager: Mutex<FileManager>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub content: String,
    pub modified: u64,
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

fn setup_tray_menu(app: &AppHandle, shortcut_label: &str) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(
        app, "toggle_editor",
        &format!("Toggle Editor    {}", shortcut_label),
        true, None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hush", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&toggle, &settings_item, &sep, &quit])?;

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
    let shortcut_label = settings.shortcut_open_editor.clone()
        .replace("CmdOrCtrl", "⌘")
        .replace("Shift", "⇧")
        .replace("+", "");
    let file_manager = FileManager::new(data_dir.join("files"));

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            file_manager: Mutex::new(file_manager),
        })
        .setup(move |app| {
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
                    "settings" => {
                        let _ = handle_clone2.emit("open-settings", ());
                    }
                    _ => {}
                }
            });

            // macOS: hide from dock
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            // Show the window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Only hide-on-close for the main window, not settings
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_files,
            load_file,
            save_file,
            create_file,
            delete_file,
            check_obsidian_vault,
            set_always_on_top,
            set_activation_policy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
