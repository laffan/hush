// Multi-window Tauri commands. Window creation itself happens on the
// JS side via `WebviewWindow.new(...)` (mirroring how the settings
// window is opened) so we don't have to duplicate the geometry / chrome
// configuration in two places. The commands below own the cross-window
// registry: each window registers on startup, pushes its current file
// whenever it changes, and the sidebar listens to `windows-updated`
// to paint per-window numeral badges.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::multi_window::WindowInfo;
use crate::AppState;

/// Drop registry entries whose window is gone. Two passes:
///
///  1. Reconcile against `app.webview_windows()` — catches windows the
///     runtime knows are dead but whose destroy notification we missed
///     (a webview killed before its unload handler ran).
///  2. Mobile only: expire entries that stopped heartbeating. iPad
///     scene teardown can be entirely silent — no `Destroyed` event,
///     and the dead scene may even linger in the runtime's window list
///     — so age is the only trustworthy liveness signal there. The
///     10 s window is 2 missed beats of the JS side's 4 s heartbeat
///     plus slack; a scene the OS suspends (parked in the app switcher)
///     expires too, then re-registers the moment the user returns to
///     it. Kept tight so a freshly-registering window (the moment its
///     badge number is minted) counts as few dead siblings as possible.
fn prune_dead_windows(app: &AppHandle, state: &State<AppState>) {
    let alive: Vec<String> = app.webview_windows().keys().cloned().collect();
    let before = labels(&state.window_registry.list());
    state.window_registry.prune(&alive);
    #[cfg(mobile)]
    state
        .window_registry
        .prune_stale(std::time::Duration::from_secs(10));
    let after = labels(&state.window_registry.list());
    if after != before {
        // Which windows the registry believes in, and which the runtime
        // still holds, at the moment it changed its mind. On iPad these
        // two disagree routinely — that's what the age expiry is for —
        // and a registry that keeps expiring a window that is plainly
        // still on screen is a heartbeat that stopped running, which is
        // worth being able to see afterwards.
        crate::activity_log::note_detail(
            "window",
            "info",
            "Window registry pruned",
            serde_json::json!({ "before": before, "after": after, "runtime": alive }),
        );
    }
}

fn labels(list: &[WindowInfo]) -> Vec<String> {
    list.iter().map(|w| w.label.clone()).collect()
}

#[tauri::command]
pub fn list_windows(app: AppHandle, state: State<AppState>) -> Vec<WindowInfo> {
    prune_dead_windows(&app, &state);
    state.window_registry.list()
}

#[tauri::command]
pub fn register_window(
    app: AppHandle,
    state: State<AppState>,
    label: String,
) -> WindowInfo {
    prune_dead_windows(&app, &state);
    // Log only a label the registry hadn't seen — `registerThisWindow`
    // is also the re-assert on every foreground, and logging those would
    // bury the trail under one line per app switch.
    let fresh = !state
        .window_registry
        .list()
        .iter()
        .any(|w| w.label == label);
    let info = state.window_registry.ensure(&label);
    if fresh {
        crate::activity_log::note_detail(
            "window",
            "info",
            "Window registered",
            serde_json::json!({
                "label": label,
                "number": info.number,
                "windows": labels(&state.window_registry.list()),
            }),
        );
    }
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
    prune_dead_windows(&app, &state);
    // Register-if-missing so a resumed scene's file push can't be lost
    // to ordering (its entry may have been expired while it slept).
    state.window_registry.ensure(&label);
    state.window_registry.set_file(&label, file_id, file_type);
    let _ = app.emit("windows-updated", state.window_registry.list());
}

#[tauri::command]
pub fn unregister_window(app: AppHandle, state: State<AppState>, label: String) {
    state.window_registry.remove(&label);
    prune_dead_windows(&app, &state);
    crate::activity_log::note_detail(
        "window",
        "info",
        "Window unregistered",
        serde_json::json!({
            "label": label,
            "windows": labels(&state.window_registry.list()),
        }),
    );
    let _ = app.emit("windows-updated", state.window_registry.list());
}

/// Periodic liveness ping from each window's JS side. Refreshes the
/// caller's stamp, expires the dead, and — only when the visible list
/// actually changed — broadcasts `windows-updated`, so steady-state
/// heartbeats stay silent instead of re-rendering every sidebar each
/// beat. Returns true when the caller had been expired and was
/// re-registered (the JS side re-pushes its current file in response).
#[tauri::command]
pub fn window_heartbeat(app: AppHandle, state: State<AppState>, label: String) -> bool {
    let before = state.window_registry.list();
    let known = state.window_registry.touch(&label);
    if !known {
        state.window_registry.ensure(&label);
    }
    prune_dead_windows(&app, &state);
    let after = state.window_registry.list();
    if after != before {
        let _ = app.emit("windows-updated", after);
    }
    !known
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
