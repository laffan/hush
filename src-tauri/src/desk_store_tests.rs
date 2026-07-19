//! Unit tests for the desk-folder store (tempdir-backed).

use super::*;
use crate::desk_migrate::migrate_from_flat;
use crate::desk_paths::{dedupe, sanitize_segment};
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
        ..Default::default()
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

// ===== Phase 3: local desk roots =====

#[test]
fn make_local_redirects_everything_and_round_trips() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("My Desk");
    let store = seed_simple_desk(dir.path());

    store.make_desk_local("d1", &target, None).unwrap();
    // Folder moved wholesale; internal dir gone.
    assert!(target.join(".hush/tree.json").exists());
    assert!(target.join("Doc.md").exists());
    assert!(!dir.path().join("desks/d1").exists());

    // Reads, writes, and tree saves all resolve through the redirect.
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    store.write_by_id("f1", "edited").unwrap();
    assert_eq!(fs::read_to_string(target.join("Doc.md")).unwrap(), "edited");
    let tree = vec![desk_with_id("d1", vec![node("n1", "document", "Renamed", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();
    assert!(target.join("Renamed.md").exists());

    // Back to internal.
    let internal = store.make_desk_internal("d1").unwrap();
    assert!(internal.join("Renamed.md").exists());
    assert!(!target.exists(), "emptied external folder is removed");
    assert!(store.list_roots().is_empty());
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "edited");
}

#[test]
fn make_local_refuses_bad_targets() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    // Inside app data.
    let inside = dir.path().join("nested");
    assert!(store.make_desk_local("d1", &inside, None).is_err());
    // Non-empty target.
    let external = tmp();
    fs::write(external.path().join("occupied.txt"), "x").unwrap();
    assert!(store.make_desk_local("d1", external.path(), None).is_err());
}

#[test]
fn adopt_registers_a_foreign_desk_folder() {
    // Build a desk in one install...
    let install_a = tmp();
    let store_a = seed_simple_desk(install_a.path());
    let external = tmp();
    let target = external.path().join("Shared Desk");
    store_a.make_desk_local("d1", &target, None).unwrap();

    // ...and adopt it from a second install.
    let install_b = tmp();
    let store_b = DeskStore::new(install_b.path());
    let desk_id = store_b.adopt_desk_folder(&target, None).unwrap();
    assert_eq!(desk_id, "d1");
    let forest = store_b.load_forest().unwrap();
    assert_eq!(forest.len(), 1);
    assert_eq!(forest[0].name, "Personal");
    let (content, _, _) = store_b.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    // Double-adopt refuses.
    assert!(store_b.adopt_desk_folder(&target, None).is_err());
}

#[test]
fn deleting_a_local_desk_unregisters_without_touching_the_folder() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();

    // Desk vanishes from the tree (deleted) while another desk remains.
    let tree = vec![node("d2", "desk", "Other", None, Vec::new())];
    store.save_forest(&tree).unwrap();
    assert!(target.join("Doc.md").exists(), "user folder untouched");
    assert!(store.list_roots().is_empty(), "root unregistered");
}

#[test]
fn reconcile_from_disk_follows_external_adds_and_removes() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();

    // No-op on an unchanged folder.
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert!(!report.changed());

    // Another app drops files in (root + nested new folder)...
    fs::write(target.join("From Finder.md"), "external").unwrap();
    fs::create_dir_all(target.join("Research/Papers")).unwrap();
    fs::write(target.join("Research/Papers/notes.txt"), "n").unwrap();
    // ...and deletes the original doc.
    fs::remove_file(target.join("Doc.md")).unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.added, 2);
    assert_eq!(report.removed, 1);

    let forest = store.load_forest().unwrap();
    let desk = &forest[0];
    assert!(desk.children.iter().any(|n| n.name == "From Finder"));
    let research = desk.children.iter().find(|n| n.name == "Research").unwrap();
    assert_eq!(research.node_type, "folder");
    assert_eq!(research.children[0].name, "Papers");
    assert_eq!(research.children[0].children[0].name, "notes");
    assert!(!desk.children.iter().any(|n| n.name == "Doc"));

    // The adopted files read back through the normal id path.
    let added = desk.children.iter().find(|n| n.name == "From Finder").unwrap();
    let (content, _, _) = store.read_by_id(added.file_id.as_ref().unwrap()).unwrap();
    assert_eq!(content, "external");
}

#[test]
fn reconcile_pairs_external_rename_by_content_hash() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap(); // seeds the hash cache

    fs::rename(target.join("Doc.md"), target.join("Renamed.md")).unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.renamed, 1);
    assert_eq!(report.added, 0);
    assert_eq!(report.removed, 0);

    // Same fileId — history, panes, recents all survive the rename.
    let forest = store.load_forest().unwrap();
    let renamed = forest[0].children.iter().find(|n| n.name == "Renamed").unwrap();
    assert_eq!(renamed.file_id.as_deref(), Some("f1"));
    let (content, _, name) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    assert_eq!(name, "Renamed");
}

#[test]
fn reconcile_pairs_external_move_into_new_folder() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    fs::create_dir_all(target.join("Archive")).unwrap();
    fs::rename(target.join("Doc.md"), target.join("Archive").join("Doc.md")).unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.renamed, report.added, report.removed), (1, 0, 0));

    let forest = store.load_forest().unwrap();
    let archive = forest[0].children.iter().find(|n| n.name == "Archive").unwrap();
    assert_eq!(archive.node_type, "folder");
    assert_eq!(archive.children[0].file_id.as_deref(), Some("f1"));
}

#[test]
fn rename_pairing_works_from_save_time_hashes() {
    // No prior reconcile: the hash recorded by write_by_id alone must
    // be enough to pair a Finder rename that happens right after a save.
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.write_by_id("f1", "updated").unwrap();

    fs::rename(target.join("Doc.md"), target.join("Other.md")).unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.renamed, 1);
    let (content, _, name) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "updated");
    assert_eq!(name, "Other");
}

#[test]
fn rename_with_changed_content_falls_back_to_remove_plus_add() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    fs::remove_file(target.join("Doc.md")).unwrap();
    fs::write(target.join("Different.md"), "not the same bytes").unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.renamed, report.added, report.removed), (0, 1, 1));
    assert!(store.read_by_id("f1").is_err());
}

#[test]
fn conflict_sibling_patterns_resolve_to_originals() {
    use crate::desk_conflicts::original_for_conflict;
    assert_eq!(
        original_for_conflict("Doc (nate's conflicted copy 2026-07-13).md").as_deref(),
        Some("Doc.md")
    );
    assert_eq!(
        original_for_conflict("Doc (conflicted copy).md").as_deref(),
        Some("Doc.md")
    );
    assert_eq!(
        original_for_conflict("Doc.sync-conflict-20260713-123456-ABCDEF7.md").as_deref(),
        Some("Doc.md")
    );
    // Not conflict markers.
    assert_eq!(original_for_conflict("Doc (draft).md"), None);
    assert_eq!(original_for_conflict("Doc 2.md"), None); // iCloud's pattern is too ambiguous
    assert_eq!(original_for_conflict("Doc.md"), None);
}

#[test]
fn newer_conflicted_copy_wins_and_both_sides_are_snapshotted() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    std::thread::sleep(std::time::Duration::from_millis(15));
    fs::write(
        target.join("Doc (nate's conflicted copy 2026-07-13).md"),
        "the other device's edit",
    )
    .unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.conflicts, 1);
    assert_eq!((report.added, report.removed, report.renamed), (0, 0, 0));

    // Newer bytes won the real path; the sibling is gone.
    assert_eq!(store.read_by_id("f1").unwrap().0, "the other device's edit");
    assert!(!target.join("Doc (nate's conflicted copy 2026-07-13).md").exists());

    // Both sides live on in Versions under the same fileId.
    let snaps = crate::snapshots::SnapshotManager::new(dir.path());
    let entries = snaps.get_snapshots("f1").unwrap();
    let contents: Vec<&str> = entries.iter().map(|e| e.content.as_str()).collect();
    assert!(contents.contains(&"body"));
    assert!(contents.contains(&"the other device's edit"));
}

#[test]
fn older_conflicted_copy_is_archived_without_touching_the_file() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    fs::write(
        target.join("Doc.sync-conflict-20260713-123456-ABCDEF7.md"),
        "stale fork",
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(15));
    store.write_by_id("f1", "fresh local edit").unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.conflicts, 1);
    assert_eq!(store.read_by_id("f1").unwrap().0, "fresh local edit");
    assert!(!target.join("Doc.sync-conflict-20260713-123456-ABCDEF7.md").exists());
    let snaps = crate::snapshots::SnapshotManager::new(dir.path());
    let contents: Vec<String> = snaps
        .get_snapshots("f1")
        .unwrap()
        .into_iter()
        .map(|e| e.content)
        .collect();
    assert!(contents.iter().any(|c| c == "stale fork"));
}

#[test]
fn conflicted_copy_replaces_a_vanished_original() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    fs::remove_file(target.join("Doc.md")).unwrap();
    fs::write(target.join("Doc (conflicted copy).md"), "survivor").unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.conflicts, 1);
    assert_eq!((report.added, report.removed), (0, 0));
    assert_eq!(store.read_by_id("f1").unwrap().0, "survivor");
}

/// A one-desk store with a single placed doc `f1` ("body") named Doc.
fn seed_simple_desk(data_dir: &std::path::Path) -> DeskStore {
    let store = DeskStore::new(data_dir);
    store.stage_new("f1").unwrap();
    store.write_by_id("f1", "body").unwrap();
    let tree = vec![desk_with_id("d1", vec![node("n1", "document", "Doc", Some("f1"), Vec::new())])];
    store.save_forest(&tree).unwrap();
    store
}

fn desk_with_id(id: &str, children: Vec<TreeNode>) -> TreeNode {
    node(id, "desk", "Personal", None, children)
}
