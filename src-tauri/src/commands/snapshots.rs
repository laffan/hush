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
) -> Result<i64, String> {
    state.snapshot_manager.lock().unwrap()
        .create_snapshot(&document_id, &content)
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
