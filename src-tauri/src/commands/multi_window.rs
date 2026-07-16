// Multi-window Tauri commands. Window creation itself happens on the
// JS side via `WebviewWindow.new(...)` (mirroring how the settings
// window is opened) so we don't have to duplicate the geometry / chrome
// configuration in two places. The commands below own the cross-window
// registry: each window registers on startup, pushes its current file
// whenever it changes, and the sidebar listens to `windows-updated`
// to paint per-window numeral badges.

use tauri::{AppHandle, Emitter, State};

use crate::multi_window::WindowInfo;
use crate::AppState;

#[tauri::command]
pub fn list_windows(state: State<AppState>) -> Vec<WindowInfo> {
    state.window_registry.list()
}

#[tauri::command]
pub fn register_window(
    app: AppHandle,
    state: State<AppState>,
    label: String,
) -> WindowInfo {
    let info = state.window_registry.ensure(&label);
    let _ = app.emit("windows-updated", state.window_registry.list());
    info
}

#[tauri::command]
pub fn set_window_file(
    app: AppHandle,
    state: State<AppState>,
    label: String,
    file_id: Option<String>,
    file_type: Option<String>,
) {
    state.window_registry.set_file(&label, file_id, file_type);
    let _ = app.emit("windows-updated", state.window_registry.list());
}

#[tauri::command]
pub fn unregister_window(app: AppHandle, state: State<AppState>, label: String) {
    state.window_registry.remove(&label);
    let _ = app.emit("windows-updated", state.window_registry.list());
}

/// Broadcast a generic "the file tree / settings changed in some other
/// window" pulse so siblings can re-fetch and refresh. The JS side calls
/// this after any local mutation that other windows need to mirror — far
/// simpler than wiring a per-mutation event for each command. The
/// `originator` label is included in the payload so the calling window
/// can ignore its own echo.
#[tauri::command]
pub fn broadcast_state_change(
    app: AppHandle,
    kind: String,
    originator: String,
) -> Result<(), String> {
    app.emit(
        "cross-window-state-changed",
        serde_json::json!({ "kind": kind, "originator": originator }),
    )
    .map_err(|e| e.to_string())
}

/// Broadcast a live document edit to every other window. Receivers
/// whose currently-open doc matches `file_id` apply `content` to their
/// editor in place so the user sees the same buffer in both windows
/// without waiting for the autosave round-trip.
#[tauri::command]
pub fn broadcast_doc_changed(
    app: AppHandle,
    file_id: String,
    content: String,
    originator: String,
) -> Result<(), String> {
    app.emit(
        "cross-window-doc-changed",
        serde_json::json!({
            "fileId": file_id,
            "content": content,
            "originator": originator,
        }),
    )
    .map_err(|e| e.to_string())
}

/// Broadcast a notebook save so other windows showing the same notebook
/// can reload it FROM DISK. Deliberately id-only: the envelope is
/// multi-MB for stroke-heavy notebooks, and shipping it through the
/// invoke marshal + event fan-out froze the saving window's webview for
/// the marshal duration on every autosave — and every receiver
/// (including the originator's own echo) paid a full parse before the
/// originator filter even ran. The save completed before the broadcast
/// fired, so disk is always authoritative by the time receivers read.
#[tauri::command]
pub fn broadcast_notebook_changed(
    app: AppHandle,
    file_id: String,
    originator: String,
) -> Result<(), String> {
    app.emit(
        "cross-window-notebook-changed",
        serde_json::json!({
            "fileId": file_id,
            "originator": originator,
        }),
    )
    .map_err(|e| e.to_string())
}
