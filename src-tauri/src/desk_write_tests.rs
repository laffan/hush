//! Checked saves: a buffer based on content the disk no longer holds is
//! never written over it, and a path two ids share is written by neither.

use super::*;
use crate::TreeNode;

fn doc(id: &str, name: &str, file_id: &str) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: "document".to_string(),
        file_id: Some(file_id.to_string()),
        ..Default::default()
    }
}

fn store_with(files: &[(&str, &str, &str)]) -> (tempfile::TempDir, DeskStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    let mut kids = Vec::new();
    for (i, (name, id, body)) in files.iter().enumerate() {
        store.stage_new(id).unwrap();
        store.write_by_id(id, body).unwrap();
        kids.push(doc(&format!("n{}", i), name, id));
    }
    let desk = TreeNode {
        id: "d1".into(),
        name: "Desk".into(),
        node_type: "desk".into(),
        children: kids,
        ..Default::default()
    };
    store.save_forest(&[desk]).unwrap();
    (dir, store)
}

#[test]
fn a_save_based_on_what_is_on_disk_goes_through() {
    let (_d, store) = store_with(&[("Doc", "x", "v1")]);
    let report = store.write_checked("x", "v1 + mine", Some(&content_hash("v1"))).unwrap();
    assert!(report.conflict.is_none());
    assert_eq!(report.hash, content_hash("v1 + mine"));
    assert_eq!(store.read_by_id("x").unwrap().0, "v1 + mine");
}

/// The last-open document at launch is read before the other device's
/// version has arrived; the user types; the autosave lands after the
/// download. That save must not erase the other device's edit.
#[test]
fn a_save_based_on_an_older_version_is_held_and_the_disk_left_alone() {
    let (dir, store) = store_with(&[("Doc", "x", "v1")]);
    fs::write(dir.path().join("desks/d1/Doc.md"), "v2 from the other device").unwrap();
    let report = store.write_checked("x", "v1 + mine", Some(&content_hash("v1"))).unwrap();
    let conflict = report.conflict.expect("the stale save should be held");
    assert_eq!(conflict.kind, "changed");
    assert_eq!(conflict.disk_content.as_deref(), Some("v2 from the other device"));
    assert_eq!(report.hash, content_hash("v2 from the other device"));
    assert_eq!(store.read_by_id("x").unwrap().0, "v2 from the other device");
}

/// A write this process made — another window on the same doc, a pane,
/// a wikilink rewrite — is not the other device's edit.
#[test]
fn a_write_from_this_process_is_not_a_conflict() {
    let (_d, store) = store_with(&[("Doc", "own", "v1")]);
    store.write_by_id("own", "v2 from a second window").unwrap();
    let report = store.write_checked("own", "v2 + more", Some(&content_hash("v1"))).unwrap();
    assert!(report.conflict.is_none());
    assert_eq!(store.read_by_id("own").unwrap().0, "v2 + more");
}

/// Both sides typed the same thing — nothing to decide.
#[test]
fn a_save_the_disk_already_matches_is_not_a_conflict() {
    let (dir, store) = store_with(&[("Doc", "x", "v1")]);
    fs::write(dir.path().join("desks/d1/Doc.md"), "same").unwrap();
    let report = store.write_checked("x", "same", Some(&content_hash("v1"))).unwrap();
    assert!(report.conflict.is_none());
}

/// A file that vanished under the editor is reported, not recreated —
/// recreating it resurrects a document the other device deleted or
/// moved, as a stray the far side then absorbs as "new".
#[test]
fn a_save_into_a_vanished_file_does_not_recreate_it() {
    let (dir, store) = store_with(&[("Doc", "x", "v1")]);
    let path = dir.path().join("desks/d1/Doc.md");
    fs::remove_file(&path).unwrap();
    let report = store.write_checked("x", "mine", Some(&content_hash("v1"))).unwrap();
    assert_eq!(report.conflict.map(|c| c.kind).as_deref(), Some("missing"));
    assert!(!path.exists());
}

/// Two ids indexed at one path: whichever saved last would silently
/// replace the other's document. Refuse.
#[test]
fn a_path_two_ids_share_is_written_by_neither() {
    let (_d, store) = store_with(&[("Doc", "x", "x body"), ("Other", "y", "y body")]);
    let mut index = store.load_index("d1");
    index.insert("y".into(), "Doc.md".into());
    store.save_index("d1", &index).unwrap();
    assert!(store.write_checked("y", "y's text", None).is_err());
    assert!(store.write_by_id("x", "x's text").is_err());
    assert_eq!(store.read_by_id("x").unwrap().0, "x body");
}

/// A case-only rename is the same file under a new spelling, not a
/// collision (simulated with a hard link on this case-sensitive volume).
#[cfg(unix)]
#[test]
fn renaming_to_another_spelling_of_the_same_file_is_not_a_collision() {
    let (dir, store) = store_with(&[("my title", "x", "body")]);
    let root = dir.path().join("desks/d1");
    fs::hard_link(root.join("my title.md"), root.join("My title.md")).unwrap();
    store.rename_by_id("x", "My title").unwrap();
    assert_eq!(store.load_index("d1").get("x").map(String::as_str), Some("My title.md"));
    assert_eq!(store.read_by_id("x").unwrap().0, "body");
}
