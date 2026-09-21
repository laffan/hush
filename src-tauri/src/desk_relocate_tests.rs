//! Rename / Move a local desk's folder. Split out of
//! `desk_store_tests.rs` for the line cap; `use super::*` pulls in that
//! module's helpers (`node`, `tmp`, `seed_simple_desk`, `desk_with_id`)
//! along with everything `desk_store.rs` re-exports into scope.
//!
//! These read back through the store rather than the filesystem wherever
//! they can: the thing being tested is not "did a directory move" but
//! "does the desk still resolve, from a fresh read, after it did".

use super::*;

/// Register a desk at an external folder the tests can then relocate.
fn seed_local_desk(data_dir: &std::path::Path, root: &std::path::Path) -> DeskStore {
    let store = seed_simple_desk(data_dir);
    store.make_desk_local("d1", root, None).unwrap();
    store
}

#[test]
fn rename_moves_the_folder_and_the_desk_still_resolves() {
    let dir = tmp();
    let external = tmp();
    let before = external.path().join("Daily Notse");
    let store = seed_local_desk(dir.path(), &before);

    let after = store.rename_desk_root("d1", "Daily Notes").unwrap();
    assert_eq!(after, external.path().join("Daily Notes"));
    assert!(!before.exists(), "the old folder name is gone");
    assert!(after.join("Doc.md").exists());
    assert!(after.join(".hush/tree.json").exists());

    // The registration followed, and every read resolves through it.
    assert_eq!(
        store.list_roots().get("d1").map(String::as_str),
        Some(after.to_string_lossy().as_ref()),
    );
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    // A fresh store (a relaunch) reads the same answer off roots.json.
    let reopened = DeskStore::new(dir.path());
    let (content, _, _) = reopened.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    let forest = reopened.load_forest().unwrap();
    assert_eq!(forest.len(), 1);
    assert_eq!(forest[0].children.len(), 1);
}

#[test]
fn rename_refuses_names_that_would_break_or_collide() {
    let dir = tmp();
    let external = tmp();
    let root = external.path().join("Desk");
    let store = seed_local_desk(dir.path(), &root);
    fs::create_dir_all(external.path().join("Taken")).unwrap();

    assert!(store.rename_desk_root("d1", "Taken").is_err(), "name already on disk");
    assert!(store.rename_desk_root("d1", "a/b").is_err(), "path separator");
    assert!(store.rename_desk_root("d1", "   ").is_err(), "blank");
    assert!(store.rename_desk_root("d1", ".hidden").is_err(), "would hide the folder");
    // An internal desk has no folder of its own to rename.
    assert!(store.rename_desk_root("nope", "Whatever").is_err());
    // Every refusal left the desk exactly where it was.
    assert!(root.join("Doc.md").exists());
    assert_eq!(
        store.list_roots().get("d1").map(String::as_str),
        Some(root.to_string_lossy().as_ref()),
    );
}

#[test]
fn rename_to_the_same_name_is_a_no_op_rather_than_a_collision() {
    let dir = tmp();
    let external = tmp();
    let root = external.path().join("Desk");
    let store = seed_local_desk(dir.path(), &root);
    // The folder is already called "Desk" — refusing here would read as
    // "that name is taken" about the desk's own folder.
    assert_eq!(store.rename_desk_root("d1", "Desk").unwrap(), root);
    assert!(root.join("Doc.md").exists());
}

#[test]
fn move_relocates_every_file_and_repoints_the_root() {
    let dir = tmp();
    let from_parent = tmp();
    let to_parent = tmp();
    let from = from_parent.path().join("Wrong Place");
    let store = seed_local_desk(dir.path(), &from);
    // Something nested, so the move is not just a flat directory.
    fs::create_dir_all(from.join("Inbox")).unwrap();
    fs::write(from.join("Inbox/Scratch.md"), "scratch").unwrap();

    let to = to_parent.path().join("Right Place");
    let landed = store.move_desk_root("d1", &to, None).unwrap();
    assert_eq!(landed, to);
    assert!(to.join("Doc.md").exists());
    assert!(to.join("Inbox/Scratch.md").exists());
    assert!(to.join(".hush/index.json").exists());
    assert!(!from.exists(), "the emptied source folder is cleared away");

    assert_eq!(
        store.list_roots().get("d1").map(String::as_str),
        Some(to.to_string_lossy().as_ref()),
    );
    let reopened = DeskStore::new(dir.path());
    let (content, _, _) = reopened.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
}

/// The desk's folder IS the desk, so a move takes everything in it —
/// including files Hush never indexed. That is the same contract
/// Make Desk Local has, and the alternative (leaving a stray file behind
/// in a folder the user thinks they emptied) is the worse surprise.
#[test]
fn move_takes_the_whole_folder_including_files_hush_never_indexed() {
    let dir = tmp();
    let from_parent = tmp();
    let to_parent = tmp();
    let from = from_parent.path().join("Shared");
    let store = seed_local_desk(dir.path(), &from);
    // A file Hush never indexed, sitting beside the desk.
    fs::write(from.join("receipts.pdf"), "not ours").unwrap();

    let to = to_parent.path().join("Desk");
    store.move_desk_root("d1", &to, None).unwrap();
    assert!(to.join("receipts.pdf").exists());
    assert!(!from.exists(), "nothing left behind, so the folder goes too");
}

#[test]
fn move_refuses_destinations_that_would_lose_or_swallow_the_desk() {
    let dir = tmp();
    let from_parent = tmp();
    let to_parent = tmp();
    let from = from_parent.path().join("Desk");
    let store = seed_local_desk(dir.path(), &from);

    // Inside app data.
    assert!(store.move_desk_root("d1", &dir.path().join("desks/x"), None).is_err());
    // Inside the folder being moved.
    assert!(store.move_desk_root("d1", &from.join("inner"), None).is_err());
    // Occupied.
    let occupied = to_parent.path().join("Busy");
    fs::create_dir_all(&occupied).unwrap();
    fs::write(occupied.join("something.txt"), "x").unwrap();
    assert!(store.move_desk_root("d1", &occupied, None).is_err());
    // Relative.
    assert!(store.move_desk_root("d1", std::path::Path::new("relative"), None).is_err());
    // A desk with no folder has nothing to move.
    assert!(store.move_desk_root("d2", &to_parent.path().join("New"), None).is_err());

    // Every refusal left the desk where it was, intact.
    assert!(from.join("Doc.md").exists());
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
}

#[test]
fn moving_to_where_the_desk_already_is_changes_nothing() {
    let dir = tmp();
    let external = tmp();
    let root = external.path().join("Desk");
    let store = seed_local_desk(dir.path(), &root);
    assert_eq!(store.move_desk_root("d1", &root, None).unwrap(), root);
    assert!(root.join("Doc.md").exists());
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
}
