//! Version history — one file per snapshot, stored inside the desk.
//!
//! Phase 2 of LOCAL-DESKS-PLANNING.md. Snapshots live at
//! `{desk}/.hush/versions/<fileId>/<createdAtMs>-<deviceId>.snap` — plain
//! bytes (doc markdown / notebook envelope JSON), append-only, and
//! device-suffixed so two devices writing into a shared desk folder can
//! never contend over the same file. That replaces the central
//! `snapshots.db` SQLite store, which was both machine-local (history
//! didn't travel with a desk) and a corruption hazard inside any folder a
//! file-sync provider touches.
//!
//! The command surface is unchanged: `create_snapshot` /
//! `get_snapshots` / `get_snapshot` / `delete_document_snapshots`, ids
//! remain i64 (now the snapshot's created-at in milliseconds, unique per
//! document directory). The decay/prune policy: keep everything for
//! 5 min, then 1/min to 2 h, 1/10 min to 24 h, 1/hour to 7 days,
//! 1/day beyond.
//!
//! Snapshots for a file that hasn't been placed in a desk yet (staged
//! ids) land under `desks/.versions-unplaced/<fileId>/`; reads aggregate
//! across every desk plus that fallback, so history survives moves.

use crate::atomic::write_atomic;
use crate::desk_store::DeskStore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: i64,
    pub document_id: String,
    pub content: String,
    pub created_at: i64, // unix seconds (display granularity)
}

pub struct SnapshotManager {
    store: DeskStore,
    device_id: String,
}

impl SnapshotManager {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            store: DeskStore::new(data_dir),
            device_id: load_device_id(data_dir),
        }
    }

    fn unplaced_dir(&self, document_id: &str) -> PathBuf {
        self.store
            .desks_dir
            .join(".versions-unplaced")
            .join(sanitize_id(document_id))
    }

    /// Directory new snapshots land in: the file's current desk, else the
    /// unplaced fallback.
    fn write_dir(&self, document_id: &str) -> PathBuf {
        if let Some((desk_id, _rel)) = self.store.locate(document_id) {
            return self
                .store
                .desk_dir(&desk_id)
                .join(".hush")
                .join("versions")
                .join(sanitize_id(document_id));
        }
        self.unplaced_dir(document_id)
    }

    /// Every directory that may hold this document's snapshots.
    fn read_dirs(&self, document_id: &str) -> Vec<PathBuf> {
        let id = sanitize_id(document_id);
        let mut out = Vec::new();
        for desk_id in self.store.desk_ids_on_disk() {
            let dir = self
                .store
                .desk_dir(&desk_id)
                .join(".hush")
                .join("versions")
                .join(&id);
            if dir.is_dir() {
                out.push(dir);
            }
        }
        let unplaced = self.unplaced_dir(document_id);
        if unplaced.is_dir() {
            out.push(unplaced);
        }
        out
    }

    pub fn create_snapshot(&self, document_id: &str, content: &str) -> Result<i64, BoxError> {
        let dir = self.write_dir(document_id);
        fs::create_dir_all(&dir)?;
        // Milliseconds as the id; bump until unique within this doc's dir
        // (a doc can snapshot twice in one tick).
        let mut ms = now_ms();
        loop {
            let path = dir.join(format!("{}-{}.snap", ms, self.device_id));
            if !path.exists() {
                write_atomic(&path, content.as_bytes())?;
                break;
            }
            ms += 1;
        }
        self.prune_dir(&dir);
        Ok(ms)
    }

    pub fn get_snapshots(&self, document_id: &str) -> Result<Vec<SnapshotEntry>, BoxError> {
        let mut entries = Vec::new();
        for dir in self.read_dirs(document_id) {
            for (path, ms) in list_snaps(&dir) {
                let Ok(content) = fs::read_to_string(&path) else { continue };
                entries.push(SnapshotEntry {
                    id: ms,
                    document_id: document_id.to_string(),
                    content,
                    created_at: ms / 1000,
                });
            }
        }
        entries.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(entries)
    }

    pub fn get_snapshot(&self, id: i64) -> Result<SnapshotEntry, BoxError> {
        // Ids carry no document pointer (legacy autoincrement semantics),
        // so scan every versions dir for the matching timestamp prefix.
        for desk_id in self.store.desk_ids_on_disk() {
            let root = self.store.desk_dir(&desk_id).join(".hush").join("versions");
            if let Some(e) = find_snap_in(&root, id) {
                return Ok(e);
            }
        }
        if let Some(e) = find_snap_in(&self.store.desks_dir.join(".versions-unplaced"), id) {
            return Ok(e);
        }
        Err(format!("snapshot not found: {}", id).into())
    }

    pub fn delete_document_snapshots(&self, document_id: &str) -> Result<(), BoxError> {
        for dir in self.read_dirs(document_id) {
            let _ = fs::remove_dir_all(&dir);
        }
        Ok(())
    }

    /// Startup sweep: apply the decay policy to every document's history.
    pub fn cleanup_all(&self) -> Result<u64, BoxError> {
        let mut total = 0u64;
        let mut roots: Vec<PathBuf> = self
            .store
            .desk_ids_on_disk()
            .iter()
            .map(|d| self.store.desk_dir(d).join(".hush").join("versions"))
            .collect();
        roots.push(self.store.desks_dir.join(".versions-unplaced"));
        for root in roots {
            let Ok(rd) = fs::read_dir(&root) else { continue };
            for entry in rd.flatten() {
                if entry.path().is_dir() {
                    total += self.prune_dir(&entry.path());
                }
            }
        }
        Ok(total)
    }

    /// Thin one document's snapshot directory per the decay policy.
    /// Returns how many snapshots were removed.
    fn prune_dir(&self, dir: &Path) -> u64 {
        let mut snaps: Vec<(PathBuf, i64)> = list_snaps(dir);
        // Newest first, timestamps in seconds for the window math.
        snaps.sort_by(|a, b| b.1.cmp(&a.1));
        let secs: Vec<(usize, i64)> = snaps
            .iter()
            .enumerate()
            .map(|(i, (_, ms))| (i, ms / 1000))
            .collect();

        let now = now_ms() / 1000;
        // Keep-all window is 5 minutes. It was 30, but notebooks used
        // to snapshot on every 2-second autosave — a long writing
        // session accumulated hundreds of multi-MB copies before the
        // thinning even started. Notebook snapshots are now throttled
        // client-side too (see notebook-bridge.js); the tighter window
        // keeps doc-side bursts from piling up the same way.
        let five_min = now - 5 * 60;
        let two_hours = now - 2 * 60 * 60;
        let twenty_four_hours = now - 24 * 60 * 60;
        let seven_days = now - 7 * 24 * 60 * 60;

        let mut doomed: Vec<usize> = Vec::new();
        doomed.extend(thin_window(&secs, two_hours, five_min, 60));
        doomed.extend(thin_window(&secs, twenty_four_hours, two_hours, 600));
        doomed.extend(thin_window(&secs, seven_days, twenty_four_hours, 3600));
        doomed.extend(thin_window(&secs, 0, seven_days, 86400));

        let count = doomed.len() as u64;
        for idx in doomed {
            let _ = fs::remove_file(&snaps[idx].0);
        }
        count
    }
}

/// `(index, seconds)` pairs → indices to delete, keeping the newest entry
/// per `bucket_size`-second bucket inside `[window_start, window_end)`.
fn thin_window(entries: &[(usize, i64)], window_start: i64, window_end: i64, bucket_size: i64) -> Vec<usize> {
    let mut buckets: std::collections::HashMap<i64, Vec<(usize, i64)>> =
        std::collections::HashMap::new();
    for (idx, ts) in entries {
        if *ts >= window_start && *ts < window_end {
            buckets.entry(ts / bucket_size).or_default().push((*idx, *ts));
        }
    }
    let mut doomed = Vec::new();
    for (_, mut bucket) in buckets {
        bucket.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
        for (idx, _) in bucket.into_iter().skip(1) {
            doomed.push(idx);
        }
    }
    doomed
}

/// `(path, createdAtMs)` for every `.snap` in a directory.
fn list_snaps(dir: &Path) -> Vec<(PathBuf, i64)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("snap") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let ms_part = stem.split('-').next().unwrap_or("");
        if let Ok(ms) = ms_part.parse::<i64>() {
            out.push((path, ms));
        }
    }
    out
}

fn find_snap_in(root: &Path, id: i64) -> Option<SnapshotEntry> {
    let rd = fs::read_dir(root).ok()?;
    for doc_dir in rd.flatten() {
        if !doc_dir.path().is_dir() {
            continue;
        }
        for (path, ms) in list_snaps(&doc_dir.path()) {
            if ms == id {
                let content = fs::read_to_string(&path).ok()?;
                return Some(SnapshotEntry {
                    id: ms,
                    document_id: doc_dir.file_name().to_string_lossy().into_owned(),
                    content,
                    created_at: ms / 1000,
                });
            }
        }
    }
    None
}

/// FileIds are uuids / filenames; keep the directory name safe anyway.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stable per-install id used to suffix snapshot filenames so two devices
/// writing into a shared desk folder never contend. Persisted at
/// `{data_dir}/device_id`.
pub fn load_device_id(data_dir: &Path) -> String {
    let path = data_dir.join("device_id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let fresh: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let _ = fs::write(&path, &fresh);
    fresh
}

// ===== One-shot migration from snapshots.db =====

/// Move every row of the legacy SQLite store into per-desk snapshot
/// files, then rename the database so this never runs again. Returns the
/// number of snapshots migrated.
pub fn migrate_snapshots_db(data_dir: &Path) -> Result<u64, BoxError> {
    let db_path = data_dir.join("snapshots.db");
    if !db_path.exists() {
        return Ok(0);
    }
    let manager = SnapshotManager::new(data_dir);
    let conn = rusqlite::Connection::open(&db_path)?;
    let mut moved = 0u64;
    {
        let mut stmt = conn.prepare(
            "SELECT document_id, content, created_at FROM snapshots ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows.flatten() {
            let (doc_id, content, created_at) = row;
            let dir = manager.write_dir(&doc_id);
            if fs::create_dir_all(&dir).is_err() {
                continue;
            }
            // Legacy timestamps are seconds; bump within the ms space on
            // same-second collisions.
            let mut ms = created_at * 1000;
            loop {
                let path = dir.join(format!("{}-{}.snap", ms, manager.device_id));
                if !path.exists() {
                    if write_atomic(&path, content.as_bytes()).is_ok() {
                        moved += 1;
                    }
                    break;
                }
                ms += 1;
            }
        }
    }
    drop(conn);
    let _ = fs::rename(&db_path, data_dir.join("snapshots.db.pre-desks.bak"));
    let journal = data_dir.join("snapshots.db-journal");
    if journal.exists() {
        let _ = fs::rename(&journal, data_dir.join("snapshots.db-journal.pre-desks.bak"));
    }
    eprintln!("snapshot migration: {} snapshots moved into desk folders", moved);
    Ok(moved)
}

#[cfg(test)]
#[path = "snapshots_tests.rs"]
mod tests;
