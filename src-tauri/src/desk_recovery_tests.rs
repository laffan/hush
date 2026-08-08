//! Recovery snapshots: local desks snapshot into the recovery area on
//! edit, prune to the cap, and restore as brand-new renamed desks — with
//! the user's own folder never written to.

use super::*;
use crate::desk_store::DeskStore;
use crate::TreeNode;

fn node(id: &str, node_type: &str, name: &str, file_id: Option<&str>, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: node_type.to_string(),
        file_id: file_id.map(|s| s.to_string()),
        children,
        ..Default::default()
    }
}

fn desk(id: &str, name: &str, extra: Vec<TreeNode>) -> TreeNode {
    let mut kids = vec![node(&format!("__inbox__:{}", id), "project", "Inbox", None, Vec::new())];
    kids.extend(extra);
    kids.push(node(&format!("__trash__:{}", id), "folder", "Trash", None, Vec::new()));
    node(id, "desk", name, None, kids)
}

/// An internal desk with one doc, made local into its own folder.
fn seed_local_desk(store: &DeskStore, target: &Path, desk_id: &str, file_id: &str) {
    store.write_by_id(file_id, "the draft").unwrap();
    store
        .save_forest(&[desk(
            desk_id,
            "Field Notes",
            vec![node("n1", "document", "Draft", Some(file_id), Vec::new())],
        )])
        .unwrap();
    store.make_desk_local(desk_id, target, None).unwrap();
}

#[test]
fn a_snapshot_round_trips_into_a_renamed_new_desk() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    let target = folder.path().join("Field Notes");
    seed_local_desk(&store, &target, "rec-rt", "f-draft");

    let info = store.snapshot_desk_for_recovery("rec-rt").unwrap();
    assert_eq!(info.name, "Field Notes");
    assert!(info.was_local);
    assert!(info.files >= 4, "tree, index, .hushdesk and the doc at minimum: {}", info.files);

    let listed = store.list_recovery_snapshots();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].desk_id, "rec-rt");
    assert_eq!(listed[0].name, "Field Notes");

    let new_id = store
        .restore_recovery_snapshot("rec-rt", &info.file, "Field Notes Recovery - 132pm Jan 2, 2026")
        .unwrap();
    assert_ne!(new_id, "rec-rt");

    let forest = store.load_forest().unwrap();
    let restored = forest.iter().find(|d| d.id == new_id).expect("restored desk in the forest");
    assert_eq!(restored.name, "Field Notes Recovery - 132pm Jan 2, 2026");
    // The recovered desk is internal, fresh-id'd, and carries the content.
    assert!(store.list_roots().get(&new_id).is_none(), "a recovery restores internally");
    let doc = restored
        .children
        .iter()
        .flat_map(|c| if c.name == "Draft" { vec![c] } else { c.children.iter().collect() })
        .find(|c| c.name == "Draft")
        .expect("doc restored");
    let fresh = doc.file_id.clone().unwrap();
    assert_ne!(fresh, "f-draft", "fileIds are reminted so recovery can't collide");
    assert_eq!(store.read_by_id(&fresh).unwrap().0, "the draft");

    // The user's own folder was never written to by the restore.
    assert_eq!(store.read_by_id("f-draft").unwrap().0, "the draft");
    assert!(target.join("Draft.md").exists(), "original folder untouched");
}

#[test]
fn snapshots_prune_to_the_cap_keeping_the_newest() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    let target = folder.path().join("Prune Me");
    seed_local_desk(&store, &target, "rec-prune", "f-prune");

    let mut taken = Vec::new();
    for _ in 0..(KEEP_PER_DESK + 3) {
        taken.push(store.snapshot_desk_for_recovery("rec-prune").unwrap().archived_at);
    }
    let listed = store.list_recovery_snapshots();
    assert_eq!(listed.len(), KEEP_PER_DESK, "pruned to the cap");
    let kept: Vec<u64> = listed.iter().map(|s| s.archived_at).collect();
    for old in &taken[..3] {
        assert!(!kept.contains(old), "the oldest snapshots are the ones pruned");
    }
}

#[test]
fn the_tick_snapshots_edited_local_desks_once_per_interval() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    let target = folder.path().join("Ticked");
    seed_local_desk(&store, &target, "rec-tick", "f-tick");

    // No edits stamped — the tick leaves the desk alone.
    tick(dir.path());
    assert_eq!(store.list_recovery_snapshots().len(), 0);

    // An edit with no snapshot yet is due immediately.
    store.write_by_id("f-tick", "the draft, longer").unwrap();
    tick(dir.path());
    assert_eq!(store.list_recovery_snapshots().len(), 1, "first snapshot lands on the next tick");

    // Another edit inside the interval is not due yet.
    store.write_by_id("f-tick", "the draft, longer still").unwrap();
    tick(dir.path());
    assert_eq!(store.list_recovery_snapshots().len(), 1, "interval not elapsed — no second snapshot");

    // With no *new* edits an elapsed interval changes nothing either
    // (edited_at predates the snapshot after the pending edit was
    // captured, so this exercises the edited_at <= at skip).
    let listed = store.list_recovery_snapshots();
    assert_eq!(listed.len(), 1);

    // Deleting the snapshot re-arms the "no snapshot yet" path.
    store.delete_recovery_snapshot("rec-tick", &listed[0].file).unwrap();
    tick(dir.path());
    assert_eq!(store.list_recovery_snapshots().len(), 1, "pending edit + no snapshot → due again");
}

#[test]
fn snapshot_handles_reject_path_tricks() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    assert!(store.delete_recovery_snapshot("../desks", "1.husharchive").is_err());
    assert!(store.delete_recovery_snapshot("d", "../../settings.json").is_err());
    assert!(store.delete_recovery_snapshot("d", "notasnapshot.txt").is_err());
    assert!(store
        .restore_recovery_snapshot("d", ".hidden.husharchive", "x")
        .is_err());
}
