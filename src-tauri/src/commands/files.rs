use serde::Serialize;
use tauri::State;

use crate::{AppState, FileEntry, TreeNode};

#[tauri::command]
// Async: reads every file in the library (inflating each `.hushnote`
// zip on the way up) — as a sync command that whole-library scan ran on
// the main thread and froze the webview for its full duration.
pub async fn list_files(state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().list_files().map_err(|e| e.to_string())
}

#[tauri::command]
// Async: reading a large `.hushnote` inflates the zip on the way up —
// keep that off the main thread too (see save_file below).
pub async fn load_file(state: State<'_, AppState>, id: String) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().load_file(&id).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAvailability {
    /// `"ready"` | `"awaiting-download"` | `"missing"`.
    pub state: String,
    /// Absolute path, when the file is placed — what the frontend hands
    /// the provider to ask for a download.
    pub path: Option<String>,
}

/// Are this file's bytes on the device? A `stat`, not a read, so the
/// open path can ask before mounting something multi-megabyte, and so a
/// file the provider hasn't delivered can be waited for rather than
/// reported as content loss. See `state/open-file-wait.js`.
#[tauri::command]
pub fn file_availability(state: State<AppState>, id: String) -> FileAvailability {
    let (s, path) = state.file_manager.lock().unwrap().availability(&id);
    FileAvailability { state: s.to_string(), path }
}

// Async so the write runs on the async runtime's worker pool instead of
// the main thread. Notebook autosave ships the full multi-MB envelope
// every couple of seconds, and for `.hushnote` files the store deflates
// it into a zip on the way down — as a sync command that work froze the
// webview for the whole write (frame stalls exactly matching the save
// duration in stroke-heavy sessions).
#[tauri::command]
pub async fn save_file(state: State<'_, AppState>, id: String, content: String) -> Result<(), String> {
    let fm = state.file_manager.lock().unwrap();
    fm.save_file(&id, &content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Raw-body variant of `save_file` for large payloads (notebook
/// autosave). A JSON-args invoke pays a `JSON.stringify` of the whole
/// content on the webview's JS thread — escaping a multi-MB JSON string
/// costs hundreds of milliseconds and starved pointer events mid-write.
/// A raw byte body rides the IPC custom protocol untouched (the JS side
/// only pays a `TextEncoder.encode`). The file id and the optional
/// fold-in version snapshot arrive as headers so a snapshot-earning
/// save is ONE invoke instead of marshalling the same payload twice.
#[tauri::command]
pub async fn save_file_raw(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_file_raw expects a raw request body".into());
    };
    let id = request
        .headers()
        .get("file-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("save_file_raw: missing file-id header")?
        .to_string();
    let with_snapshot = request
        .headers()
        .get("with-snapshot")
        .and_then(|v| v.to_str().ok())
        == Some("1");
    let content = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    state
        .file_manager
        .lock()
        .unwrap()
        .save_file(&id, content)
        .map_err(|e| e.to_string())?;
    if with_snapshot {
        state
            .snapshot_manager
            .lock()
            .unwrap()
            .create_snapshot(&id, content)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
// Async: on the Cmd+N critical path — the staging write is small, but
// even small IO doesn't belong on the webview's main thread.
pub async fn create_file(state: State<'_, AppState>) -> Result<FileEntry, String> {
    state.file_manager.lock().unwrap().create_file().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file(state: State<AppState>, id: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().delete_file(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_file(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    state.file_manager.lock().unwrap().rename_file(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_tree(state: State<AppState>) -> Result<Vec<TreeNode>, String> {
    state.file_manager.lock().unwrap().get_file_tree().map_err(|e| e.to_string())
}

#[tauri::command]
// Async: a tree save reconciles every desk folder (placements, index +
// tree + meta writes, empty-dir pruning) — main-thread IO of that size
// stalled the webview on every create/move/rename, worst on iPad.
// Returns the repaired forest (or null) — the frontend adopts it so a
// window never keeps re-saving a shape the store had to fix.
pub async fn save_file_tree(
    state: State<'_, AppState>,
    tree: Vec<TreeNode>,
) -> Result<Option<Vec<TreeNode>>, String> {
    state.file_manager.lock().unwrap().save_file_tree(&tree).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_folder(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_project(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<TreeNode, String> {
    state.file_manager.lock().unwrap().create_project(&name, parent_id.as_deref()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCreated {
    node: TreeNode,
    file: FileEntry,
}

#[tauri::command]
pub fn create_notebook(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<NotebookCreated, String> {
    let (node, file) = state.file_manager.lock().unwrap()
        .create_notebook(&name, parent_id.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(NotebookCreated { node, file })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackCreated {
    node: TreeNode,
    file: FileEntry,
}

#[tauri::command]
pub fn create_stack(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<StackCreated, String> {
    let (node, file) = state.file_manager.lock().unwrap()
        .create_stack(&name, parent_id.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(StackCreated { node, file })
}

#[tauri::command]
pub fn load_project_content(state: State<AppState>, project_id: String) -> Result<Vec<FileEntry>, String> {
    state.file_manager.lock().unwrap().load_project_content(&project_id).map_err(|e| e.to_string())
}
