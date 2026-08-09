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

/// Open a folder as a desk and start watching it. A folder that is
/// already a desk is adopted, id and all (the handoff case: another
/// install, or the same folder seen from a second device through a sync
/// provider); a folder with no trace of a desk is initialised in place,
/// absorbing the files already inside it; a folder whose desk sidecars
/// haven't downloaded yet is neither — it errors, rather than starting a
/// rival desk over one that already exists. Either way a disk reconcile
/// runs so the folder's current contents surface immediately.
#[tauri::command]
pub fn desk_open_folder_as_desk(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    bookmark: Option<String>,
) -> Result<crate::desk_roots::OpenOutcome, String> {
    let s = store();
    let watch = bookmark.is_none();
    let outcome = s
        .open_folder_as_desk_detailed(Path::new(&path), bookmark)
        .map_err(|e| e.to_string())?;
    let desk_id = outcome.desk_id.clone();
    crate::activity_log::note(
        "desks",
        "info",
        format!(
            "{} folder as desk {} ({} file(s)): {}",
            if outcome.adopted { "Adopted" } else { "Initialised" },
            desk_id,
            outcome.absorbed,
            path
        ),
    );
    // Initialising a plain folder already absorbed its files; this pass
    // covers the adopt branch (refresh a handed-off desk against its
    // current folder contents) and seeds the rename-pairing hash cache.
    // Through the FileManager mutex like desk_reconcile, so it can't
    // interleave with a concurrent forest save.
    if let Err(e) = state.file_manager.lock().unwrap().reconcile_desk(&desk_id) {
        eprintln!("post-adopt reconcile failed for {}: {}", desk_id, e);
    }
    // The adopted desk may carry Google Doc links — fold them into the
    // app-wide cache so the link bar sees them immediately.
    crate::commands::google_docs::refresh_gdoc_link_cache(&state);
    if watch {
        if let Err(e) =
            state
                .desk_watch_manager
                .watch_path(app, &desk_id, Path::new(&path), "desk-changed")
        {
            eprintln!("desk watcher failed for {}: {}", desk_id, e);
        }
    }
    Ok(outcome)
}

/// Explicitly disconnect a local desk's folder — the delete-desk path.
/// `save_forest` deliberately never unregisters a root on its own (a
/// desk missing from one saved tree is indistinguishable from a stale
/// tree), so deletion calls this first; the folder itself is untouched.
#[tauri::command]
pub fn desk_unregister_root(state: State<AppState>, desk_id: String) -> Result<(), String> {
    state.desk_watch_manager.unwatch(&desk_id);
    crate::desk_roots::unregister(&crate::get_data_dir().join("desks"), &desk_id);
    Ok(())
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
/// counts so the frontend can skip refreshes on no-ops. Also refreshes
/// the app-wide Google-Doc-link cache — the desk's link sidecar may
/// have changed with the rest of the folder.
#[tauri::command]
pub fn desk_reconcile(state: State<AppState>, desk_id: String) -> Result<ScanReport, String> {
    // Through the FileManager mutex, NOT a free-standing store: the
    // reconciler rewrites the desk's tree.json, and racing a concurrent
    // save_file_tree (which rewrites every desk's) could re-apply a
    // pre-save snapshot — the seam that recorded one node under two
    // desks at once.
    let report = state
        .file_manager
        .lock()
        .unwrap()
        .reconcile_desk(&desk_id)
        .map_err(|e| e.to_string())?;
    crate::commands::google_docs::refresh_gdoc_link_cache(&state);
    Ok(report)
}

/// The desk's portable `meta` object from `.hushdesk` — style choice,
/// last-open file, desk stickies.
#[tauri::command]
pub fn desk_meta_get(desk_id: String) -> serde_json::Value {
    store().load_desk_meta(&desk_id)
}

/// Field-merge `patch` into the desk's `.hushdesk` meta (values stored
/// verbatim, null included).
#[tauri::command]
pub fn desk_meta_set(desk_id: String, patch: serde_json::Value) -> Result<(), String> {
    store()
        .merge_desk_meta(&desk_id, &patch)
        .map_err(|e| e.to_string())
}

// ===== Desk archives =====
// Archiving replaces deletion (see desk_archive.rs). The frontend drives
// the order deliberately: zip first, verify, *then* take the desk out of
// the app — so a failed archive can never cost the user a desk.

/// Zip a desk's folder into the internal archive. Leaves the desk alone.
#[tauri::command]
pub fn desk_archive(
    desk_id: String,
    desk_name: String,
) -> Result<crate::desk_archive::ArchiveInfo, String> {
    store()
        .archive_desk(&desk_id, &desk_name)
        .map_err(|e| e.to_string())
}

/// Remove an archived desk's live folder. A no-op for a local desk — the
/// archive copied that folder and it belongs to the user.
#[tauri::command]
pub fn desk_discard_archived(desk_id: String) -> Result<(), String> {
    store().discard_archived_desk(&desk_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desk_archives_list() -> Vec<crate::desk_archive::ArchiveInfo> {
    store().list_archives()
}

/// Build a brand-new desk from an archive. The restored desk gets fresh
/// ids throughout, so this is safe to run repeatedly and safe to run
/// beside the desk the archive was made from.
#[tauri::command]
pub fn desk_archive_restore(file: String) -> Result<String, String> {
    store().restore_archive(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desk_archive_delete(file: String) -> Result<(), String> {
    store().delete_archive(&file).map_err(|e| e.to_string())
}

/// The archive's bytes — the iPad share sheet needs them in hand.
/// Desktop shares by path through a save dialog and never calls this.
#[tauri::command]
pub fn desk_archive_bytes(file: String) -> Result<Vec<u8>, String> {
    store().read_archive(&file).map_err(|e| e.to_string())
}

// ===== Desk recovery snapshots =====
// Rolling automatic snapshots of local desks (see desk_recovery.rs). The
// scheduler runs in Rust; these commands are the surface for the
// Settings > Sync > Recovery tab.

/// Every recovery snapshot across every desk, newest first.
#[tauri::command]
pub fn desk_recovery_list() -> Vec<crate::desk_archive::ArchiveInfo> {
    store().list_recovery_snapshots()
}

#[tauri::command]
pub fn desk_recovery_delete(desk_id: String, file: String) -> Result<(), String> {
    store()
        .delete_recovery_snapshot(&desk_id, &file)
        .map_err(|e| e.to_string())
}

/// Build a brand-new internal desk named `new_name` from a snapshot —
/// fresh ids throughout, so it can sit beside the desk it came from and
/// the user's own folder is never written to. Returns the new desk id.
#[tauri::command]
pub fn desk_recovery_restore(
    desk_id: String,
    file: String,
    new_name: String,
) -> Result<String, String> {
    store()
        .restore_recovery_snapshot(&desk_id, &file, &new_name)
        .map_err(|e| e.to_string())
}
