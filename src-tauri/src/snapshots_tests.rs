//! Unit tests for the file-per-snapshot version store.

use super::*;
use crate::desk_store::DeskStore;
use crate::TreeNode;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn doc_node(id: &str, name: &str, file_id: &str) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: "document".to_string(),
        file_id: Some(file_id.to_string()),
        children: Vec::new(),
        flagged: false,
        sync_folder_id: None,
        locked_style_id: None,
        use_as_note: false,
        zotero_att_key: None,
        bg_color: None,
        show_numbers: false,
        gutter: false,
        ..Default::default()
    }
}

fn desk(id: &str, name: &str, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: "desk".to_string(),
        file_id: None,
        children,
        flagged: false,
        sync_folder_id: None,
        locked_style_id: None,
        use_as_note: false,
        zotero_att_key: None,
        bg_color: None,
        show_numbers: false,
        gutter: false,
        ..Default::default()
    }
}

/// Place fileId `f1` in desk `d1` so snapshots have a home.
fn seed_desk(data_dir: &std::path::Path) -> DeskStore {
    let store = DeskStore::new(data_dir);
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "body").unwrap();
    let tree = vec![desk("d1", "Personal", vec![doc_node("n1", "Doc", "f1")])];
    store.save_forest(&tree).unwrap();
    store
}

#[test]
fn snapshots_land_in_the_desk_and_read_back_newest_first() {
    let dir = tmp();
    seed_desk(dir.path());
    let mgr = SnapshotManager::new(dir.path());

    let id1 = mgr.create_snapshot("f1", "v1").unwrap();
    let id2 = mgr.create_snapshot("f1", "v2").unwrap();
    assert!(id2 > id1, "ids are monotonic even within one millisecond");

    let versions_dir = dir.path().join("desks/d1/.hush/versions/f1");
    assert!(versions_dir.is_dir());
    assert_eq!(fs::read_dir(&versions_dir).unwrap().count(), 2);

    let entries = mgr.get_snapshots("f1").unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].content, "v2");
    assert_eq!(entries[1].content, "v1");
    assert_eq!(entries[0].id, id2);
    assert!(entries[0].created_at > 0);

    // get_snapshot by id resolves through the scan.
    let one = mgr.get_snapshot(id1).unwrap();
    assert_eq!(one.content, "v1");
    assert_eq!(one.document_id, "f1");
}

#[test]
fn unplaced_files_snapshot_into_the_fallback_area() {
    let dir = tmp();
    DeskStore::new(dir.path()); // desks dir exists, no desks
    let mgr = SnapshotManager::new(dir.path());
    mgr.create_snapshot("ghost", "content").unwrap();
    let fallback = dir.path().join("desks/.versions-unplaced/ghost");
    assert_eq!(fs::read_dir(&fallback).unwrap().count(), 1);
    let entries = mgr.get_snapshots("ghost").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].content, "content");
}

#[test]
fn delete_document_snapshots_clears_every_location() {
    let dir = tmp();
    seed_desk(dir.path());
    let mgr = SnapshotManager::new(dir.path());
    mgr.create_snapshot("f1", "v1").unwrap();
    mgr.delete_document_snapshots("f1").unwrap();
    assert!(mgr.get_snapshots("f1").unwrap().is_empty());
    assert!(!dir.path().join("desks/d1/.hush/versions/f1").exists());
}

#[test]
fn prune_thins_old_buckets_but_keeps_recent_snapshots() {
    let dir = tmp();
    seed_desk(dir.path());
    let mgr = SnapshotManager::new(dir.path());

    // Hand-write snapshots: three within one old minute-bucket (in the
    // 5min–2h window where policy keeps 1/min), plus two fresh ones.
    let versions = dir.path().join("desks/d1/.hush/versions/f1");
    fs::create_dir_all(&versions).unwrap();
    let now = now_ms();
    // 1 hour ago, aligned to a minute boundary so all three land in the
    // same 1-per-minute bucket regardless of when the test runs.
    let old_base = ((now - 60 * 60 * 1000) / 60_000) * 60_000;
    for i in 0..3 {
        let ms = old_base + i * 1000; // same minute bucket
        fs::write(versions.join(format!("{}-dev.snap", ms)), format!("old{}", i)).unwrap();
    }
    mgr.create_snapshot("f1", "fresh1").unwrap();
    mgr.create_snapshot("f1", "fresh2").unwrap();

    let entries = mgr.get_snapshots("f1").unwrap();
    // 2 fresh (kept: <5min window keeps all) + 1 survivor of the old bucket.
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].content, "fresh2");
    assert_eq!(entries[2].content, "old2"); // newest of the old bucket survives
}

#[test]
fn cross_desk_move_carries_version_history() {
    let dir = tmp();
    let store = seed_desk(dir.path());
    let mgr = SnapshotManager::new(dir.path());
    mgr.create_snapshot("f1", "v1").unwrap();

    // Move the doc into a second desk via a tree save.
    let tree = vec![
        desk("d1", "Personal", Vec::new()),
        desk("d2", "Work", vec![doc_node("n1", "Doc", "f1")]),
    ];
    store.save_forest(&tree).unwrap();

    assert!(dir.path().join("desks/d2/.hush/versions/f1").is_dir());
    assert!(!dir.path().join("desks/d1/.hush/versions/f1").exists());
    let entries = mgr.get_snapshots("f1").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].content, "v1");
}

#[test]
fn migrates_snapshots_db_into_desk_files() {
    let dir = tmp();
    seed_desk(dir.path());

    // Build a legacy snapshots.db with two rows for f1 (same second — the
    // collision-bump must keep both) and one for an unplaced doc.
    let db_path = dir.path().join("snapshots.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .unwrap();
    let ts = 1_700_000_000i64;
    for (doc, content) in [("f1", "a"), ("f1", "b"), ("ghost", "c")] {
        conn.execute(
            "INSERT INTO snapshots (document_id, content, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![doc, content, ts],
        )
        .unwrap();
    }
    drop(conn);

    let moved = migrate_snapshots_db(dir.path()).unwrap();
    assert_eq!(moved, 3);
    assert!(!db_path.exists());
    assert!(dir.path().join("snapshots.db.pre-desks.bak").exists());

    let mgr = SnapshotManager::new(dir.path());
    let f1 = mgr.get_snapshots("f1").unwrap();
    assert_eq!(f1.len(), 2, "same-second rows both survive via ms bump");
    let ghost = mgr.get_snapshots("ghost").unwrap();
    assert_eq!(ghost.len(), 1);
    assert_eq!(ghost[0].content, "c");

    // Second run is a no-op.
    assert_eq!(migrate_snapshots_db(dir.path()).unwrap(), 0);
}
