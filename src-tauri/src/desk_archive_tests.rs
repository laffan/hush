//! Archive round trips: a desk survives being zipped and rebuilt, and a
//! restore never collides with what it was made from.

use super::*;
use crate::desk_store::DeskStore;

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

#[test]
fn a_desk_round_trips_through_an_archive_with_a_new_identity() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    store.write_by_id("f-essay", "the essay").unwrap();
    let original = desk(
        "orig",
        "Archive Round Trip",
        vec![node("p1", "project", "Essays", None, vec![node("n1", "document", "Essay", Some("f-essay"), Vec::new())])],
    );
    store.save_forest(&[original]).unwrap();

    let info = store.archive_desk("orig", "Archive Round Trip").unwrap();
    assert_eq!(info.name, "Archive Round Trip");
    assert!(info.files >= 3, "tree, index and the doc at minimum: {}", info.files);
    assert!(!info.was_local);

    // Restoring alongside the original must not produce two desks
    // claiming the same file — the invariant desk_dedupe enforces.
    let new_id = store.restore_archive(&info.file).unwrap();
    assert_ne!(new_id, "orig");

    let forest = store.load_forest().unwrap();
    let restored = forest.iter().find(|d| d.id == new_id).expect("restored desk in the forest");
    assert_eq!(restored.name, "Archive Round Trip");
    assert!(restored.children.iter().any(|c| c.id == format!("__inbox__:{}", new_id)),
        "specials must be re-namespaced onto the new desk id");

    let essays = restored.children.iter().find(|c| c.name == "Essays").expect("project restored");
    let doc = &essays.children[0];
    let fresh_id = doc.file_id.clone().unwrap();
    assert_ne!(fresh_id, "f-essay", "fileIds are reminted so a restore can't collide");
    assert_eq!(store.read_by_id(&fresh_id).unwrap().0, "the essay");
    assert_eq!(store.read_by_id("f-essay").unwrap().0, "the essay", "the original is untouched");

    assert_eq!(store.list_archives().len(), 1, "one archive on disk");
}

#[test]
fn archiving_leaves_the_desk_in_place_until_it_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    store.write_by_id("f-note", "note").unwrap();
    store
        .save_forest(&[desk("keep", "Discard Me", vec![node("n1", "document", "Note", Some("f-note"), Vec::new())])])
        .unwrap();

    let info = store.archive_desk("keep", "Discard Me").unwrap();
    assert!(dir.path().join("desks/keep/.hush/tree.json").exists(),
        "archiving alone must not remove the desk — a failed archive can't cost the user their files");

    store.discard_archived_desk("keep").unwrap();
    assert!(!dir.path().join("desks/keep").exists());

    // And it comes back from the archive.
    let new_id = store.restore_archive(&info.file).unwrap();
    let forest = store.load_forest().unwrap();
    let restored = forest.iter().find(|d| d.id == new_id).unwrap();
    let fid = restored.children.iter().find_map(|c| c.file_id.clone()).unwrap();
    assert_eq!(store.read_by_id(&fid).unwrap().0, "note");

}

#[test]
fn archive_handles_are_treated_as_untrusted() {
    assert!(sanitize_handle("../../etc/passwd").is_err());
    assert!(sanitize_handle("nested/thing.husharchive").is_err());
    assert!(sanitize_handle("plain.txt").is_err());
    assert_eq!(sanitize_handle("desk-1.husharchive").unwrap(), "desk-1.husharchive");
}
