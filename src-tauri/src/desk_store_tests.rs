//! Unit tests for the desk-folder store (tempdir-backed).

use super::*;
use crate::desk_migrate::migrate_from_flat;
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
    }
}

fn desk_with(children: Vec<TreeNode>) -> TreeNode {
    let mut kids = vec![node("__inbox__:d1", "project", "Inbox", None, Vec::new())];
    kids.extend(children);
    kids.push(node("__images__:d1", "folder", "Images", None, Vec::new()));
    kids.push(node("__trash__:d1", "folder", "Trash", None, Vec::new()));
    node("d1", "desk", "Personal", None, kids)
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

#[test]
fn places_staged_files_at_computed_paths() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "# Hello").unwrap();
    store.stage_new("f2").unwrap();
    store.write_by_id("f2", r#"{"format":"hushnote","version":1,"shapes":[]}"#).unwrap();

    let tree = vec![desk_with(vec![
        node("n1", "document", "Hello", Some("f1"), Vec::new()),
        node("n2", "notebook", "Sketch", Some("f2"), Vec::new()),
    ])];
    store.save_forest(&tree).unwrap();

    let doc = dir.path().join("desks/d1/Hello.md");
    assert!(doc.exists());
    assert_eq!(fs::read_to_string(&doc).unwrap(), "# Hello");
    let nb = dir.path().join("desks/d1/Sketch.hushnote");
    assert!(nb.exists());
    assert!(fs::read(&nb).unwrap().starts_with(b"PK"));
    // Staging is empty; reads round-trip through the index.
    assert!(store.staged_ids().is_empty());
    let (content, _, name) = store.read_by_id("f2").unwrap();
    assert!(content.contains("hushnote"));
    assert_eq!(name, "Sketch");
    // Specials exist as real directories.
    assert!(dir.path().join("desks/d1/Inbox").is_dir());
    assert!(dir.path().join("desks/d1/Trash").is_dir());
}

#[test]
fn tree_moves_and_renames_move_files_on_disk() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "body").unwrap();

    let mut inbox = node("__inbox__:d1", "project", "Inbox", None, Vec::new());
    inbox.children.push(node("n1", "document", "Draft", Some("f1"), Vec::new()));
    let tree = vec![node("d1", "desk", "Personal", None, vec![inbox])];
    store.save_forest(&tree).unwrap();
    assert!(dir.path().join("desks/d1/Inbox/Draft.md").exists());

    // Rename + move into a project in one tree save.
    let project = node(
        "p1",
        "project",
        "Novel",
        None,
        vec![node("n1", "document", "Chapter 1", Some("f1"), Vec::new())],
    );
    let tree2 = vec![node(
        "d1",
        "desk",
        "Personal",
        None,
        vec![node("__inbox__:d1", "project", "Inbox", None, Vec::new()), project],
    )];
    store.save_forest(&tree2).unwrap();
    let moved = dir.path().join("desks/d1/Novel/Chapter 1.md");
    assert!(moved.exists());
    assert_eq!(fs::read_to_string(&moved).unwrap(), "body");
    assert!(!dir.path().join("desks/d1/Inbox/Draft.md").exists());
}

#[test]
fn cross_desk_move_and_desk_retirement() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "x").unwrap();

    let tree = vec![
        node("d1", "desk", "A", None, vec![node("n1", "document", "Doc", Some("f1"), Vec::new())]),
        node("d2", "desk", "B", None, Vec::new()),
    ];
    store.save_forest(&tree).unwrap();
    assert!(dir.path().join("desks/d1/Doc.md").exists());

    // Move the doc into desk B, then drop desk A entirely.
    let tree2 = vec![node(
        "d2",
        "desk",
        "B",
        None,
        vec![node("n1", "document", "Doc", Some("f1"), Vec::new())],
    )];
    store.save_forest(&tree2).unwrap();
    assert!(dir.path().join("desks/d2/Doc.md").exists());
    assert!(!dir.path().join("desks/d1").exists());
    // Retired, not deleted.
    let deleted: Vec<_> = fs::read_dir(dir.path().join("desks/.deleted"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(deleted.len(), 1);
}

#[test]
fn vanished_nodes_park_files_in_orphans() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "keep me").unwrap();

    let tree = vec![desk_with(vec![node("n1", "document", "Doc", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();

    // Node vanishes without delete_by_id (e.g. a buggy tree write).
    let tree2 = vec![desk_with(Vec::new())];
    store.save_forest(&tree2).unwrap();
    assert!(!dir.path().join("desks/d1/Doc.md").exists());
    let orphan = dir.path().join("desks/d1/.hush/orphans/Doc.md");
    assert!(orphan.exists());
    assert_eq!(fs::read_to_string(&orphan).unwrap(), "keep me");
}

#[test]
fn straggler_files_keep_their_placement() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "content").unwrap();
    let tree = vec![desk_with(vec![node("n1", "document", "Doc", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();

    // The node re-appears as a top-level straggler (transient state
    // between a sync-shaped import and the boot absorption pass).
    let tree2 = vec![
        desk_with(Vec::new()),
        node("loose", "folder", "Loose", None, vec![node("n1", "document", "Doc", Some("f1"), Vec::new())]),
    ];
    store.save_forest(&tree2).unwrap();
    // Not orphaned — still readable through the index at its old path.
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "content");
    assert!(dir.path().join("desks/d1/Doc.md").exists());
    // And the straggler round-trips through load_forest.
    let forest = store.load_forest().unwrap();
    assert_eq!(forest.len(), 2);
    assert_eq!(forest[1].name, "Loose");
}

#[test]
fn sibling_name_collisions_dedupe() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    for id in ["f1", "f2"] {
        store.stage_new(id).unwrap();
        store.write_by_id(id, id).unwrap();
    }
    let tree = vec![desk_with(vec![
        node("n1", "document", "Same", Some("f1"), Vec::new()),
        node("n2", "document", "Same", Some("f2"), Vec::new()),
    ])];
    store.save_forest(&tree).unwrap();
    assert!(dir.path().join("desks/d1/Same.md").exists());
    assert!(dir.path().join("desks/d1/Same (2).md").exists());
}

#[test]
fn rename_by_id_moves_in_place() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "text").unwrap();
    let tree = vec![desk_with(vec![node("n1", "document", "Old", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();

    store.rename_by_id("f1", "New name").unwrap();
    assert!(dir.path().join("desks/d1/New name.md").exists());
    assert!(!dir.path().join("desks/d1/Old.md").exists());
    let (content, _, name) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "text");
    assert_eq!(name, "New name");
}

#[test]
fn delete_by_id_removes_file_and_index_entry() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    store.stage_new("f1").unwrap();
    let tree = vec![desk_with(vec![node("n1", "document", "Doc", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();
    store.delete_by_id("f1").unwrap();
    assert!(!dir.path().join("desks/d1/Doc.md").exists());
    assert!(store.locate("f1").is_none());
}

#[test]
fn sanitize_and_dedupe_rules() {
    assert_eq!(sanitize_segment("a/b\\c:d"), "a-b-c-d");
    assert_eq!(sanitize_segment("  .hidden "), "hidden");
    assert_eq!(sanitize_segment(""), "Untitled");
    // Display names that already carry the extension don't double it.
    let mut used = std::collections::HashSet::new();
    assert_eq!(dedupe("notes.md", ".md", &mut used), "notes.md");
}

#[test]
fn forest_round_trips_and_adopts_unlisted_desks() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    let tree = vec![
        desk_with(vec![node("n1", "document", "Doc", Some("f1"), Vec::new())]),
        node("d9", "desk", "Second", None, Vec::new()),
    ];
    store.stage_new("f1").unwrap();
    store.save_forest(&tree).unwrap();

    let loaded = store.load_forest().unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "d1");
    assert_eq!(loaded[1].name, "Second");

    // Drop d9 from order.json — load_forest should still adopt it from disk.
    let order = serde_json::json!({ "order": ["d1"], "stragglers": [] });
    fs::write(store.order_path(), serde_json::to_string(&order).unwrap()).unwrap();
    let loaded2 = store.load_forest().unwrap();
    assert_eq!(loaded2.len(), 2);
}

#[test]
fn migrates_flat_store_end_to_end() {
    let dir = tmp();
    let data = dir.path();
    let files = data.join("files");
    fs::create_dir_all(files.join("images")).unwrap();

    // Old-world payloads.
    let entry = serde_json::json!({ "id": "f1", "name": "Doc", "content": "# Hi", "modified": 5 });
    fs::write(files.join("f1.json"), entry.to_string()).unwrap();
    let nb = serde_json::json!({
        "id": "f2", "name": "Untitled",
        "content": r#"{"format":"hushnote","version":1,"shapes":[]}"#, "modified": 6
    });
    fs::write(files.join("f2.json"), nb.to_string()).unwrap();
    fs::write(files.join("images").join("cow.png"), b"pngbytes").unwrap();

    let mut images = node("__images__:d1", "folder", "Images", None, Vec::new());
    images.children.push(node("i1", "image", "cow.png", Some("cow.png"), Vec::new()));
    let desk = node(
        "d1",
        "desk",
        "Personal",
        None,
        vec![
            node(
                "__inbox__:d1",
                "project",
                "Inbox",
                None,
                vec![node("n1", "document", "Doc", Some("f1"), Vec::new())],
            ),
            node("n2", "notebook", "Sketch", Some("f2"), Vec::new()),
            images,
            node("__trash__:d1", "folder", "Trash", None, Vec::new()),
        ],
    );
    fs::write(
        data.join("file_tree.json"),
        serde_json::to_string(&vec![desk]).unwrap(),
    )
    .unwrap();

    assert!(migrate_from_flat(data).unwrap());
    assert!(!migrate_from_flat(data).unwrap()); // idempotent

    let store = DeskStore::new(data);
    assert_eq!(
        fs::read_to_string(data.join("desks/d1/Inbox/Doc.md")).unwrap(),
        "# Hi"
    );
    assert!(data.join("desks/d1/Sketch.hushnote").exists());
    assert_eq!(
        fs::read(data.join("desks/d1/Images/cow.png")).unwrap(),
        b"pngbytes"
    );
    assert!(data.join("file_tree.json.pre-desks.bak").exists());
    assert!(!data.join("file_tree.json").exists());

    let forest = store.load_forest().unwrap();
    assert_eq!(forest.len(), 1);
    assert_eq!(forest[0].children[0].children[0].name, "Doc");
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "# Hi");
}
