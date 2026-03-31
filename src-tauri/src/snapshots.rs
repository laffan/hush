use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub id: i64,
    pub document_id: String,
    pub content: String,
    pub created_at: i64,
}

pub struct SnapshotManager {
    db_path: PathBuf,
}

impl SnapshotManager {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let db_path = data_dir.join("snapshots.db");
        let manager = Self { db_path };
        manager.init_db().expect("Failed to initialize snapshot database");
        manager
    }

    fn connect(&self) -> Result<Connection, rusqlite::Error> {
        Connection::open(&self.db_path)
    }

    fn init_db(&self) -> Result<(), rusqlite::Error> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_doc_time
                ON snapshots(document_id, created_at DESC);"
        )?;
        Ok(())
    }

    pub fn create_snapshot(
        &self,
        document_id: &str,
        content: &str,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let conn = self.connect()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO snapshots (document_id, content, created_at) VALUES (?1, ?2, ?3)",
            params![document_id, content, now],
        )?;
        let id = conn.last_insert_rowid();

        // Run cleanup after creating a snapshot
        self.cleanup_snapshots_with_conn(&conn, document_id)?;

        Ok(id)
    }

    pub fn get_snapshots(
        &self,
        document_id: &str,
    ) -> Result<Vec<SnapshotEntry>, Box<dyn std::error::Error>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, document_id, content, created_at
             FROM snapshots
             WHERE document_id = ?1
             ORDER BY created_at DESC"
        )?;
        let entries = stmt.query_map(params![document_id], |row| {
            Ok(SnapshotEntry {
                id: row.get(0)?,
                document_id: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn get_snapshot(
        &self,
        id: i64,
    ) -> Result<SnapshotEntry, Box<dyn std::error::Error>> {
        let conn = self.connect()?;
        let entry = conn.query_row(
            "SELECT id, document_id, content, created_at
             FROM snapshots WHERE id = ?1",
            params![id],
            |row| {
                Ok(SnapshotEntry {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    content: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )?;
        Ok(entry)
    }

    pub fn delete_document_snapshots(
        &self,
        document_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let conn = self.connect()?;
        conn.execute(
            "DELETE FROM snapshots WHERE document_id = ?1",
            params![document_id],
        )?;
        Ok(())
    }

    pub fn cleanup_all(&self) -> Result<u64, Box<dyn std::error::Error>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT document_id FROM snapshots"
        )?;
        let doc_ids: Vec<String> = stmt.query_map([], |row| {
            row.get(0)
        })?.collect::<Result<Vec<_>, _>>()?;

        let mut total_deleted = 0u64;
        for doc_id in &doc_ids {
            total_deleted += self.cleanup_snapshots_with_conn(&conn, doc_id)?;
        }
        Ok(total_deleted)
    }

    fn cleanup_snapshots_with_conn(
        &self,
        conn: &Connection,
        document_id: &str,
    ) -> Result<u64, Box<dyn std::error::Error>> {
        let now = chrono::Utc::now().timestamp();

        // Time boundaries (in seconds from now)
        let thirty_min = now - 30 * 60;
        let two_hours = now - 2 * 60 * 60;
        let twenty_four_hours = now - 24 * 60 * 60;
        let seven_days = now - 7 * 24 * 60 * 60;

        // Collect all snapshot IDs and timestamps for this document
        let mut stmt = conn.prepare(
            "SELECT id, created_at FROM snapshots
             WHERE document_id = ?1
             ORDER BY created_at DESC"
        )?;
        let snapshots: Vec<(i64, i64)> = stmt.query_map(params![document_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?.collect::<Result<Vec<_>, _>>()?;

        let mut ids_to_delete: Vec<i64> = Vec::new();

        // Apply decay rules per time window
        // Last 30 min: keep all (no action needed)
        // 30 min - 2 hours: keep 1 per minute
        ids_to_delete.extend(
            Self::thin_window(&snapshots, two_hours, thirty_min, 60)
        );
        // 2 - 24 hours: keep 1 per 10 minutes
        ids_to_delete.extend(
            Self::thin_window(&snapshots, twenty_four_hours, two_hours, 600)
        );
        // 1 - 7 days: keep 1 per hour
        ids_to_delete.extend(
            Self::thin_window(&snapshots, seven_days, twenty_four_hours, 3600)
        );
        // Older than 7 days: keep 1 per day
        ids_to_delete.extend(
            Self::thin_window(&snapshots, 0, seven_days, 86400)
        );

        let count = ids_to_delete.len() as u64;
        if !ids_to_delete.is_empty() {
            let placeholders: Vec<String> = ids_to_delete.iter().map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM snapshots WHERE id IN ({})",
                placeholders.join(",")
            );
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = ids_to_delete
                .iter()
                .map(|id| id as &dyn rusqlite::types::ToSql)
                .collect();
            stmt.execute(params.as_slice())?;
        }

        Ok(count)
    }

    /// Given a list of (id, timestamp) pairs sorted newest-first,
    /// thin out entries in [window_start, window_end) keeping only
    /// the latest entry per `bucket_size` seconds.
    fn thin_window(
        snapshots: &[(i64, i64)],
        window_start: i64,
        window_end: i64,
        bucket_size: i64,
    ) -> Vec<i64> {
        let mut to_delete = Vec::new();
        // Group snapshots in this window by bucket
        let in_window: Vec<&(i64, i64)> = snapshots
            .iter()
            .filter(|(_, ts)| *ts >= window_start && *ts < window_end)
            .collect();

        // Group by bucket (timestamp / bucket_size)
        let mut buckets: std::collections::HashMap<i64, Vec<&(i64, i64)>> =
            std::collections::HashMap::new();
        for snap in &in_window {
            let bucket = snap.1 / bucket_size;
            buckets.entry(bucket).or_default().push(snap);
        }

        // In each bucket, keep only the latest (highest timestamp), delete the rest
        for (_bucket, mut entries) in buckets {
            entries.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
            // Skip the first (keep it), mark rest for deletion
            for entry in entries.iter().skip(1) {
                to_delete.push(entry.0);
            }
        }

        to_delete
    }
}
