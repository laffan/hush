//! The `index.json` ↔ `tree.json` contract, across two installs sharing
//! one folder.
//!
//! Both sidecars are whole-file writes that sync independently, and
//! either can arrive stale. These tests pin the four repairs that keep
//! them agreeing without either one ever inferring a deletion: the merged
//! index write, the restored row, the placement rebase that stops a save
//! asserting a move it didn't make, and the relocate that makes the row
//! follow the file. See `desk_index.rs`.

use super::*;

/// The index is a *shared* file that both installs write whole, so a
/// plain replace erases whatever the other published in between —
/// including the ids for files **we** created. Those rows then resolve
/// to nothing, get re-keyed to the far device's ids, and every write
/// aimed at the old id falls through to per-device staging. (Observed:
/// `rekeyed: 6` on both machines, then "couldn't find the row" for our
/// own probes.) An entry we don't claim, for a file that really exists,
/// is knowledge the other device has and we don't — keep it.
#[test]
fn saving_the_index_keeps_what_the_far_device_published() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    // The far device adds a file and publishes its id for it.
    fs::write(folder.join("Theirs.md"), "theirs").unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-id".into(), "Theirs.md".into());
    store.save_index("d1", &index).unwrap();
    // ...along with one for a file that has since gone.
    index.insert("stale-id".into(), "Gone.md".into());
    store.save_index("d1", &index).unwrap();

    // We save a tree that knows nothing about any of it.
    let tree = vec![desk_with_id("d1", vec![
        node("n1", "document", "Doc", Some("f1"), Vec::new()),
    ])];
    store.save_forest(&tree).unwrap();

    let saved = store.load_index("d1");
    assert_eq!(saved.get("f1").map(String::as_str), Some("Doc.md"), "our own entry stands");
    assert_eq!(
        saved.get("their-id").map(String::as_str), Some("Theirs.md"),
        "the far device's entry survives our write",
    );
    assert!(!saved.contains_key("stale-id"), "but only for files that are really there");
    // And the far device's file is still readable through the id it published.
    let (content, _, _) = store.read_by_id("their-id").unwrap();
    assert_eq!(content, "theirs");
}

/// The merge must not resurrect what we deliberately moved: trashing a
/// file changes its path, and the old entry is the same id, not a
/// second one.
#[test]
fn merging_the_index_does_not_resurrect_a_moved_file() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    let tree = vec![desk_with_id("d1", vec![
        node("__trash__:d1", "folder", "Trash", None, vec![
            node("n1", "document", "Doc", Some("f1"), Vec::new()),
        ]),
    ])];
    store.save_forest(&tree).unwrap();

    let saved = store.load_index("d1");
    assert_eq!(saved.get("f1").map(String::as_str), Some("Trash/Doc.md"));
    assert_eq!(saved.len(), 1, "one entry, at the new path: {:?}", saved);
    assert!(folder.join("Trash/Doc.md").exists());
    assert!(!folder.join("Doc.md").exists());
}

/// The other half of the merge rule. Keeping an index entry is only
/// worth anything if the file is still *reachable* — and a `tree.json`
/// can lose the row while the index keeps the entry (a stale tree save,
/// or a tree that arrived from the far device before the rows it will
/// name). The additions pass can't help: the path is already claimed, so
/// the file never reads as new. It has to get its row back under the id
/// the index publishes, in the folder its path says.
#[test]
fn an_indexed_file_with_no_tree_row_gets_one_back() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    // Two files the far device published ids for, one nested.
    fs::create_dir_all(folder.join("2026")).unwrap();
    fs::write(folder.join("Loose.md"), "loose").unwrap();
    fs::write(folder.join("2026/Nested.hushnote"), "{}").unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-loose".into(), "Loose.md".into());
    index.insert("their-nested".into(), "2026/Nested.hushnote".into());
    // ...and one whose file hasn't been delivered here yet.
    index.insert("their-absent".into(), "Later.md".into());
    store.save_index("d1", &index).unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.restored, 2, "both delivered files get a row");
    assert_eq!(report.added, 0, "and keep the id already published for them");

    let desk = store.load_forest().unwrap().remove(0);
    let loose = find_by_name(&desk.children, "Loose").expect("root row restored");
    assert_eq!(loose.file_id.as_deref(), Some("their-loose"));
    assert_eq!(loose.node_type, "document");
    let year = find_by_name(&desk.children, "2026").expect("its folder restored too");
    let nested = find_by_name(&year.children, "Nested").expect("nested row restored");
    assert_eq!(nested.file_id.as_deref(), Some("their-nested"));
    assert_eq!(nested.node_type, "notebook");
    assert!(
        find_by_name(&desk.children, "Later").is_none(),
        "an undelivered file gets no row until its bytes arrive",
    );

    // Idempotent: a second pass has nothing left to restore.
    assert_eq!(store.reconcile_desk_from_disk("d1").unwrap().restored, 0);
}

fn find_by_name<'a>(nodes: &'a [TreeNode], name: &str) -> Option<&'a TreeNode> {
    nodes.iter().find(|n| n.name == name)
}

/// The trash clobber. `save_forest` computes every file's path from the
/// tree and makes the disk match — it *asserts* the tree, which is only
/// ours to do for files we moved ourselves. Two devices trashed their own
/// files seconds apart; each tree still placed the *other's* at the root,
/// and the next save on either device renamed the far device's files back
/// out of `Trash/`. Both machines then agreed on the wrong answer, which
/// is why only one device's files ever stayed deleted.
#[test]
fn a_tree_save_never_drags_the_far_devices_file_out_of_the_trash() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    // Our file plus the far device's, both at the root.
    fs::write(folder.join("Theirs.md"), "theirs").unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-id".into(), "Theirs.md".into());
    store.save_index("d1", &index).unwrap();
    let ours = node("n1", "document", "Doc", Some("f1"), Vec::new());
    let theirs = node("n2", "document", "Theirs", Some("their-id"), Vec::new());
    let at_root = |kids: Vec<TreeNode>| vec![desk_with_id("d1", kids)];
    store.save_forest(&at_root(vec![ours.clone(), theirs.clone()])).unwrap();
    assert!(folder.join("Doc.md").exists() && folder.join("Theirs.md").exists());

    // The far device trashes *its* file: the move lands on disk and in the
    // folder's index, and its `tree.json` has not arrived yet.
    fs::create_dir_all(folder.join("Trash")).unwrap();
    fs::rename(folder.join("Theirs.md"), folder.join("Trash/Theirs.md")).unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-id".into(), "Trash/Theirs.md".into());
    store.save_index("d1", &index).unwrap();

    // We trash ours, from a tree that still shows theirs at the root.
    let trash = |kids: Vec<TreeNode>| {
        vec![desk_with_id("d1", vec![node("__trash__:d1", "folder", "Trash", None, kids)])]
    };
    let mut tree = trash(vec![ours.clone()]);
    tree[0].children.push(theirs.clone());
    store.save_forest(&tree).unwrap();

    assert!(folder.join("Trash/Doc.md").exists(), "our own move must still happen");
    assert!(
        folder.join("Trash/Theirs.md").exists(),
        "the far device's file was dragged back out of the Trash",
    );
    assert!(!folder.join("Theirs.md").exists());
    assert_eq!(
        store.load_index("d1").get("their-id").map(String::as_str),
        Some("Trash/Theirs.md"),
        "and the index must say where the file actually is",
    );

    // Saving the same stale tree again must not tug it back either — the
    // frontend may not have reloaded yet.
    store.save_forest(&tree).unwrap();
    assert!(folder.join("Trash/Theirs.md").exists(), "a second stale save moved it");

    // Pulling it back out is still allowed — but only from a tree that
    // has caught up. A tree that never learned about the far move is
    // byte-identical to one whose user dragged the file out again, so the
    // only thing separating the two is having seen the move first. The
    // frontend reloads on `treeChanged` before the user can act, so this
    // is the real order; the ambiguous case resolves toward "leave it".
    let mut caught_up = trash(vec![ours]);
    caught_up[0].children[0].children.push(theirs.clone());
    store.save_forest(&caught_up).unwrap();
    store.save_forest(&at_root(vec![theirs])).unwrap();
    assert!(folder.join("Theirs.md").exists(), "a deliberate move must not be swallowed");
}

/// Keeping the far device's file in the Trash is only half the job: the
/// *row* has to follow, or our `tree.json` publishes the old position,
/// the far device reloads it, and its own deletion bounces back out a
/// beat after landing. ("I watched the files be deleted, then they popped
/// back.") The full loop, with nothing left drifting.
#[test]
fn a_far_devices_move_to_trash_reaches_our_sidebar_and_stays() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    fs::write(folder.join("Theirs.md"), "theirs").unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-id".into(), "Theirs.md".into());
    store.save_index("d1", &index).unwrap();
    let ours = node("n1", "document", "Doc", Some("f1"), Vec::new());
    let theirs = node("n2", "document", "Theirs", Some("their-id"), Vec::new());
    store.save_forest(&vec![desk_with_id("d1", vec![ours.clone(), theirs.clone()])]).unwrap();

    // The far device trashes its file: the move lands on disk and in the
    // folder's index; its `tree.json` has not arrived.
    fs::create_dir_all(folder.join("Trash")).unwrap();
    fs::rename(folder.join("Theirs.md"), folder.join("Trash/Theirs.md")).unwrap();
    let mut index = store.load_index("d1");
    index.insert("their-id".into(), "Trash/Theirs.md".into());
    store.save_index("d1", &index).unwrap();

    // We trash ours from a tree that still shows theirs at the root. The
    // file stays put (the rebase) — and the row has to catch up.
    let mut stale = vec![desk_with_id("d1", vec![
        node("__trash__:d1", "folder", "Trash", None, vec![ours]),
    ])];
    stale[0].children.push(theirs);
    store.save_forest(&stale).unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.relocated, 1, "the row must follow the file into Trash");
    assert_eq!(report.removed, 0, "nothing was deleted, only moved");

    let desk = store.load_forest().unwrap().remove(0);
    let trash = find_by_name(&desk.children, "Trash").expect("Trash special");
    let names: Vec<&str> = trash.children.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains(&"Theirs"), "far device's row is still outside Trash: {:?}", names);
    assert!(names.contains(&"Doc"), "our own row left the Trash: {:?}", names);
    assert!(
        !desk.children.iter().any(|n| n.name == "Theirs"),
        "the row was copied into Trash rather than moved",
    );

    // And it holds: saving the reloaded tree must not push anything back.
    store.save_forest(&vec![desk]).unwrap();
    assert!(folder.join("Trash/Theirs.md").exists(), "the file bounced out of the Trash");
    assert!(folder.join("Trash/Doc.md").exists());
    assert_eq!(store.reconcile_desk_from_disk("d1").unwrap().relocated, 0, "should be settled");
}

/// A move whose file was *also* edited still has to pair. Hash pairing
/// only recognises bytes we last saw, so a file the far device moved to
/// Trash after both machines wrote into it arrived unrecognised: a fresh
/// id minted for a file that already had one, and the old row left
/// haunting its folder for the ten-minute grace window (`added: 3,
/// pending: 3` in a log where nothing had been created). A move keeps the
/// filename; a rename is what the hash pass is for.
#[test]
fn a_move_pairs_by_name_when_the_bytes_changed_too() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();
    fs::write(folder.join("Doc.md"), "original").unwrap();
    store.reconcile_desk_from_disk("d1").unwrap();
    let id = store
        .load_index("d1")
        .into_iter()
        .find(|(_, rel)| rel == "Doc.md")
        .map(|(id, _)| id)
        .expect("indexed");

    // The far device edits it *and* moves it to Trash — one arrives as
    // the other, and the bytes no longer match anything we cached.
    fs::create_dir_all(folder.join("Trash")).unwrap();
    fs::rename(folder.join("Doc.md"), folder.join("Trash/Doc.md")).unwrap();
    fs::write(folder.join("Trash/Doc.md"), "original plus the far edit").unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.renamed, 1, "the move must pair: {:?}", report);
    assert_eq!(report.added, 0, "no fresh id for a file that already had one");
    assert_eq!(report.pending, 0, "and no ghost row waiting out the grace window");
    assert_eq!(
        store.load_index("d1").get(&id).map(String::as_str),
        Some("Trash/Doc.md"),
        "the file keeps its id at the new path",
    );

    let desk = store.load_forest().unwrap().remove(0);
    let trash = find_by_name(&desk.children, "Trash").expect("Trash special");
    assert_eq!(trash.children.len(), 1, "one row, in Trash");
    assert_eq!(trash.children[0].file_id.as_deref(), Some(id.as_str()));
    assert!(!desk.children.iter().any(|n| n.name == "Doc"), "the old row lingered");
}
