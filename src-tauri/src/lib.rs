use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
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
    *current = settings.clone();
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
    // Also save to external folder if configured
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
fn set_autosave_folder(state: State<AppState>, path: Option<String>) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.autosave_folder = path;
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn get_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hush.app")
}

fn setup_tray_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let quit = MenuItem::with_id(app, "quit", "Quit Hush", true, None::<&str>)?;
    let always_on_top = MenuItem::with_id(app, "always_on_top", "Keep Above Other Apps", true, None::<&str>)?;

    let theme_light = MenuItem::with_id(app, "theme_light", "Light", true, None::<&str>)?;
    let theme_dark = MenuItem::with_id(app, "theme_dark", "Dark", true, None::<&str>)?;
    let theme_sepia = MenuItem::with_id(app, "theme_sepia", "Sepia", true, None::<&str>)?;
    let themes = Submenu::with_items(app, "Theme", true, &[&theme_light, &theme_dark, &theme_sepia])?;

    let shortcut_editor = MenuItem::with_id(app, "shortcut_open", "Open Editor: Cmd+Shift+H", true, None::<&str>)?;
    let shortcut_private = MenuItem::with_id(app, "shortcut_private", "Toggle Private: Cmd+Shift+P", true, None::<&str>)?;
    let shortcuts = Submenu::with_items(app, "Keyboard Shortcuts", true, &[&shortcut_editor, &shortcut_private])?;

    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&themes, &shortcuts, &sep, &always_on_top, &sep, &quit])?;

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
        .setup(|app| {
            let handle = app.handle().clone();

            // Set up tray menu for Cmd+Click
            setup_tray_menu(&handle)?;

            // Handle tray events
            let handle_clone = handle.clone();
            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.on_tray_icon_event(move |_tray, event| {
                    match event {
                        TrayIconEvent::Click { button, button_state, .. } => {
                            if button == tauri::tray::MouseButton::Left
                                && button_state == tauri::tray::MouseButtonState::Up
                            {
                                if let Some(window) = handle_clone.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }

            // Handle tray menu events
            let handle_clone2 = handle.clone();
            app.on_menu_event(move |app_handle, event| {
                match event.id().as_ref() {
                    "quit" => {
                        app_handle.exit(0);
                    }
                    "always_on_top" => {
                        if let Some(window) = handle_clone2.get_webview_window("main") {
                            let is_on_top = window.is_always_on_top().unwrap_or(false);
                            let _ = window.set_always_on_top(!is_on_top);
                        }
                    }
                    "theme_light" => {
                        let _ = handle_clone2.emit("theme-change", "light");
                    }
                    "theme_dark" => {
                        let _ = handle_clone2.emit("theme-change", "dark");
                    }
                    "theme_sepia" => {
                        let _ = handle_clone2.emit("theme-change", "sepia");
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide instead of close
                api.prevent_close();
                let _ = window.hide();
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
            set_autosave_folder,
            set_fullscreen,
            set_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hush");
}
