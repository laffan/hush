//! Debug-tab plumbing: the app activity log, the desk store's
//! self-description, and the repair / undelete affordances that go with
//! them.

use crate::activity_log::{self, ActivityEntry};
use crate::desk_rescue::{self, RepairReport};
use crate::desk_store::DeskStore;

fn store() -> DeskStore {
    DeskStore::new(&crate::get_data_dir())
}

fn desks_dir() -> std::path::PathBuf {
    crate::get_data_dir().join("desks")
}

/// Append a batch of entries. The frontend buffers and flushes, so this
/// is one IPC round trip per burst rather than per line.
#[tauri::command]
pub fn activity_log_append(entries: Vec<ActivityEntry>) -> Result<(), String> {
    activity_log::append(&entries).map_err(|e| e.to_string())
}

/// The most recent `limit` entries, oldest first (0 = everything).
#[tauri::command]
pub fn activity_log_read(limit: Option<usize>) -> Vec<ActivityEntry> {
    activity_log::read(limit.unwrap_or(0))
}

#[tauri::command]
pub fn activity_log_clear() -> Result<(), String> {
    activity_log::clear().map_err(|e| e.to_string())
}

/// What the desk store believes it holds — per-desk file counts, missing
/// files, ids claimed by two desks at once, retired folders.
#[tauri::command]
pub fn desk_store_diagnostics() -> serde_json::Value {
    store().store_diagnostics()
}

/// Put back files the tree still references but that resolve to nothing,
/// sourcing them from retired desk folders and orphan bins.
#[tauri::command]
pub fn desk_repair_files() -> Result<RepairReport, String> {
    let report = store().recover_desk_files().map_err(|e| e.to_string())?;
    activity_log::note(
        "desks",
        if report.broken > report.restored { "warn" } else { "info" },
        format!(
            "Desk repair: {} broken, {} restored, {} re-indexed",
            report.broken, report.restored, report.reindexed
        ),
    );
    Ok(report)
}

/// Move a desk's folder aside. The only path that retires a desk —
/// `save_forest` no longer infers deletion from a tree that lacks one.
#[tauri::command]
pub fn desk_retire(desk_id: String) -> Result<Option<String>, String> {
    let moved = store().retire_desk(&desk_id).map_err(|e| e.to_string())?;
    activity_log::note(
        "desks",
        "info",
        match &moved {
            Some(p) => format!("Retired desk {} to {}", desk_id, p.to_string_lossy()),
            None => format!("Desk {} needed no folder retirement (local or absent)", desk_id),
        },
    );
    Ok(moved.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn desk_list_retired() -> Vec<serde_json::Value> {
    desk_rescue::list_retired_desks(&desks_dir())
}

/// Move a retired desk folder back under `desks/`. The frontend reloads
/// the tree afterwards and the registry backfill picks it up.
#[tauri::command]
pub fn desk_restore_retired(folder: String) -> Result<String, String> {
    let id = desk_rescue::restore_retired_desk(&desks_dir(), &folder).map_err(|e| e.to_string())?;
    activity_log::note("desks", "info", format!("Restored retired desk {}", id));
    Ok(id)
}

/// The **native** build stamp, baked in by `build.rs`. The Debug tab shows
/// it beside the frontend's own stamp: on iPad the two are produced by
/// separate steps and a stale bundle paired with a fresh binary (or the
/// reverse) is exactly the kind of thing that makes a bug unreproducible.
#[tauri::command]
pub fn build_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "builtAt": option_env!("HUSH_BUILD_TIME").unwrap_or(""),
        "branch": option_env!("HUSH_GIT_BRANCH").unwrap_or(""),
        "commit": option_env!("HUSH_GIT_COMMIT").unwrap_or(""),
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "target": std::env::consts::OS,
        "dataDir": crate::get_data_dir().to_string_lossy(),
    })
}
