use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    WindowEvent,
};

mod atomic;
mod commands;
mod files;
mod images;
mod local_sync;
mod multi_window;
mod pdfs;
mod settings;
mod snapshots;
mod sync;
mod sync_commands;
mod sync_db;
pub mod typst_export;
mod zotero;

use files::FileManager;
use images::ImageManager;
use local_sync::LocalSyncManager;
use multi_window::WindowRegistry;
use pdfs::PdfManager;
use settings::AppSettings;
use snapshots::SnapshotManager;
use sync::SyncManager;
use zotero::ZoteroManager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_manager: Mutex<FileManager>,
    pub image_manager: Mutex<ImageManager>,
    pub pdf_manager: Mutex<PdfManager>,
    pub snapshot_manager: Mutex<SnapshotManager>,
    pub sync_manager: Mutex<SyncManager>,
    pub zotero_manager: Mutex<ZoteroManager>,
    pub local_sync_manager: LocalSyncManager,
    pub window_registry: WindowRegistry,
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
    pub node_type: String, // "document" | "folder" | "project" | "notebook" | "pdf" | "stack"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>, // for documents and notebooks — points to files/{uuid}.json
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
    // Doc-only — when set on a doc inside a project, the doc rides as
    // a "note" alongside notebooks (50 % opacity, sorted under the
    // joined buffer) instead of feeding the joined editor stream.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub use_as_note: bool,
    // PDF-only — Zotero attachment key for PDFs imported from Zotero.
    // Enables annotation fetch + overlay via the Zotero API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_att_key: Option<String>,
    // Sidebar background tint — one of the keys in ROW_COLORS
    // (files-panel-row-menu.js). Children inherit visually via CSS
    // cascade; absent on most nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_color: Option<String>,
    // Project-only — when true, the sidebar prefixes child rows with
    // outline numbers (decimals for nested projects).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub show_numbers: bool,
    // Notebook-only — when true (inside a project), this notebook is the
    // project's gutter: paired with the joined doc buffer and rendered as a
    // right-docked sidebar. The pairing is the project's own metadata, so it
    // must survive the save_file_tree / get_file_tree round trip.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gutter: bool,
}

pub fn get_data_dir() -> PathBuf {
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
    fs::create_dir_all(data_dir.join("files").join("images")).ok();

    let settings = AppSettings::load(&data_dir).unwrap_or_default();

    #[cfg(desktop)]
    let shortcut_label = settings.shortcut_open_editor.clone()
        .replace("CmdOrCtrl", "⌘")
        .replace("Shift", "⇧")
        .replace("+", "");

    #[cfg(desktop)]
    let initial_visibility = settings.visibility.clone();

    let file_manager = FileManager::new(data_dir.join("files"));
    let image_manager = ImageManager::new(data_dir.join("files").join("images"));
    let snapshot_manager = SnapshotManager::new(&data_dir);
    let sync_manager = SyncManager::new(&data_dir);
    let zotero_manager = ZoteroManager::new(&data_dir);
    let local_sync_manager = LocalSyncManager::new();

    // Snapshot of persisted local-sync folders so we can re-arm watchers
    // after the app state is managed. Clone here while the settings
    // value is still a plain struct.
    let persisted_local_sync = settings.local_sync_folders.clone();

    // Run snapshot cleanup on startup
    if let Err(e) = snapshot_manager.cleanup_all() {
        eprintln!("Snapshot cleanup error: {}", e);
    }

    // Sequential labels for system-requested iPad scenes (long-press
    // "New Window"). Captured by the run() closure below.
    #[cfg(target_os = "ios")]
    let mut _ios_scene_counter = 0u32;

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
        .plugin(tauri_plugin_clipboard_manager::init())
        // iOS-only Apple Pencil bridge. No-op on every other platform —
        // the plugin's iOS registration is gated behind
        // `cfg(target_os = "ios")` inside the crate, so registering it
        // unconditionally here is safe and keeps the macOS build clean.
        .plugin(tauri_plugin_pencil::init())
        // iOS-only folder-bookmark bridge (proof-of-concept for Local
        // Folder on iOS). Same cfg-gating as pencil: a no-op shell on
        // every non-iOS target, so registering it here is safe.
        .plugin(tauri_plugin_icloud_folder::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            file_manager: Mutex::new(file_manager),
            image_manager: Mutex::new(image_manager),
            pdf_manager: Mutex::new(PdfManager::new(&data_dir)),
            snapshot_manager: Mutex::new(snapshot_manager),
            sync_manager: Mutex::new(sync_manager),
            zotero_manager: Mutex::new(zotero_manager),
            local_sync_manager,
            window_registry: WindowRegistry::new(),
        })
        .setup(move |_app| {
            // Re-arm local-sync watchers for every folder persisted in
            // settings. Each one emits `local-sync-changed` events that
            // the frontend listens to for live refresh.
            {
                let handle = _app.handle().clone();
                let app_state: State<AppState> = _app.state();
                for folder in &persisted_local_sync {
                    // iOS mounts (those carrying a security-scoped
                    // bookmark) have no notify-crate watcher; access is
                    // re-acquired by the JS layer via the icloud-folder
                    // plugin on startup instead.
                    if folder.bookmark.is_none() {
                        let _ = app_state.local_sync_manager.watch(handle.clone(), folder);
                    }
                }
            }

            // Dropbox OAuth callback via deep link. Google uses a
            // loopback HTTP listener instead (see
            // commands::google_docs::start_google_oauth_listener), so
            // only the Dropbox URL prefix is recognised here.
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
                                            let _ = handle.emit(
                                                "oauth-callback",
                                                serde_json::json!({ "code": code, "provider": "dropbox" }),
                                            );
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
            {
                let label = window.label().to_string();
                if label == "main" {
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
                } else if label != "settings" {
                    // Secondary editor windows opened by "Open in new
                    // window". When they're destroyed we drop them from
                    // the registry so the sidebar's window-number badges
                    // disappear in lockstep.
                    if let WindowEvent::Destroyed = event {
                        if let Some(state) = window.try_state::<AppState>() {
                            state.window_registry.remove(&label);
                            let _ = window
                                .app_handle()
                                .emit("windows-updated", state.window_registry.list());
                        }
                    }
                }
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::files::list_files,
            commands::files::load_file,
            commands::files::save_file,
            commands::files::create_file,
            commands::files::delete_file,
            commands::files::rename_file,
            commands::files::get_file_tree,
            commands::files::save_file_tree,
            commands::files::create_folder,
            commands::files::create_project,
            commands::files::create_notebook,
            commands::files::create_stack,
            commands::files::load_project_content,
            commands::images::save_image,
            commands::images::save_image_bytes,
            commands::images::load_image,
            commands::images::load_image_bytes,
            commands::images::delete_image,
            commands::images::rename_image,
            commands::images::list_images,
            commands::images::export_with_images,
            commands::images::write_binary_file,
            commands::handwriting::recognize_handwriting,
            commands::handwriting_ink::recognize_handwriting_ink,
            commands::snapshots::create_snapshot,
            commands::snapshots::get_snapshots,
            commands::snapshots::get_snapshot,
            commands::snapshots::delete_document_snapshots,
            sync_commands::exchange_dropbox_token,
            sync_commands::refresh_dropbox_token,
            commands::google_docs::start_google_oauth_listener,
            commands::google_docs::exchange_google_token,
            commands::google_docs::refresh_google_token,
            commands::google_docs::revoke_google_tokens,
            commands::google_docs::set_google_account_email,
            commands::google_docs::set_google_doc_link,
            commands::google_docs::get_google_doc_link,
            commands::google_docs::clear_google_doc_link,
            commands::google_docs::list_google_doc_links,
            commands::google_docs::append_google_sync_log,
            commands::google_docs::clear_google_sync_log,
            sync_commands::scan_sync_folder,
            sync_commands::register_synced_file,
            sync_commands::register_synced_image,
            sync_commands::update_sync_image_hash,
            sync_commands::unregister_synced_image,
            sync_commands::unregister_sync_folder,
            sync_commands::write_sync_file,
            sync_commands::get_synced_files,
            sync_commands::get_sync_file_info,
            sync_commands::rename_sync_file,
            sync_commands::delete_sync_file,
            sync_commands::create_sync_directory,
            sync_commands::rename_sync_directory,
            sync_commands::delete_sync_directory,
            sync_commands::create_sync_file,
            sync_commands::check_sync_changes,
            sync_commands::diff_sync_folder,
            sync_commands::accept_external_change,
            sync_commands::reject_external_change,
            sync_commands::enqueue_sync_op,
            sync_commands::peek_pending_ops,
            sync_commands::pending_op_succeeded,
            sync_commands::pending_op_failed,
            sync_commands::get_dropbox_cursor,
            sync_commands::set_dropbox_cursor,
            sync_commands::clear_dropbox_cursor,
            sync_commands::clear_local_data,
            sync_commands::find_synced_file_by_remote_id,
            sync_commands::find_synced_file_by_path,
            sync_commands::backfill_remote_id,
            sync_commands::update_sync_state,
            sync_commands::register_synced_file_full,
            commands::pdfs::save_pdf,
            commands::pdfs::load_pdf,
            commands::pdfs::delete_pdf,
            commands::pdfs::pdf_exists,
            commands::pdfs::save_pdf_meta,
            commands::pdfs::load_pdf_meta,
            commands::pdfs::save_pdf_registry,
            commands::pdfs::load_pdf_registry,
            commands::zotero::save_zotero_references,
            commands::zotero::load_zotero_references,
            commands::zotero::save_zotero_pdf,
            commands::zotero::load_zotero_pdf,
            commands::zotero::zotero_pdf_exists,
            commands::zotero::download_zotero_pdf,
            commands::zotero::save_zotero_annotations,
            commands::zotero::load_zotero_annotations,
            commands::zotero::fetch_zotero_annotations,
            commands::local_sync::local_sync_add,
            commands::local_sync::local_sync_remove,
            commands::local_sync::local_sync_list,
            commands::local_sync::local_sync_read_dir,
            commands::local_sync::local_sync_read_file,
            commands::local_sync::local_sync_write_file,
            commands::local_sync::local_sync_read_file_bytes,
            commands::local_sync::local_sync_write_file_bytes,
            commands::local_sync::local_sync_create_file,
            commands::local_sync::local_sync_create_dir,
            commands::local_sync::local_sync_rename,
            commands::local_sync::local_sync_delete,
            commands::local_sync::local_sync_move,
            commands::local_sync::local_sync_copy,
            commands::backup::backup_app_data,
            commands::grammar::check_grammar,
            commands::grammar::list_grammar_rules,
            commands::spellcheck::check_spelling,
            commands::spellcheck::spelling_suggestions,
            #[cfg(desktop)]
            commands::window::set_always_on_top,
            commands::window::set_activation_policy,
            commands::window::set_traffic_lights_visible,
            commands::multi_window::list_windows,
            commands::multi_window::register_window,
            commands::multi_window::set_window_file,
            commands::multi_window::unregister_window,
            commands::multi_window::broadcast_state_change,
            commands::multi_window::broadcast_doc_changed,
            commands::multi_window::broadcast_notebook_changed,
            commands::pdf_export::render_doc_pdf,
            commands::pdf_export::list_doc_styles,
            commands::pdf_export::list_citation_styles,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Hush")
        .run(move |_app, _event| {
            // iPad multi-window: the system requests a new scene when the
            // user long-presses the app icon and picks "New Window". Build
            // a full default window for it (it restores the last file like
            // a fresh launch). Windows opened programmatically from JS via
            // `new WebviewWindow(...)` — e.g. the "Open in new window"
            // command, which seeds `#file=…` — do NOT emit this event and
            // are created directly, so they're unaffected here.
            #[cfg(target_os = "ios")]
            {
                if let tauri::RunEvent::SceneRequested { .. } = _event {
                    _ios_scene_counter += 1;
                    let label = format!("window-scene-{_ios_scene_counter}");
                    let _ = tauri::WebviewWindowBuilder::new(
                        _app,
                        label,
                        tauri::WebviewUrl::default(),
                    )
                    .build();
                }
            }
        });
}
