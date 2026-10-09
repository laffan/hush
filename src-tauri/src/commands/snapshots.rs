use tauri::State;

use crate::snapshots::SnapshotEntry;
use crate::AppState;

// Async for the same reason as `save_file`: a version snapshot writes
// the full notebook envelope (multi-MB in long handwriting sessions)
// plus a prune pass; as a sync command that blocked the main thread —
// and the webview — for the duration.
#[tauri::command]
pub async fn create_snapshot(
    state: State<'_, AppState>,
    document_id: String,
    content: String,
    major: Option<bool>,
) -> Result<i64, String> {
    state.snapshot_manager.lock().unwrap()
        .create_snapshot_marked(&document_id, &content, major.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// Mark or unmark a snapshot as a major version (kept out of the decay).
#[tauri::command]
pub fn set_snapshot_major(
    state: State<AppState>,
    document_id: String,
    id: i64,
    major: bool,
) -> Result<(), String> {
    state.snapshot_manager.lock().unwrap()
        .set_snapshot_major(&document_id, id, major)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_snapshots(
    state: State<AppState>,
    document_id: String,
) -> Result<Vec<SnapshotEntry>, String> {
    state.snapshot_manager.lock().unwrap()
        .get_snapshots(&document_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_snapshot(state: State<AppState>, id: i64) -> Result<SnapshotEntry, String> {
    state.snapshot_manager.lock().unwrap()
        .get_snapshot(id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_document_snapshots(
    state: State<AppState>,
    document_id: String,
) -> Result<(), String> {
    state.snapshot_manager.lock().unwrap()
        .delete_document_snapshots(&document_id)
        .map_err(|e| e.to_string())
}

/// Words added per day — per file and section — over a run of days,
/// read out of version history (see `crate::progress`). Off the main
/// thread: it lists every requested document's snapshots and reads and
/// diffs the ones that fall on day boundaries.
#[tauri::command]
pub async fn writing_progress(
    request: crate::progress::ProgressRequest,
) -> Result<Vec<crate::progress::DayProgress>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = crate::get_data_dir();
        let store = crate::desk_store::DeskStore::new(&data_dir);
        let snaps = crate::snapshots::SnapshotManager::new(&data_dir);
        crate::progress::writing_progress(&store, &snaps, &request)
    })
    .await
    .map_err(|e| e.to_string())
}
