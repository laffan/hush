//! A title typed on one device is a rename *and* an edit. The far device
//! must not mint a second id for it while the sidecars that name it are
//! still on their way.

use super::*;
use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::fs;

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

fn rows_for(nodes: &[TreeNode], out: &mut Vec<(String, Option<String>)>) {
    for n in nodes {
        if n.file_id.is_some() {
            out.push((n.name.clone(), n.file_id.clone()));
        }
        rows_for(&n.children, out);
    }
}

fn doc_rows(store: &DeskStore) -> Vec<(String, Option<String>)> {
    let forest = store.load_forest().unwrap();
    let mut out = Vec::new();
    rows_for(&forest[0].children, &mut out);
    out
}

/// Two installs on one folder, one document, as the far device last saw it.
fn shared_desk(file_id: &str) -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, std::path::PathBuf, DeskStore, DeskStore) {
    let data_a = tempfile::tempdir().unwrap();
    let data_b = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir().unwrap();
    let root = shared.path().join("Desk");
    let a = DeskStore::new(data_a.path());
    a.stage_new(file_id).unwrap();
    a.write_by_id(file_id, "Hel").unwrap();
    let tree = vec![node("d1", "desk", "Desk", None, vec![node("n1", "document", "Hel", Some(file_id), Vec::new())])];
    a.save_forest(&tree).unwrap();
    a.make_desk_local("d1", &root, None).unwrap();
    a.reconcile_desk_from_disk("d1").unwrap();
    let b = DeskStore::new(data_b.path());
    assert_eq!(b.adopt_desk_folder(&root, None).unwrap(), "d1");
    (data_a, data_b, shared, root, a, b)
}

#[test]
fn a_renamed_and_edited_file_waits_for_its_sidecars() {
    let (_da, _db, _s, root, a, b) = shared_desk("hold-f1");
    // A types the title: the file is renamed and rewritten. Only the file
    // has reached B so far — not A's index.json or tree.json.
    fs::rename(root.join("Hel.md"), root.join("Hello world.md")).unwrap();
    fs::write(root.join("Hello world.md"), "Hello world").unwrap();
    let first = b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((first.added, first.held), (0, 1), "held, not minted");

    // A's sidecars land.
    a.rename_by_id("hold-f1", "Hello world").unwrap();
    let tree = vec![node("d1", "desk", "Desk", None, vec![node("n1", "document", "Hello world", Some("hold-f1"), Vec::new())])];
    a.save_forest(&tree).unwrap();
    let second = b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((second.added, second.held), (0, 0));
    assert_eq!(doc_rows(&b), vec![("Hello world".to_string(), Some("hold-f1".to_string()))]);
    assert_eq!(b.read_by_id("hold-f1").unwrap().0, "Hello world");
}

#[test]
fn a_hold_that_runs_out_mints_as_before() {
    let (_da, _db, _s, root, _a, b) = shared_desk("hold-f2");
    fs::remove_file(root.join("Hel.md")).unwrap();
    fs::write(root.join("Something else.md"), "unrelated").unwrap();
    assert_eq!(b.reconcile_desk_from_disk("d1").unwrap().held, 1);
    backdate_for_tests(&root, "Something else.md", HOLD_SECS + 1);
    let rep = b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((rep.added, rep.held), (1, 0));
}

#[test]
fn an_arrival_with_nothing_missing_beside_it_is_new_at_once() {
    let (_da, _db, _s, root, _a, b) = shared_desk("hold-f3");
    fs::write(root.join("Fresh.md"), "new").unwrap();
    let rep = b.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((rep.added, rep.held), (1, 0));
}

#[test]
fn our_own_older_bytes_under_a_new_name_keep_their_id() {
    let (_da, _db, _s, root, a, _b) = shared_desk("hold-f4");
    a.write_by_id("hold-f4", "Hello").unwrap();
    a.write_by_id("hold-f4", "Hello there").unwrap();
    // The index that names the new path was replaced by one that hadn't
    // heard of it; the bytes are an earlier save of ours.
    fs::remove_file(root.join("Hel.md")).unwrap();
    fs::write(root.join("Hello.md"), "Hello").unwrap();
    let rep = a.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((rep.renamed, rep.added, rep.held), (1, 0, 0));
    assert_eq!(doc_rows(&a), vec![("Hello".to_string(), Some("hold-f4".to_string()))]);
}
