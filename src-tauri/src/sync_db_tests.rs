use super::*;
use rusqlite::params;

fn mk_info(id: &str, folder: &str, path: &str, hash: &str, ts: i64) -> SyncedFileInfo {
    SyncedFileInfo {
        internal_id: id.into(),
        sync_folder_id: folder.into(),
        relative_path: path.into(),
        last_synced_hash: hash.into(),
        last_synced_at: ts,
        remote_id: String::new(),
        last_known_rev: String::new(),
    }
}

#[test]
fn upsert_and_get_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    let info = mk_info("a", "f1", "Notes/x.md", "h1", 100);
    db.upsert_file(&info).unwrap();
    let got = db.get("a").unwrap().unwrap();
    assert_eq!(got.relative_path, "Notes/x.md");
    assert_eq!(got.last_synced_hash, "h1");
    assert_eq!(got.last_synced_at, 100);
    assert_eq!(got.remote_id, "");
}

#[test]
fn rename_prefix_handles_underscore_in_path() {
    // `_` is a LIKE wildcard — without escaping, `Foo_/x` would match
    // both `Foo_/x` and `FooX/x`. Make sure we only touch the literal.
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    db.upsert_file(&mk_info("a", "f", "Foo_/x.md", "", 0)).unwrap();
    db.upsert_file(&mk_info("b", "f", "FooX/x.md", "", 0)).unwrap();
    db.rename_prefix("f", "Foo_/", "Bar/").unwrap();
    assert_eq!(db.get("a").unwrap().unwrap().relative_path, "Bar/x.md");
    assert_eq!(db.get("b").unwrap().unwrap().relative_path, "FooX/x.md");
}

#[test]
fn migration_keeps_most_recent_duplicate_orphans_the_rest() {
    // The rename-duplication bug, frozen as on-disk state: two
    // internal_ids pointing at the same external path. Migration must
    // keep the most recently synced one and record the others.
    let dir = tempfile::tempdir().unwrap();
    let json = dir.path().join("sync_map.json");
    let blob = serde_json::json!({
        "old-uuid": {
            "internalId": "old-uuid", "syncFolderId": "f",
            "relativePath": "Notes/x.md", "lastSyncedHash": "old-hash",
            "lastSyncedAt": 100,
        },
        "new-uuid": {
            "internalId": "new-uuid", "syncFolderId": "f",
            "relativePath": "Notes/x.md", "lastSyncedHash": "new-hash",
            "lastSyncedAt": 200,
        },
        "solo": {
            "internalId": "solo", "syncFolderId": "f",
            "relativePath": "Notes/y.md", "lastSyncedHash": "h",
            "lastSyncedAt": 50,
        },
    });
    fs::write(&json, serde_json::to_string(&blob).unwrap()).unwrap();

    let db = SyncDb::new(dir.path());
    let (migrated, orphaned) = migrate_from_json(&db, &json).unwrap();
    assert_eq!(migrated, 2);
    assert_eq!(orphaned, 1);

    let kept = db.get("new-uuid").unwrap().unwrap();
    assert_eq!(kept.last_synced_hash, "new-hash");
    assert!(db.get("old-uuid").unwrap().is_none());
    assert!(db.get("solo").unwrap().is_some());

    // Orphan should be recorded with a reason
    let conn = rusqlite::Connection::open(dir.path().join("sync.db")).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_orphans WHERE internal_id = ?1",
            params!["old-uuid"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);

    // JSON should be renamed to .bak
    assert!(!json.exists());
    assert!(dir.path().join("sync_map.json.bak").exists());
}

fn mk_op(kind: &str, path: &str) -> PendingOp {
    PendingOp {
        id: 0,
        kind: kind.into(),
        internal_id: None,
        remote_id: None,
        path: path.into(),
        new_path: None,
        payload: None,
        created_at: 0,
        attempts: 0,
        last_error: None,
    }
}

#[test]
fn op_log_enqueue_peek_succeed_drops_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    let id = db.enqueue_op(&mk_op("delete", "x.md")).unwrap();
    let ops = db.peek_ops(10).unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].id, id);
    assert_eq!(ops[0].kind, "delete");
    db.op_succeeded(id).unwrap();
    assert_eq!(db.peek_ops(10).unwrap().len(), 0);
}

#[test]
fn op_log_failed_increments_attempts_and_keeps_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    let id = db.enqueue_op(&mk_op("upload", "x.md")).unwrap();
    db.op_failed(id, "network").unwrap();
    db.op_failed(id, "still down").unwrap();
    let ops = db.peek_ops(10).unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].attempts, 2);
    assert_eq!(ops[0].last_error.as_deref(), Some("still down"));
}

#[test]
fn find_by_remote_id_skips_empty_sentinels() {
    // Legacy entries with `remote_id = ""` must not collide on lookup;
    // empty is the "not yet backfilled" marker, not a real id.
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    db.upsert_file(&mk_info("a", "f", "x.md", "h", 1)).unwrap();
    db.upsert_file(&mk_info("b", "f", "y.md", "h", 1)).unwrap();
    assert!(db.find_by_remote_id("").unwrap().is_none());
    // After backfill, found by id
    db.backfill_remote_id("a", "id:abc", "rev1").unwrap();
    assert_eq!(
        db.find_by_remote_id("id:abc").unwrap().unwrap().internal_id,
        "a"
    );
}

#[test]
fn find_by_path_is_case_insensitive() {
    // Dropbox `deleted` events only carry `path_lower`. Make sure the
    // lookup matches a stored entry whose case differs.
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    db.upsert_file(&mk_info("a", "f", "Notes/Today.md", "", 0)).unwrap();
    let got = db.find_by_path_ci("f", "notes/today.md").unwrap();
    assert_eq!(got.unwrap().internal_id, "a");
}

#[test]
fn update_sync_state_writes_rev_and_hash() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    db.upsert_file(&mk_info("a", "f", "x.md", "old-hash", 1)).unwrap();
    db.update_sync_state("a", "new-hash", "rev42", 999).unwrap();
    let got = db.get("a").unwrap().unwrap();
    assert_eq!(got.last_synced_hash, "new-hash");
    assert_eq!(got.last_synced_at, 999);
    assert_eq!(got.last_known_rev, "rev42");
}

#[test]
fn cursor_set_get_clear() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    assert!(db.get_cursor("dbx").unwrap().is_none());
    db.set_cursor("dbx", "cur123", "/Apps/Hush").unwrap();
    let (cur, root) = db.get_cursor("dbx").unwrap().unwrap();
    assert_eq!(cur, "cur123");
    assert_eq!(root, "/Apps/Hush");
    db.set_cursor("dbx", "cur456", "/Apps/Hush").unwrap();
    let (cur, _) = db.get_cursor("dbx").unwrap().unwrap();
    assert_eq!(cur, "cur456"); // upsert
    db.clear_cursor("dbx").unwrap();
    assert!(db.get_cursor("dbx").unwrap().is_none());
}

#[test]
fn op_log_peek_returns_in_insertion_order() {
    let dir = tempfile::tempdir().unwrap();
    let db = SyncDb::new(dir.path());
    let id_a = db.enqueue_op(&mk_op("rename", "a")).unwrap();
    let id_b = db.enqueue_op(&mk_op("delete", "b")).unwrap();
    let id_c = db.enqueue_op(&mk_op("upload", "c")).unwrap();
    let ops = db.peek_ops(10).unwrap();
    assert_eq!(ops.iter().map(|o| o.id).collect::<Vec<_>>(), vec![id_a, id_b, id_c]);
}

#[test]
fn migration_legacy_entries_default_remote_id_to_empty() {
    // Legacy JSON has no `remoteId` / `lastKnownRev` fields. Serde
    // defaults must fill them in, otherwise the migration crashes.
    let dir = tempfile::tempdir().unwrap();
    let json = dir.path().join("sync_map.json");
    let blob = serde_json::json!({
        "x": {
            "internalId": "x", "syncFolderId": "f",
            "relativePath": "a.md", "lastSyncedHash": "h",
            "lastSyncedAt": 1,
        }
    });
    fs::write(&json, serde_json::to_string(&blob).unwrap()).unwrap();
    let db = SyncDb::new(dir.path());
    migrate_from_json(&db, &json).unwrap();
    let got = db.get("x").unwrap().unwrap();
    assert_eq!(got.remote_id, "");
    assert_eq!(got.last_known_rev, "");
}
