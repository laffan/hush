//! SQLite-backed persistence for the sync layer.
//!
//! Owns four tables:
//!   * `synced_files`     — per-file mapping (internal_id ↔ remote_id ↔ path).
//!                          `remote_id` and `last_known_rev` are empty until
//!                          backfilled from Dropbox; legacy entries migrated
//!                          from `sync_map.json` start that way.
//!   * `dropbox_cursor`   — `/list_folder/continue` cursor per sync folder.
//!   * `pending_ops`      — durable operation log for renames/deletes/creates
//!                          that need to be replayed against Dropbox.
//!   * `sync_orphans`     — entries set aside during migration when two
//!                          internal_ids mapped to the same external path
//!                          (the duplication bug at rest). Surfaced in the
//!                          UI for manual review; never auto-resolved.
//!
//! Connections are opened per-call (same pattern as `SnapshotManager`); the
//! outer `Mutex<SyncManager>` in `AppState` provides serialization.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::sync::{PendingOp, SyncedFileInfo};

pub struct SyncDb {
    db_path: PathBuf,
}

impl SyncDb {
    pub fn new(data_dir: &Path) -> Self {
        let db_path = data_dir.join("sync.db");
        let db = Self { db_path };
        db.init_schema().expect("init sync.db schema");
        db
    }

    fn connect(&self) -> Result<Connection, rusqlite::Error> {
        Connection::open(&self.db_path)
    }

    fn init_schema(&self) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS synced_files (
                internal_id      TEXT PRIMARY KEY,
                sync_folder_id   TEXT NOT NULL,
                relative_path    TEXT NOT NULL,
                last_synced_hash TEXT NOT NULL DEFAULT '',
                last_synced_at   INTEGER NOT NULL DEFAULT 0,
                remote_id        TEXT NOT NULL DEFAULT '',
                last_known_rev   TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_synced_files_remote_id
                ON synced_files(remote_id);
            CREATE INDEX IF NOT EXISTS idx_synced_files_path
                ON synced_files(sync_folder_id, relative_path);

            CREATE TABLE IF NOT EXISTS dropbox_cursor (
                sync_folder_id TEXT PRIMARY KEY,
                cursor         TEXT NOT NULL,
                root_path      TEXT NOT NULL,
                updated_at     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pending_ops (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                kind        TEXT NOT NULL,
                internal_id TEXT,
                remote_id   TEXT,
                path        TEXT NOT NULL,
                new_path    TEXT,
                payload     TEXT,
                created_at  INTEGER NOT NULL,
                attempts    INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pending_ops_created
                ON pending_ops(created_at);

            CREATE TABLE IF NOT EXISTS sync_orphans (
                internal_id    TEXT PRIMARY KEY,
                sync_folder_id TEXT NOT NULL,
                relative_path  TEXT NOT NULL,
                last_synced_at INTEGER NOT NULL,
                discovered_at  INTEGER NOT NULL,
                reason         TEXT NOT NULL
            );",
        )?;
        Ok(())
    }

    // ===== synced_files =====

    pub fn upsert_file(&self, info: &SyncedFileInfo) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO synced_files (
                internal_id, sync_folder_id, relative_path,
                last_synced_hash, last_synced_at, remote_id, last_known_rev
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(internal_id) DO UPDATE SET
                sync_folder_id   = excluded.sync_folder_id,
                relative_path    = excluded.relative_path,
                last_synced_hash = excluded.last_synced_hash,
                last_synced_at   = excluded.last_synced_at,
                remote_id        = excluded.remote_id,
                last_known_rev   = excluded.last_known_rev",
            params![
                info.internal_id,
                info.sync_folder_id,
                info.relative_path,
                info.last_synced_hash,
                info.last_synced_at,
                info.remote_id,
                info.last_known_rev,
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, internal_id: &str) -> Result<Option<SyncedFileInfo>, rusqlite::Error> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT internal_id, sync_folder_id, relative_path,
                    last_synced_hash, last_synced_at, remote_id, last_known_rev
             FROM synced_files WHERE internal_id = ?1",
            params![internal_id],
            row_to_info,
        )
        .optional()
    }

    pub fn list_folder(&self, sync_folder_id: &str) -> Result<Vec<SyncedFileInfo>, rusqlite::Error> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT internal_id, sync_folder_id, relative_path,
                    last_synced_hash, last_synced_at, remote_id, last_known_rev
             FROM synced_files WHERE sync_folder_id = ?1",
        )?;
        let rows = stmt.query_map(params![sync_folder_id], row_to_info)?;
        rows.collect()
    }

    #[allow(dead_code)] // used by Stage 3 (cursor backfill)
    pub fn list_all(&self) -> Result<Vec<SyncedFileInfo>, rusqlite::Error> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT internal_id, sync_folder_id, relative_path,
                    last_synced_hash, last_synced_at, remote_id, last_known_rev
             FROM synced_files",
        )?;
        let rows = stmt.query_map([], row_to_info)?;
        rows.collect()
    }

    pub fn delete(&self, internal_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM synced_files WHERE internal_id = ?1",
            params![internal_id],
        )?;
        Ok(())
    }

    pub fn delete_folder(&self, sync_folder_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM synced_files WHERE sync_folder_id = ?1",
            params![sync_folder_id],
        )?;
        Ok(())
    }

    /// Wipe every synced-file row, every cursor, and every queued
    /// pending op. Used by the "Clear local versions" recovery flow —
    /// the next sync poll reseeds from Dropbox as if the device were
    /// fresh-installed.
    pub fn clear_all(&self) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM synced_files", [])?;
        conn.execute("DELETE FROM dropbox_cursor", [])?;
        conn.execute("DELETE FROM pending_ops", [])?;
        Ok(())
    }

    pub fn update_path(&self, internal_id: &str, new_path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE synced_files SET relative_path = ?1 WHERE internal_id = ?2",
            params![new_path, internal_id],
        )?;
        Ok(())
    }

    pub fn update_hash(
        &self,
        internal_id: &str,
        hash: &str,
        synced_at: i64,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE synced_files SET last_synced_hash = ?1, last_synced_at = ?2
             WHERE internal_id = ?3",
            params![hash, synced_at, internal_id],
        )?;
        Ok(())
    }

    /// Update every entry whose `relative_path` starts with `old_prefix`,
    /// rewriting that prefix to `new_prefix`. Used for directory rename.
    pub fn rename_prefix(
        &self,
        sync_folder_id: &str,
        old_prefix: &str,
        new_prefix: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        let pattern = format!("{}%", escape_like(old_prefix));
        // SQLite SUBSTR is 1-indexed; +1 means "skip past the prefix".
        conn.execute(
            "UPDATE synced_files
             SET relative_path = ?1 || SUBSTR(relative_path, ?2)
             WHERE sync_folder_id = ?3 AND relative_path LIKE ?4 ESCAPE '\\'",
            params![
                new_prefix,
                old_prefix.len() as i64 + 1,
                sync_folder_id,
                pattern
            ],
        )?;
        Ok(())
    }

    /// Delete every entry whose `relative_path` starts with `prefix`.
    pub fn delete_prefix(
        &self,
        sync_folder_id: &str,
        prefix: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        let pattern = format!("{}%", escape_like(prefix));
        conn.execute(
            "DELETE FROM synced_files
             WHERE sync_folder_id = ?1 AND relative_path LIKE ?2 ESCAPE '\\'",
            params![sync_folder_id, pattern],
        )?;
        Ok(())
    }

    // ===== Lookups for cursor consumer =====

    /// Find a synced file by Dropbox `id`. Empty `remote_id` is never a
    /// match — that's the sentinel for "not yet backfilled".
    pub fn find_by_remote_id(&self, remote_id: &str) -> Result<Option<SyncedFileInfo>, rusqlite::Error> {
        if remote_id.is_empty() {
            return Ok(None);
        }
        let conn = self.connect()?;
        conn.query_row(
            "SELECT internal_id, sync_folder_id, relative_path,
                    last_synced_hash, last_synced_at, remote_id, last_known_rev
             FROM synced_files WHERE remote_id = ?1",
            params![remote_id],
            row_to_info,
        )
        .optional()
    }

    /// Case-insensitive path lookup. Dropbox `deleted` events only carry
    /// `path_lower`, so the cursor consumer can't match by exact case.
    pub fn find_by_path_ci(
        &self,
        sync_folder_id: &str,
        relative_path: &str,
    ) -> Result<Option<SyncedFileInfo>, rusqlite::Error> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT internal_id, sync_folder_id, relative_path,
                    last_synced_hash, last_synced_at, remote_id, last_known_rev
             FROM synced_files
             WHERE sync_folder_id = ?1 AND LOWER(relative_path) = LOWER(?2)
             LIMIT 1",
            params![sync_folder_id, relative_path],
            row_to_info,
        )
        .optional()
    }

    /// Backfill `remote_id` and `last_known_rev` on a legacy entry.
    pub fn backfill_remote_id(
        &self,
        internal_id: &str,
        remote_id: &str,
        rev: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE synced_files
             SET remote_id = ?1, last_known_rev = ?2
             WHERE internal_id = ?3",
            params![remote_id, rev, internal_id],
        )?;
        Ok(())
    }

    /// Update both content hash and last_known_rev together. Used after a
    /// successful upload (rev = response rev) and after a successful pull
    /// (rev = entry's rev from the cursor delta).
    pub fn update_sync_state(
        &self,
        internal_id: &str,
        hash: &str,
        rev: &str,
        synced_at: i64,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE synced_files
             SET last_synced_hash = ?1, last_synced_at = ?2, last_known_rev = ?3
             WHERE internal_id = ?4",
            params![hash, synced_at, rev, internal_id],
        )?;
        Ok(())
    }

    // ===== dropbox_cursor =====

    pub fn get_cursor(&self, sync_folder_id: &str) -> Result<Option<(String, String)>, rusqlite::Error> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT cursor, root_path FROM dropbox_cursor WHERE sync_folder_id = ?1",
            params![sync_folder_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
    }

    pub fn set_cursor(
        &self,
        sync_folder_id: &str,
        cursor: &str,
        root_path: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO dropbox_cursor (sync_folder_id, cursor, root_path, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(sync_folder_id) DO UPDATE SET
                cursor = excluded.cursor,
                root_path = excluded.root_path,
                updated_at = excluded.updated_at",
            params![sync_folder_id, cursor, root_path, now],
        )?;
        Ok(())
    }

    pub fn clear_cursor(&self, sync_folder_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM dropbox_cursor WHERE sync_folder_id = ?1",
            params![sync_folder_id],
        )?;
        Ok(())
    }

    // ===== pending_ops =====

    /// Append a pending op. Returns the new row id.
    pub fn enqueue_op(&self, op: &PendingOp) -> Result<i64, rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO pending_ops
             (kind, internal_id, remote_id, path, new_path, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                op.kind,
                op.internal_id,
                op.remote_id,
                op.path,
                op.new_path,
                op.payload,
                op.created_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Look at the next batch of pending ops in insertion order. Caller is
    /// responsible for executing them sequentially and reporting outcome
    /// via `op_succeeded` / `op_failed`.
    pub fn peek_ops(&self, limit: usize) -> Result<Vec<PendingOp>, rusqlite::Error> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, kind, internal_id, remote_id, path, new_path, payload,
                    created_at, attempts, last_error
             FROM pending_ops
             ORDER BY id ASC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(PendingOp {
                id: row.get(0)?,
                kind: row.get(1)?,
                internal_id: row.get(2)?,
                remote_id: row.get(3)?,
                path: row.get(4)?,
                new_path: row.get(5)?,
                payload: row.get(6)?,
                created_at: row.get(7)?,
                attempts: row.get(8)?,
                last_error: row.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn op_succeeded(&self, id: i64) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM pending_ops WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn op_failed(&self, id: i64, error: &str) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE pending_ops
             SET attempts = attempts + 1, last_error = ?1
             WHERE id = ?2",
            params![error, id],
        )?;
        Ok(())
    }

    #[allow(dead_code)] // exposed to UI in a later stage
    pub fn pending_op_count(&self) -> Result<i64, rusqlite::Error> {
        let conn = self.connect()?;
        conn.query_row("SELECT COUNT(*) FROM pending_ops", [], |row| row.get(0))
    }

    // ===== sync_orphans =====

    pub fn record_orphan(
        &self,
        info: &SyncedFileInfo,
        reason: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR IGNORE INTO sync_orphans
             (internal_id, sync_folder_id, relative_path, last_synced_at, discovered_at, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                info.internal_id,
                info.sync_folder_id,
                info.relative_path,
                info.last_synced_at,
                now,
                reason,
            ],
        )?;
        Ok(())
    }
}

fn row_to_info(row: &rusqlite::Row) -> Result<SyncedFileInfo, rusqlite::Error> {
    Ok(SyncedFileInfo {
        internal_id: row.get(0)?,
        sync_folder_id: row.get(1)?,
        relative_path: row.get(2)?,
        last_synced_hash: row.get(3)?,
        last_synced_at: row.get(4)?,
        remote_id: row.get(5)?,
        last_known_rev: row.get(6)?,
    })
}

/// Escape `_` and `%` (and the escape char itself) so a path used in a LIKE
/// clause matches literally instead of as a wildcard.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// One-shot migration: read the legacy `sync_map.json`, write entries into
/// the SQLite map, then rename the JSON to `.bak` so we never re-migrate.
///
/// Duplicates (multiple internal_ids pointing at the same external path,
/// the on-disk fingerprint of the rename-duplication bug) are resolved by
/// keeping the most recently synced entry; the rest are recorded as
/// orphans and surfaced in the UI for manual cleanup. Silent merging is
/// deliberately avoided — that's exactly the failure mode this redesign
/// is meant to eliminate.
pub fn migrate_from_json(db: &SyncDb, json_path: &Path) -> Result<(usize, usize), Box<dyn std::error::Error>> {
    let content = fs::read_to_string(json_path)?;
    let map: HashMap<String, SyncedFileInfo> = serde_json::from_str(&content)?;

    // Group by (sync_folder_id, relative_path) to find duplicates.
    let mut by_path: HashMap<(String, String), Vec<SyncedFileInfo>> = HashMap::new();
    for (_, info) in map {
        by_path
            .entry((info.sync_folder_id.clone(), info.relative_path.clone()))
            .or_default()
            .push(info);
    }

    let mut migrated = 0usize;
    let mut orphaned = 0usize;
    for (_, mut entries) in by_path {
        if entries.len() == 1 {
            db.upsert_file(&entries[0])?;
            migrated += 1;
            continue;
        }
        // Most-recently-synced wins; the rest become orphans.
        entries.sort_by_key(|e| std::cmp::Reverse(e.last_synced_at));
        db.upsert_file(&entries[0])?;
        migrated += 1;
        for loser in &entries[1..] {
            db.record_orphan(loser, "duplicate-path-during-migration")?;
            orphaned += 1;
        }
    }

    let bak_path = json_path.with_extension("json.bak");
    fs::rename(json_path, &bak_path)?;

    Ok((migrated, orphaned))
}


#[cfg(test)]
#[path = "sync_db_tests.rs"]
mod tests;
