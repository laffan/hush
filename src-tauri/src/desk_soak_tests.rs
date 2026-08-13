//! Two-install soak test: two independent Hush data dirs sharing one
//! desk folder, standing in for two devices on either side of a
//! perfectly-synced iCloud/Dropbox folder. Everything a handoff relies
//! on runs against the same bytes both installs see: adoption, edits,
//! disk-wins adds/removes, hash-paired renames, conflicted-copy
//! resolution with cross-device version history, and desk deletion
//! leaving the other install's folder intact.

use super::*;
use crate::snapshots::SnapshotManager;
use crate::TreeNode;

fn node(id: &str, node_type: &str, name: &str, file_id: Option<&str>, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: node_type.to_string(),
        file_id: file_id.map(|s| s.to_string()),
        children,
        flagged: false,
        sync_folder_id: None,
        locked_style_id: None,
        use_as_note: false,
        zotero_att_key: None,
        bg_color: None,
        show_numbers: false,
        gutter: false,
        proofread: false,
        ..Default::default()
    }
}

fn find_by_file_id<'a>(nodes: &'a [TreeNode], file_id: &str) -> Option<&'a TreeNode> {
    for n in nodes {
        if n.file_id.as_deref() == Some(file_id) {
            return Some(n);
        }
        if let Some(found) = find_by_file_id(&n.children, file_id) {
            return Some(found);
        }
    }
    None
}

#[test]
fn two_installs_share_one_desk_folder() {
    let data_a = tempfile::tempdir().unwrap();
    let data_b = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir().unwrap();
    let desk_root = shared.path().join("Shared Desk");

    // --- Install A creates the desk and moves it to the shared folder.
    let store_a = DeskStore::new(data_a.path());
    store_a.stage_new("f1").unwrap();
    store_a.write_by_id("f1", "written on A").unwrap();
    let tree = vec![node(
        "d1",
        "desk",
        "Shared",
        None,
        vec![node("n1", "document", "Doc", Some("f1"), Vec::new())],
    )];
    store_a.save_forest(&tree).unwrap();
    store_a.make_desk_local("d1", &desk_root, None).unwrap();
    store_a.reconcile_desk_from_disk("d1").unwrap(); // seed hash cache

    // --- Install B adopts the same folder (the handoff).
    let store_b = DeskStore::new(data_b.path());
    assert_eq!(store_b.adopt_desk_folder(&desk_root, None).unwrap(), "d1");
    assert_eq!(store_b.read_by_id("f1").unwrap().0, "written on A");

    // --- A's edit is B's next read.
    store_a.write_by_id("f1", "edited on A").unwrap();
    store_b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(store_b.read_by_id("f1").unwrap().0, "edited on A");

    // --- A file dropped into the folder surfaces on both installs,
    // under the same fileId.
    fs::write(desk_root.join("From B.md"), "b's new doc").unwrap();
    let rep_b = store_b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(rep_b.added, 1);
    let rep_a = store_a.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(rep_a.added, 0, "A adopts B's index entry, not a duplicate");
    let forest_a = store_a.load_forest().unwrap();
    let forest_b = store_b.load_forest().unwrap();
    let id_of = |forest: &[TreeNode]| {
        forest[0]
            .children
            .iter()
            .find(|n| n.name == "From B")
            .and_then(|n| n.file_id.clone())
            .unwrap()
    };
    assert_eq!(id_of(&forest_a), id_of(&forest_b));

    // --- An external rename pairs by content hash on both sides.
    fs::rename(desk_root.join("Doc.md"), desk_root.join("Doc v2.md")).unwrap();
    let rep = store_b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((rep.renamed, rep.added, rep.removed), (1, 0, 0));
    assert!(!store_a.reconcile_desk_from_disk("d1").unwrap().changed());
    assert_eq!(store_a.read_by_id("f1").unwrap().2, "Doc v2");

    // --- A provider conflict fork resolves once; history holds both
    // sides and is visible from both installs.
    std::thread::sleep(std::time::Duration::from_millis(15));
    fs::write(
        desk_root.join("Doc v2 (conflicted copy).md"),
        "fork from the other device",
    )
    .unwrap();
    let rep = store_a.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(rep.conflicts, 1);
    assert_eq!(store_b.read_by_id("f1").unwrap().0, "fork from the other device");
    let snaps_b = SnapshotManager::new(data_b.path());
    let contents: Vec<String> = snaps_b
        .get_snapshots("f1")
        .unwrap()
        .into_iter()
        .map(|e| e.content)
        .collect();
    assert!(contents.iter().any(|c| c == "edited on A"));
    assert!(contents.iter().any(|c| c == "fork from the other device"));

    // --- A deletion on disk propagates to both trees — after the
    // absence outlasts the removal grace window (a single scan can't
    // remove, so a half-synced folder can't shed files).
    fs::remove_file(desk_root.join("From B.md")).unwrap();
    let from_b_id = store_a
        .load_index("d1")
        .into_iter()
        .find(|(_, rel)| rel == "From B.md")
        .map(|(id, _)| id)
        .expect("From B.md is indexed");
    let first = store_a.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((first.removed, first.pending), (0, 1));
    crate::desk_scan::backdate_missing_for_tests(
        &desk_root, &from_b_id, crate::desk_scan::REMOVAL_GRACE_SECS + 1,
    );
    assert_eq!(store_a.reconcile_desk_from_disk("d1").unwrap().removed, 1);
    assert_eq!(store_b.reconcile_desk_from_disk("d1").unwrap().removed, 0);
    let forest_b = store_b.load_forest().unwrap();
    assert!(find_by_file_id(&forest_b[0].children, "f1").is_some());
    assert!(!forest_b[0].children.iter().any(|n| n.name == "From B"));

    // --- B walks away. Deleting a local desk is an *explicit*
    // unregister (the JS delete flow calls `desk_unregister_root`) — a
    // tree save that merely lacks the desk no longer disconnects it, so
    // a stale save from a second window can't sever a live desk.
    let b_own = vec![node("d2", "desk", "B's Desk", None, Vec::new())];
    store_b.save_forest(&b_own).unwrap();
    assert_eq!(
        store_b.list_roots().len(),
        1,
        "a save without the desk leaves its registration alone"
    );
    crate::desk_roots::unregister(&store_b.desks_dir, "d1");
    store_b.save_forest(&b_own).unwrap();
    assert!(store_b.list_roots().is_empty());
    assert!(desk_root.join("Doc v2.md").exists());
    assert_eq!(store_a.read_by_id("f1").unwrap().0, "fork from the other device");
}
