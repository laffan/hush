use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use tauri::WindowEvent;
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
};

mod activity_log;
mod atomic;
mod commands;
mod desk_archive;
mod desk_conflicts;
mod desk_dedupe;
mod desk_hashes;
mod desk_meta;
mod desk_migrate;
mod desk_paths;
mod desk_place;
mod desk_recovery;
mod desk_rescue;
mod desk_roots;
mod desk_scan;
mod desk_store;
mod files;
mod hushnote;
mod images;
mod local_sync;
mod multi_window;
mod pdfs;
mod settings;
mod snapshots;
pub mod typst_export;
mod zotero;

use files::FileManager;
use images::ImageManager;
use local_sync::LocalSyncManager;
use multi_window::WindowRegistry;
use pdfs::PdfManager;
use settings::AppSettings;
use snapshots::SnapshotManager;
use zotero::ZoteroManager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub file_manager: Mutex<FileManager>,
    pub image_manager: Mutex<ImageManager>,
    pub pdf_manager: Mutex<PdfManager>,
    pub snapshot_manager: Mutex<SnapshotManager>,
    pub zotero_manager: Mutex<ZoteroManager>,
    pub local_sync_manager: LocalSyncManager,
    pub desk_watch_manager: LocalSyncManager,
    pub window_registry: WindowRegistry,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub content: String,
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
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
    // PDF-only — this node is an alias into a project's own PDFs folder:
    // it shares the original's fileId (binary + registry metadata) but is
    // just a reference, so deleting it never touches the desk copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pdf_alias: bool,
    // Folder-only — a project's local "PDFs" folder holding pdf aliases.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pdf_folder: bool,
    // PDF-alias-only — epoch seconds when the alias was added to its
    // project (the alias's own metadata beyond what the registry holds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<u64>,
    // PDF-only, legacy — the shelf's "flag to top" feature originally
    // shipped as `pinned`; it now rides the shared `flagged` field. Kept
    // so existing trees deserialize and the JS side can migrate the
    // marker (enforceFlaggedPdfOrder folds it into `flagged` and clears
    // it, after which skip_serializing_if drops the key from disk).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
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

    // One-shot migration from the flat store (files/*.json +
    // file_tree.json) into per-desk folders. Runs before any manager
    // reads; a no-op once `desks/order.json` exists.
    if let Err(e) = desk_migrate::migrate_from_flat(&data_dir) {
        eprintln!("desk-store migration failed: {}", e);
    }
    // Same deal for version history: snapshots.db rows become per-desk
    // .hush/versions/<fileId>/*.snap files. Runs after the desk store
    // exists so each document's snapshots land in its desk.
    if let Err(e) = snapshots::migrate_snapshots_db(&data_dir) {
        eprintln!("snapshot migration failed: {}", e);
    }

    #[cfg(desktop)]
    let shortcut_label = settings.shortcut_open_editor.clone()
        .replace("CmdOrCtrl", "⌘")
        .replace("Shift", "⇧")
        .replace("+", "");

    #[cfg(desktop)]
    let initial_visibility = settings.visibility.clone();

    let file_manager = FileManager::new(&data_dir);
    let image_manager = ImageManager::new(
        data_dir.join("files").join("images"),
        data_dir.join("desks"),
    );
    let snapshot_manager = SnapshotManager::new(&data_dir);
    let zotero_manager = ZoteroManager::new(&data_dir);
    let local_sync_manager = LocalSyncManager::new();
    let desk_watch_manager = LocalSyncManager::new();

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
        // iOS-only: lets an already-open window take incoming URL opens
        // (e.g. zotero-helper's "Send to Hush") instead of iPadOS
        // spawning a new scene for each one. No-op elsewhere.
        .plugin(tauri_plugin_scene_reuse::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            file_manager: Mutex::new(file_manager),
            image_manager: Mutex::new(image_manager),
            pdf_manager: Mutex::new(PdfManager::new(&data_dir)),
            snapshot_manager: Mutex::new(snapshot_manager),
            zotero_manager: Mutex::new(zotero_manager),
            local_sync_manager,
            desk_watch_manager,
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
                // Arm watchers on every local desk root so external
                // edits reach the UI while the app runs. Bookmarked
                // (iOS) roots get no watcher — the JS layer re-resolves
                // the bookmark and reconciles on foreground instead.
                for (desk_id, entry) in
                    desk_roots::load_entries(&crate::get_data_dir().join("desks"))
                {
                    if entry.bookmark().is_some() {
                        continue;
                    }
                    let _ = app_state.desk_watch_manager.watch_path(
                        handle.clone(),
                        &desk_id,
                        std::path::Path::new(entry.path()),
                        "desk-changed",
                    );
                }
                // Merge per-desk Google-Doc-link sidecars into the
                // settings cache (and migrate settings-only entries down
                // into their desks) so links ride desk handoffs.
                commands::google_docs::refresh_gdoc_link_cache(&app_state);
                // Rolling recovery snapshots for local desks: a
                // background thread zips any local desk with pending
                // edits every 30 minutes (see desk_recovery.rs).
                desk_recovery::start_scheduler(crate::get_data_dir());
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
            let label = window.label().to_string();
            #[cfg(desktop)]
            {
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
                }
            }
            // Secondary editor windows opened by "Open in new window"
            // (and iPad scene windows). When they're destroyed we drop
            // them from the registry so the sidebar's window-number
            // badges disappear in lockstep. This must run on mobile too
            // — iPad scene teardown is exactly the case where the JS
            // unload handler can't be relied on, and gating this behind
            // cfg(desktop) left a stale badge behind for every closed
            // iPad window.
            if label != "main" && label != "settings" {
                if let WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<AppState>() {
                        state.window_registry.remove(&label);
                        let _ = window
                            .app_handle()
                            .emit("windows-updated", state.window_registry.list());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::files::list_files,
            commands::files::load_file,
            commands::files::save_file,
            commands::files::save_file_raw,
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
            commands::pdfs::save_pdf,
            commands::pdfs::load_pdf,
            commands::pdfs::delete_pdf,
            commands::pdfs::pdf_exists,
            commands::pdfs::save_pdf_meta,
            commands::pdfs::load_pdf_meta,
            commands::pdfs::save_pdf_cover,
            commands::pdfs::load_pdf_cover,
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
            commands::desks::desk_list_roots,
            commands::desks::desk_list_root_entries,
            commands::desks::desk_update_root_path,
            commands::desks::desk_meta_get,
            commands::desks::desk_meta_set,
            commands::desks::desk_make_local,
            commands::desks::desk_make_internal,
            commands::desks::desk_open_folder_as_desk,
            commands::desks::desk_unregister_root,
            commands::desks::desk_reconcile,
            commands::desks::desk_archive,
            commands::desks::desk_discard_archived,
            commands::desks::desk_archives_list,
            commands::desks::desk_archive_restore,
            commands::desks::desk_archive_delete,
            commands::desks::desk_archive_bytes,
            commands::desks::desk_recovery_list,
            commands::desks::desk_recovery_delete,
            commands::desks::desk_recovery_restore,
            commands::diagnostics::activity_log_append,
            commands::diagnostics::activity_log_read,
            commands::diagnostics::activity_log_clear,
            commands::diagnostics::desk_store_diagnostics,
            commands::diagnostics::desk_repair_files,
            commands::diagnostics::desk_retire,
            commands::diagnostics::desk_list_retired,
            commands::diagnostics::desk_restore_retired,
            commands::diagnostics::build_info,
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
            commands::local_sync::local_sync_delete_dir_if_clean,
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
            commands::window::set_window_display_title,
            commands::multi_window::list_windows,
            commands::multi_window::register_window,
            commands::multi_window::set_window_file,
            commands::multi_window::unregister_window,
            commands::multi_window::window_heartbeat,
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
