//! Name collisions and duplicated identities inside a desk folder — the
//! shapes behind "an update made a `(2)` copy and then both copies were
//! wrong".
//!
//! Every one of these ends the same way when nothing stops it: a fileId
//! is recorded at a path that holds *another* file's bytes. The document
//! open in the editor autosaves through that id, so its text lands on top
//! of the other file, and the bytes it used to own resurface as a
//! "new" file with a fresh id — the duplicate. Two rows, two files, and
//! neither one holding what it did.

use super::*;

/// A local desk holding `files` (name, fileId, content) at the root, as
/// the store itself would have placed them.
fn local_desk(files: &[(&str, &str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, DeskStore, std::path::PathBuf) {
    let data = tmp();
    let store = DeskStore::new(data.path());
    let mut kids = Vec::new();
    for (i, (name, id, body)) in files.iter().enumerate() {
        store.stage_new(id).unwrap();
        store.write_by_id(id, body).unwrap();
        kids.push(node(&format!("n{}", i), "document", name, Some(id), Vec::new()));
    }
    store.save_forest(&[desk_with_id("d1", kids)]).unwrap();
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();
    (data, external, store, folder)
}

fn rows<'a>(nodes: &'a [TreeNode], file_id: &str, out: &mut Vec<&'a TreeNode>) {
    for n in nodes {
        if n.file_id.as_deref() == Some(file_id) {
            out.push(n);
        }
        rows(&n.children, file_id, out);
    }
}

fn row_count(desk: &TreeNode, file_id: &str) -> usize {
    let mut out = Vec::new();
    rows(&desk.children, file_id, &mut out);
    out.len()
}

/// Renaming the open doc onto a name the folder already holds — a file
/// the far device just delivered, which this window's tree hasn't
/// reloaded yet. The first-line naming rule does exactly this on every
/// typing pause, so it is the ordinary path, not an exotic one.
///
/// `rename_by_id` sees the collision and leaves the file where it is; the
/// tree save that follows then asks `place_file` for the occupied path,
/// which declines to clobber — and the index records the move anyway.
#[test]
fn renaming_onto_an_occupied_name_never_takes_the_other_files_bytes() {
    let (_d, _e, store, folder) = local_desk(&[("Bar", "x", "x's own text")]);

    // The far device's file lands, with its id published in the index.
    fs::write(folder.join("Foo.md"), "the far device's text").unwrap();
    let mut index = store.load_index("d1");
    index.insert("t".into(), "Foo.md".into());
    store.save_index("d1", &index).unwrap();

    // Our window renames x to "Foo" (no row for t yet, so the JS side's
    // unique-name check sees no clash), saves the tree, then autosaves.
    store.rename_by_id("x", "Foo").unwrap();
    let tree = vec![desk_with_id("d1", vec![node("n0", "document", "Foo", Some("x"), Vec::new())])];
    store.save_forest(&tree).unwrap();
    store.write_by_id("x", "x's own text, edited").unwrap();

    assert_eq!(
        fs::read_to_string(folder.join("Foo.md")).unwrap(),
        "the far device's text",
        "x's autosave overwrote another file",
    );
    assert_eq!(store.read_by_id("t").unwrap().0, "the far device's text");
    assert_eq!(store.read_by_id("x").unwrap().0, "x's own text, edited");
    let index = store.load_index("d1");
    assert_ne!(index.get("x"), index.get("t"), "two ids share one path");
}

/// Two same-named siblings sit at `Foo.md` and `Foo (2).md` purely by
/// tree order. Reorder them and the computed paths swap — and since
/// neither destination is free, `place_file` moves nothing while the
/// index takes the swap. Each id now reads the other's bytes.
#[test]
fn reordering_same_named_siblings_does_not_swap_their_contents() {
    let (_d, _e, store, _folder) = local_desk(&[("Foo", "x", "x body"), ("Foo", "y", "y body")]);
    let x = node("n0", "document", "Foo", Some("x"), Vec::new());
    let y = node("n1", "document", "Foo", Some("y"), Vec::new());
    store.save_forest(&[desk_with_id("d1", vec![y, x])]).unwrap();

    assert_eq!(store.read_by_id("x").unwrap().0, "x body");
    assert_eq!(store.read_by_id("y").unwrap().0, "y body");
}

/// The reconciler mints an id for a file whose index entry hadn't landed,
/// then — seeing the far device's index arrive mid-pass — hands the row
/// the published id instead. When that id is one the tree *already* has
/// a row for (the far device renamed an existing doc), the desk ends up
/// with two rows for one file: the "duplicate" in the sidebar, where
/// trashing either one trashes both.
#[test]
fn yielding_a_minted_id_never_leaves_two_rows_for_one_file() {
    let mut desk = desk_with_id("d1", vec![
        node("n0", "document", "Foo", Some("x"), Vec::new()),
        node("n1", "document", "Foo bar", Some("minted"), Vec::new()),
    ]);
    let mut index: HashMap<String, String> =
        [("minted".to_string(), "Foo bar.md".to_string())].into_iter().collect();
    let published: HashMap<String, String> =
        [("x".to_string(), "Foo bar.md".to_string())].into_iter().collect();
    let mut hashes = HashMap::new();
    crate::desk_scan::defer_to_published(
        &[("minted".to_string(), "Foo bar.md".to_string())],
        &published,
        &mut index,
        &mut desk,
        &mut hashes,
    );
    assert_eq!(row_count(&desk, "x"), 1, "the tree now holds two rows for x");
}

/// Two rows for one fileId in a saved tree: the file follows whichever
/// row `collect_expected` walks last. Trashing the row the user thinks is
/// the duplicate trashes the only file.
#[test]
fn a_tree_with_two_rows_for_one_file_is_repaired_before_it_moves_anything() {
    let (_d, _e, store, folder) = local_desk(&[("Foo", "x", "the only copy")]);
    let tree = vec![desk_with_id("d1", vec![
        node("n0", "document", "Foo", Some("x"), Vec::new()),
        node("__trash__:d1", "folder", "Trash", None, vec![
            node("dup", "document", "Foo", Some("x"), Vec::new()),
        ]),
    ])];
    let repaired = store.save_forest(&tree).unwrap();

    assert!(folder.join("Foo.md").exists(), "the file followed the duplicate row into the Trash");
    let desk = repaired.expect("the store should hand back a repaired tree");
    assert_eq!(row_count(&desk[0], "x"), 1);
}

/// The reconciler's re-key pass: a row whose id resolves to nothing takes
/// the id the index publishes for its path — even when another row
/// already carries that id.
#[test]
fn rekeying_a_stale_row_never_duplicates_a_live_one() {
    let (_d, _e, store, folder) = local_desk(&[("Foo", "t", "t body")]);
    // Our tree: t's row (listed second, so it computes `Foo (2).md`) and a
    // stale row ahead of it whose id nothing publishes.
    let tree = desk_with_id("d1", vec![
        node("stale", "document", "Foo", Some("s"), Vec::new()),
        node("n0", "document", "Foo", Some("t"), Vec::new()),
    ]);
    fs::write(
        folder.join(".hush/tree.json"),
        serde_json::to_string_pretty(&tree).unwrap(),
    )
    .unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();
    let desk = store.load_desk_tree("d1").unwrap();
    assert_eq!(row_count(&desk, "t"), 1, "two rows now claim t");
    assert_eq!(store.read_by_id("t").unwrap().0, "t body");
}

/// The end-to-end shape of "an update made a duplicate": the other device
/// edits a doc's first line, so the naming rule renames its file. Here the
/// renamed file (with new bytes, so the hash can't pair it) lands before
/// the index that names it; the reconciler mints an id for it. Then the
/// far device's `index.json` lands, naming the file by the id the doc
/// always had — and the minted row is re-keyed onto that id, beside the
/// row that already carried it. Two rows, one file.
#[test]
fn a_title_edited_on_the_other_device_never_leaves_a_duplicate_row() {
    let (_d, _e, store, folder) = local_desk(&[("Foo", "x", "Foo\nbody")]);
    store.reconcile_desk_from_disk("d1").unwrap();

    // The far device renames Foo.md → Foo bar.md with an edited body.
    fs::remove_file(folder.join("Foo.md")).unwrap();
    fs::write(folder.join("Foo bar.md"), "Foo bar\nbody, edited elsewhere").unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    // Its index.json lands — whole-file, last writer wins, and the far
    // device never saw the id we minted.
    let theirs: HashMap<String, String> =
        [("x".to_string(), "Foo bar.md".to_string())].into_iter().collect();
    fs::write(
        folder.join(".hush/index.json"),
        serde_json::to_string_pretty(&serde_json::json!({ "files": theirs })).unwrap(),
    )
    .unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();

    let desk = store.load_desk_tree("d1").unwrap();
    assert_eq!(row_count(&desk, "x"), 1, "the doc shows twice in the sidebar");
    let mut ids = Vec::new();
    crate::desk_store::collect_file_ids(&desk.children, &mut ids);
    assert_eq!(ids.len(), 1, "a second id is still hanging around: {:?}", ids);
    assert_eq!(store.read_by_id("x").unwrap().0, "Foo bar\nbody, edited elsewhere");
}

/// On macOS the same file answers to `My title.md` and `my title.md`.
/// Changing only the case of a title (the naming rule does it as you
/// type) must rename the file, not leave the index spelling it one way
/// and the folder the other — the reconciler then sees an unindexed
/// file, mints an id for it, and the doc appears twice, both rows backed
/// by one file. Simulated here with a hard link: two names, one file.
#[cfg(unix)]
#[test]
fn a_second_name_for_an_indexed_file_is_not_a_new_file() {
    let (_d, _e, store, folder) = local_desk(&[("my title", "x", "body")]);
    fs::hard_link(folder.join("my title.md"), folder.join("My title.md")).unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.added, 0, "the same file under a second spelling was minted as new");
    let desk = store.load_desk_tree("d1").unwrap();
    let mut ids = Vec::new();
    crate::desk_store::collect_file_ids(&desk.children, &mut ids);
    assert_eq!(ids.len(), 1);
}

/// A file parked on `Foo (2).md` because `Foo.md` was taken moves home
/// when the occupant leaves in the same save — it doesn't stay parked
/// just because it was parked before.
#[test]
fn a_parked_file_moves_home_when_the_occupant_leaves_in_the_same_save() {
    let (_d, _e, store, folder) = local_desk(&[("Foo", "y", "y body"), ("Foo", "x", "x body")]);
    assert!(folder.join("Foo (2).md").exists());
    // y goes to the Trash; x is now the only "Foo" and wants Foo.md.
    let tree = vec![desk_with_id("d1", vec![
        node("n1", "document", "Foo", Some("x"), Vec::new()),
        node("__trash__:d1", "folder", "Trash", None, vec![
            node("n0", "document", "Foo", Some("y"), Vec::new()),
        ]),
    ])];
    store.save_forest(&tree).unwrap();
    assert_eq!(store.load_index("d1").get("x").map(String::as_str), Some("Foo.md"));
    assert_eq!(store.read_by_id("x").unwrap().0, "x body");
    assert_eq!(store.read_by_id("y").unwrap().0, "y body");
    assert!(!folder.join("Foo (2).md").exists());
}

/// And one whose occupant stays put stays parked, rather than moving to
/// a fresh ` (3)` on every save.
#[test]
fn a_parked_file_stays_parked_while_the_name_is_still_taken() {
    let (_d, _e, store, folder) = local_desk(&[("Bar", "x", "x body")]);
    fs::write(folder.join("Foo.md"), "someone else's").unwrap();
    let tree = vec![desk_with_id("d1", vec![node("n0", "document", "Foo", Some("x"), Vec::new())])];
    store.save_forest(&tree).unwrap();
    store.save_forest(&tree).unwrap();
    assert_eq!(store.load_index("d1").get("x").map(String::as_str), Some("Foo (2).md"));
    assert!(!folder.join("Foo (3).md").exists());
    assert_eq!(fs::read_to_string(folder.join("Foo.md")).unwrap(), "someone else's");
}
