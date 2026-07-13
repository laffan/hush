//! Local-desk commands — Make Local / Make Internal / Adopt / Reveal
//! plumbing plus the disk-wins reconcile. On iOS the frontend passes a
//! security-scoped bookmark alongside the picked path; bookmarked roots
//! get no watcher (iOS has no fs events) and rely on the foreground
//! reconcile instead.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use crate::desk_scan::ScanReport;
use crate::desk_store::DeskStore;
use crate::AppState;

fn store() -> DeskStore {
    DeskStore::new(&crate::get_data_dir())
}

/// deskId → external root path for every local desk.
#[tauri::command]
pub fn desk_list_roots() -> Result<HashMap<String, String>, String> {
    Ok(store().list_roots())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootEntryOut {
    path: String,
    bookmark: Option<String>,
}

/// Full root entries, bookmarks included — the iOS boot path needs the
/// bookmark to re-acquire folder access before anything touches the
/// desk.
#[tauri::command]
pub fn desk_list_root_entries() -> Result<HashMap<String, RootEntryOut>, String> {
    Ok(
        crate::desk_roots::load_entries(&crate::get_data_dir().join("desks"))
            .into_iter()
            .map(|(id, e)| {
                let out = RootEntryOut {
                    path: e.path().to_string(),
                    bookmark: e.bookmark().map(str::to_string),
                };
                (id, out)
            })
            .collect(),
    )
}

/// Move a desk's folder to `target_path` and start watching it.
#[tauri::command]
pub fn desk_make_local(
    app: AppHandle,
    state: State<AppState>,
    desk_id: String,
    target_path: String,
    bookmark: Option<String>,
) -> Result<(), String> {
    let target = PathBuf::from(&target_path);
    let watch = bookmark.is_none();
    store()
        .make_desk_local(&desk_id, &target, bookmark)
        .map_err(|e| e.to_string())?;
    if watch {
        if let Err(e) = state
            .desk_watch_manager
            .watch_path(app, &desk_id, &target, "desk-changed")
        {
            eprintln!("desk watcher failed for {}: {}", desk_id, e);
        }
    }
    Ok(())
}

/// Move a local desk's contents back into app data. Returns the internal
/// folder path.
#[tauri::command]
pub fn desk_make_internal(state: State<AppState>, desk_id: String) -> Result<String, String> {
    state.desk_watch_manager.unwatch(&desk_id);
    store()
        .make_desk_internal(&desk_id)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Register an existing desk folder (from another install, or a synced
/// copy) and start watching it. Runs a disk reconcile so files added to
/// the folder since its tree.json was written surface immediately.
/// Returns the adopted desk id.
#[tauri::command]
pub fn desk_adopt_folder(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    bookmark: Option<String>,
) -> Result<String, String> {
    let s = store();
    let watch = bookmark.is_none();
    let desk_id = s
        .adopt_desk_folder(Path::new(&path), bookmark)
        .map_err(|e| e.to_string())?;
    let _ = s.reconcile_desk_from_disk(&desk_id);
    if watch {
        if let Err(e) =
            state
                .desk_watch_manager
                .watch_path(app, &desk_id, Path::new(&path), "desk-changed")
        {
            eprintln!("desk watcher failed for {}: {}", desk_id, e);
        }
    }
    Ok(desk_id)
}

/// Repoint a local desk's root — the iOS boot path, where resolving a
/// stored bookmark can yield a different container path than the one it
/// was minted at. Passing a bookmark replaces the stored one; omitting
/// it keeps it.
#[tauri::command]
pub fn desk_update_root_path(
    desk_id: String,
    path: String,
    bookmark: Option<String>,
) -> Result<(), String> {
    crate::desk_roots::update_root(
        &crate::get_data_dir().join("desks"),
        &desk_id,
        &path,
        bookmark,
    )
    .map_err(|e| e.to_string())
}

/// Disk-wins reconcile: make the desk's tree follow its folder. Returns
/// counts so the frontend can skip refreshes on no-ops.
#[tauri::command]
pub fn desk_reconcile(desk_id: String) -> Result<ScanReport, String> {
    store()
        .reconcile_desk_from_disk(&desk_id)
        .map_err(|e| e.to_string())
}
