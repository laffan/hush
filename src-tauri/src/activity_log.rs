//! App activity log — a permanent, cross-window, cross-desk record of
//! what the app did and which subsystem did it.
//!
//! This is the developer-console equivalent the app never had: a browser
//! console dies with its webview, and Hush routinely runs several webviews
//! (main window, secondary windows, the settings window) plus Rust-side
//! work that no console ever sees. When a desk quietly reshapes itself
//! between launches there was no record of which pass touched it.
//!
//! Storage is one JSONL file, `{data_dir}/activity.log`, appended to and
//! trimmed to `MAX_ENTRIES` from the front. JSONL because a partial write
//! costs one line rather than the file, and because trimming is a
//! line-count operation with no parse of the payloads.
//!
//! Entries are written in batches (the frontend buffers and flushes) so a
//! busy pass costs one write, not one per line.

use crate::atomic::write_atomic_str;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

type BoxError = Box<dyn std::error::Error>;

/// Kept deliberately large — this is a diagnostic trail for problems that
/// surface days later, not a live tail. ~4k entries of ~200 bytes is well
/// under a megabyte.
const MAX_ENTRIES: usize = 4000;
/// Trim in blocks so a steady stream of writes doesn't rewrite the file
/// on every flush once the cap is reached.
const TRIM_SLACK: usize = 500;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Epoch milliseconds — formatted for display on the JS side so the
    /// viewer follows the user's locale.
    pub t: i64,
    /// "debug" | "info" | "warn" | "error".
    pub level: String,
    /// Subsystem that emitted it, e.g. "desks", "sync", "editor".
    pub source: String,
    /// Which window it came from ("main", "settings", a child label), so
    /// interleaved multi-window activity stays readable.
    #[serde(default)]
    pub window: String,
    /// The desk in view when it was emitted, when there was one.
    #[serde(default)]
    pub desk: String,
    pub message: String,
    /// Optional structured payload, already stringified by the caller.
    #[serde(default)]
    pub detail: String,
}

fn log_path() -> PathBuf {
    crate::get_data_dir().join("activity.log")
}

/// Append entries, trimming the file when it outgrows the cap.
pub fn append(entries: &[ActivityEntry]) -> Result<(), BoxError> {
    if entries.is_empty() {
        return Ok(());
    }
    let path = log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut buf = String::new();
    for entry in entries {
        buf.push_str(&serde_json::to_string(entry)?);
        buf.push('\n');
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    file.write_all(buf.as_bytes())?;
    drop(file);

    // Cheap length check, then a single rewrite when we're over.
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() > MAX_ENTRIES + TRIM_SLACK {
        let keep = &lines[lines.len() - MAX_ENTRIES..];
        write_atomic_str(&path, &(keep.join("\n") + "\n"))?;
    }
    Ok(())
}

/// The most recent `limit` entries, oldest first. `limit` of 0 reads all.
pub fn read(limit: usize) -> Vec<ActivityEntry> {
    let raw = fs::read_to_string(log_path()).unwrap_or_default();
    let lines: Vec<&str> = raw.lines().collect();
    let start = if limit > 0 && lines.len() > limit {
        lines.len() - limit
    } else {
        0
    };
    lines[start..]
        .iter()
        .filter_map(|l| serde_json::from_str::<ActivityEntry>(l).ok())
        .collect()
}

pub fn clear() -> Result<(), BoxError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = log_path();
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Log from Rust. Fire-and-forget: diagnostics must never be able to fail
/// the operation they were describing.
pub fn note(source: &str, level: &str, message: impl Into<String>) {
    let entry = ActivityEntry {
        t: chrono::Utc::now().timestamp_millis(),
        level: level.to_string(),
        source: source.to_string(),
        window: "rust".to_string(),
        desk: String::new(),
        message: message.into(),
        detail: String::new(),
    };
    let _ = append(&[entry]);
}

/// Same, with a structured payload. `detail` is serialised here rather
/// than by the caller so a log line costs one `json!` at the call site.
/// Silently drops an unserialisable payload — see `note`.
pub fn note_detail(source: &str, level: &str, message: impl Into<String>, detail: serde_json::Value) {
    let entry = ActivityEntry {
        t: chrono::Utc::now().timestamp_millis(),
        level: level.to_string(),
        source: source.to_string(),
        window: "rust".to_string(),
        desk: String::new(),
        message: message.into(),
        detail: serde_json::to_string(&detail).unwrap_or_default(),
    };
    let _ = append(&[entry]);
}
