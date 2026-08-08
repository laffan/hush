//! Full New-Desk-from-Local-Folder flow test — reproduces the frontend's
//! exact call sequence after `desk_open_folder_as_desk` returns, to prove
//! a folder's pre-existing contents survive desk creation. The JS side
//! (sync/desk-roots.js#adoptDeskFolder) does: get_file_tree (an IPC JSON
//! round-trip), an in-memory specials reorder (state-desks.js
//! #ensureDeskSpecials), then a save_file_tree at the next boot or tree
//! mutation. Each step runs here against the real store.

use super::*;
use crate::TreeNode;

/// Mirror of state-desks.js#ensureDeskSpecials: Inbox pinned first;
/// Images / Archive / Trash pinned to the tail (Trash last).
fn js_ensure_desk_specials(desk: &mut TreeNode) {
    let move_to = |c: &mut Vec<TreeNode>, id: &str, idx: usize| {
        if let Some(i) = c.iter().position(|n| n.id == id) {
            if i != idx {
                let n = c.remove(i);
                c.insert(idx, n);
            }
        }
    };
    let c = &mut desk.children;
    let id = |kind: &str| format!("{}:{}", kind, desk.id);
    move_to(c, &id("__inbox__"), 0);
    let len = c.len();
    move_to(c, &id("__trash__"), len - 1);
    let len = c.len();
    move_to(c, &id("__archive__"), len - 2);
    let len = c.len();
    move_to(c, &id("__images__"), len - 3);
}

/// The IPC boundary: get_file_tree serializes the forest to JSON for the
/// webview; save_file_tree parses the webview's JSON back into TreeNodes.
fn ipc_round_trip(forest: &[TreeNode]) -> Vec<TreeNode> {
    let json = serde_json::to_string(forest).unwrap();
    serde_json::from_str(&json).unwrap()
}

#[test]
fn new_desk_from_populated_folder_keeps_every_file() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Writing");
    fs::create_dir_all(folder.join("Essays/Drafts")).unwrap();
    fs::create_dir_all(folder.join("Inbox")).unwrap();
    fs::create_dir_all(folder.join("Trash")).unwrap();
    fs::write(folder.join("Ideas.md"), "# Ideas").unwrap();
    fs::write(folder.join("Notes.txt"), "plain notes").unwrap();
    fs::write(folder.join("Essays/Cities.md"), "cities essay").unwrap();
    fs::write(folder.join("Essays/Drafts/Old.md"), "old draft").unwrap();
    fs::write(folder.join("Inbox/Todo.md"), "todo").unwrap();
    fs::write(folder.join("Trash/Discarded.md"), "discarded").unwrap();
    fs::write(folder.join("photo.png"), b"\x89PNG fake bytes").unwrap();

    // 1. The Rust command the New Desk > Local Folder fork invokes.
    let desk_id = store.open_folder_as_desk(&folder, None).unwrap();

    // Existing Inbox / Trash directories were matched to the desk's own
    // specials rather than duplicated as plain folders beside them.
    let forest = store.load_forest().unwrap();
    let desk = forest.iter().find(|n| n.id == desk_id).unwrap();
    let inboxes: Vec<&TreeNode> = desk.children.iter().filter(|n| n.name == "Inbox").collect();
    assert_eq!(inboxes.len(), 1, "one Inbox, not a special + a stray");
    assert_eq!(inboxes[0].id, format!("__inbox__:{}", desk_id));
    assert_eq!(inboxes[0].children.len(), 1);
    let trashes: Vec<&TreeNode> = desk.children.iter().filter(|n| n.name == "Trash").collect();
    assert_eq!(trashes.len(), 1, "one Trash, not a special + a stray");

    // 2. The frontend reloads the tree (IPC), reorders specials in
    //    memory, and eventually saves the tree back (boot does this
    //    unconditionally; so does any later tree mutation).
    let mut tree = ipc_round_trip(&forest);
    for d in tree.iter_mut().filter(|n| n.node_type == "desk") {
        js_ensure_desk_specials(d);
    }
    store.save_forest(&tree).unwrap();

    // Every pre-existing file is still on disk, contents intact.
    let expect = [
        ("Ideas.md", "# Ideas"),
        ("Notes.txt", "plain notes"),
        ("Essays/Cities.md", "cities essay"),
        ("Essays/Drafts/Old.md", "old draft"),
        ("Inbox/Todo.md", "todo"),
        ("Trash/Discarded.md", "discarded"),
    ];
    for (rel, body) in expect {
        let p = folder.join(rel);
        assert!(p.exists(), "{} vanished after the JS save", rel);
        assert_eq!(fs::read_to_string(&p).unwrap(), body, "{} rewritten", rel);
    }
    assert!(folder.join("photo.png").exists(), "image vanished");
    assert!(
        !folder.join(".hush/orphans").exists(),
        "no absorbed file may be orphaned by the follow-up save"
    );

    // A second boot cycle (load → round-trip → save) stays stable too.
    let tree2 = ipc_round_trip(&store.load_forest().unwrap());
    store.save_forest(&tree2).unwrap();
    for (rel, _) in expect {
        assert!(folder.join(rel).exists(), "{} vanished after second save", rel);
    }
}

/// A save whose tree carries the freshly-created desk with *no* content
/// children — the exact shape a stale sidebar once wrote when the panel
/// still held another desk's rows — must not empty the user's folder.
/// The absorbed files stay put and the next reconcile re-lists them.
#[test]
fn stale_childless_tree_save_never_wipes_a_local_desk() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Journal");
    fs::create_dir_all(folder.join("2026")).unwrap();
    fs::write(folder.join("Today.md"), "today").unwrap();
    fs::write(folder.join("2026/January.md"), "january").unwrap();

    let desk_id = store.open_folder_as_desk(&folder, None).unwrap();

    // Simulate the stale save: same desk id, children reduced to bare
    // specials (what a cross-desk sidebar transplant produced).
    let mut stale = store.load_forest().unwrap();
    for d in stale.iter_mut().filter(|n| n.id == desk_id) {
        d.children.retain(|c| c.id.starts_with("__"));
    }
    store.save_forest(&stale).unwrap();

    assert!(folder.join("Today.md").exists(), "root doc must survive a stale save");
    assert!(folder.join("2026/January.md").exists(), "nested doc must survive");
    assert!(
        !folder.join(".hush/orphans").exists(),
        "local-desk files must never be orphan-parked"
    );

    // Disk wins: the next reconcile re-absorbs both files.
    let report = store.reconcile_desk_from_disk(&desk_id).unwrap();
    assert_eq!(report.added, 2);
    let desk = store.load_forest().unwrap().remove(0);
    assert!(desk.children.iter().any(|n| n.name == "Today"));
}

/// Empty directories the user made in their own folder are theirs — a
/// tree save must not prune them (they hold no files, so they never get
/// a tree node and used to read as "unexpected and empty").
#[test]
fn a_users_empty_directory_survives_tree_saves() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Work");
    fs::create_dir_all(folder.join("Someday")).unwrap();
    fs::write(folder.join("Now.md"), "now").unwrap();

    store.open_folder_as_desk(&folder, None).unwrap();
    let tree = ipc_round_trip(&store.load_forest().unwrap());
    store.save_forest(&tree).unwrap();

    assert!(folder.join("Someday").is_dir(), "user's empty dir was pruned");
}

/// Case-variant `inbox/` / `TRASH/` directories fold into the desk's
/// own specials instead of forking `inbox (2)` siblings on the next
/// save (macOS filesystems treat the names as the same directory).
#[test]
fn case_variant_special_dirs_fold_into_the_specials() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Notes");
    fs::create_dir_all(folder.join("inbox")).unwrap();
    fs::create_dir_all(folder.join("TRASH")).unwrap();
    fs::write(folder.join("inbox/todo.md"), "todo").unwrap();
    fs::write(folder.join("TRASH/old.md"), "old").unwrap();

    let desk_id = store.open_folder_as_desk(&folder, None).unwrap();
    let desk = store.load_forest().unwrap().remove(0);
    let inboxes: Vec<&TreeNode> = desk
        .children
        .iter()
        .filter(|n| n.name.eq_ignore_ascii_case("inbox"))
        .collect();
    assert_eq!(inboxes.len(), 1, "one Inbox — the special absorbed the dir");
    assert_eq!(inboxes[0].id, format!("__inbox__:{}", desk_id));
    let todo_id = inboxes[0].children[0].file_id.clone().unwrap();
    assert_eq!(store.read_by_id(&todo_id).unwrap().0, "todo");

    // The follow-up save must not fork "(2)" siblings for the folded dirs.
    let tree = ipc_round_trip(&store.load_forest().unwrap());
    store.save_forest(&tree).unwrap();
    assert!(!folder.join("inbox (2)").exists());
    assert!(!folder.join("Inbox (2)").exists());
    assert_eq!(store.read_by_id(&todo_id).unwrap().0, "todo");
}

/// A tree node whose fileId resolves to nothing (not indexed anywhere,
/// not staged — the signature of a stale or foreign tree) must not
/// drop a blank file into a local desk's folder; the reconcile clears
/// the dangling node instead.
#[test]
fn unknown_ids_never_blank_fill_a_local_desk() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Clean");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("Real.md"), "real").unwrap();

    let desk_id = store.open_folder_as_desk(&folder, None).unwrap();
    let mut tree = store.load_forest().unwrap();
    for d in tree.iter_mut().filter(|n| n.id == desk_id) {
        d.children.push(node("n-ghost", "document", "Ghost", Some("ghost-id"), Vec::new()));
    }
    store.save_forest(&tree).unwrap();

    assert!(!folder.join("Ghost.md").exists(), "no blank file in the user's folder");
    assert_eq!(fs::read_to_string(folder.join("Real.md")).unwrap(), "real");
    // Disk wins once the absence outlasts the removal grace window —
    // from the reconciler's seat a dangling id and a file the provider
    // hasn't delivered yet look identical, so the ghost gets the same
    // clock before its node is dropped.
    let report = store.reconcile_desk_from_disk(&desk_id).unwrap();
    assert_eq!((report.removed, report.pending), (0, 1));
    crate::desk_scan::backdate_missing_for_tests(
        &folder, "ghost-id", crate::desk_scan::REMOVAL_GRACE_SECS + 1,
    );
    let report = store.reconcile_desk_from_disk(&desk_id).unwrap();
    assert_eq!(report.removed, 1);
    let desk = store.load_forest().unwrap().remove(0);
    assert!(desk.children.iter().all(|n| n.name != "Ghost"));
}

/// A desk id the store has never seen, carrying file nodes that resolve
/// to nothing, is a stale/foreign tree — save_forest must not
/// materialise it as a folder of blank files.
#[test]
fn save_forest_refuses_to_fabricate_an_unknown_desk() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let tree = vec![node(
        "never-seen",
        "desk",
        "Phantom",
        None,
        vec![node("n1", "document", "Doc", Some("no-such-file"), Vec::new())],
    )];
    store.save_forest(&tree).unwrap();
    assert!(
        !install.path().join("desks/never-seen").exists(),
        "phantom desk must not be materialised"
    );
}
