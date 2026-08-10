//! Desk **identity** across two installs sharing one folder.
//!
//! A desk's id travels inside the folder (`.hushdesk` + the desk node in
//! `.hush/tree.json`); the map from id → folder (`roots.json`) is
//! per-device. Everything in the store keys off that map, so the two
//! must never disagree — these tests encode what happens when they do,
//! which is the shape behind the iPad/Mac data-loss report.

use super::*;

/// Write a desk folder's sidecars by hand, the way another install (or
/// another device across a sync provider) would have left them.
fn write_desk_sidecars(folder: &std::path::Path, desk_id: &str, name: &str) {
    let hush = folder.join(".hush");
    fs::create_dir_all(&hush).unwrap();
    let desk = named_desk(desk_id, name, vec![node("n1", "document", "Doc", Some("f1"), Vec::new())]);
    fs::write(hush.join("tree.json"), serde_json::to_string_pretty(&desk).unwrap()).unwrap();
    fs::write(
        hush.join("index.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "format": "hush-index", "version": 1, "files": { "f1": "Doc.md" },
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        folder.join(".hushdesk"),
        serde_json::to_string_pretty(&serde_json::json!({
            "format": "hush-desk", "version": 1, "id": desk_id, "name": name, "createdAt": 1,
        }))
        .unwrap(),
    )
    .unwrap();
}

/// The catastrophe: this device registered the folder under one id, the
/// folder itself now says another (the far side minted its own when it
/// opened the same folder). `load_forest` hands back a desk node whose
/// id has no registered root, so every path resolves to app data — and
/// the next tree save *moves the user's files out of their iCloud
/// folder* into `{data_dir}/desks/<other id>/`.
#[test]
fn a_folders_own_id_wins_and_files_stay_in_the_folder() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    store.make_desk_local("d1", &folder, None).unwrap();
    assert!(folder.join("Doc.md").exists());

    // The far side rewrote the folder's identity to its own desk id.
    write_desk_sidecars(&folder, "far-side-id", "Letters");

    let forest = store.load_forest().unwrap();
    let desks: Vec<&TreeNode> = forest.iter().filter(|n| n.node_type == "desk").collect();
    assert_eq!(desks.len(), 1, "one folder is one desk: {:?}", desks.iter().map(|d| &d.id).collect::<Vec<_>>());
    assert_eq!(desks[0].id, "far-side-id", "the folder's own id is the desk's id");
    // The registration followed the folder, so storage still resolves there.
    assert_eq!(
        store.list_roots().get("far-side-id").map(String::as_str),
        Some(folder.to_string_lossy().as_ref()),
    );
    assert!(!store.list_roots().contains_key("d1"), "the stale key is gone");

    // ...and the save that follows leaves the user's folder alone.
    store.save_forest(&forest).unwrap();
    assert!(folder.join("Doc.md").exists(), "the file was moved out of the user's folder");
    assert!(!dir.path().join("desks/far-side-id/Doc.md").exists());
    assert_eq!(fs::read_to_string(folder.join("Doc.md")).unwrap(), "body");
}

/// Belt and braces for the same failure arriving from the other side: a
/// window (or an iPad scene) holding the tree from *before* the
/// registration was re-keyed saves a desk node whose id no longer has a
/// folder. Nothing may pull the files it lists out of the local desk
/// that actually holds them.
#[test]
fn a_stale_desk_identity_cannot_pull_files_out_of_a_local_folder() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    store.make_desk_local("d1", &folder, None).unwrap();
    write_desk_sidecars(&folder, "far-side-id", "Letters");
    store.load_forest().unwrap(); // re-keys d1 → far-side-id

    // The stale window still calls this desk "d1".
    let stale = vec![named_desk("d1", "Letters", vec![node("n1", "document", "Doc", Some("f1"), Vec::new())])];
    store.save_forest(&stale).unwrap();

    assert!(folder.join("Doc.md").exists(), "the user's file was moved out from under them");
    assert!(!dir.path().join("desks/d1/Doc.md").exists());
    // The desk that does own the folder still reads it.
    let (content, _, _) = store.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
}

/// Re-picking a folder that is already open as a desk must not mint a
/// second registration for it — two ids pointing at one folder make
/// `load_forest` yield the same desk twice, which then persists into
/// order.json and multiplies on every boot.
#[test]
fn re_opening_the_same_folder_reuses_its_registration() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    store.make_desk_local("d1", &folder, None).unwrap();

    // The far side re-identified the folder while we were registered.
    write_desk_sidecars(&folder, "far-side-id", "Letters");
    let again = store.open_folder_as_desk(&folder, None).unwrap();
    assert_eq!(again, "far-side-id");
    assert_eq!(store.list_roots().len(), 1, "one folder, one registration");

    let forest = store.load_forest().unwrap();
    assert_eq!(forest.iter().filter(|n| n.node_type == "desk").count(), 1);
}

/// Even with order.json already holding the same desk twice (the damage
/// a previous run left behind), the forest comes back with one node.
#[test]
fn load_forest_never_yields_the_same_desk_twice() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let order = dir.path().join("desks/order.json");
    fs::write(
        &order,
        serde_json::to_string_pretty(&serde_json::json!({
            "order": ["d1", "d1", "d1"], "stragglers": [],
        }))
        .unwrap(),
    )
    .unwrap();
    let forest = store.load_forest().unwrap();
    assert_eq!(forest.iter().filter(|n| n.node_type == "desk").count(), 1);
}

/// The multiplication itself. Once a desk's id had two homes — the
/// user's folder (registered under the *old* key) and an internal folder
/// that a save had just materialised under the new one — `load_forest`
/// reached the same desk twice, wrote both slots into order.json, and
/// picked up one more copy on every boot after that. Which is what a
/// forest reading "Letters, Letters, Letters, Letters" is.
#[test]
fn a_desk_reachable_two_ways_still_loads_once() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    store.make_desk_local("d1", &folder, None).unwrap();
    write_desk_sidecars(&folder, "far-side-id", "Letters");
    // The internal folder a previous save fabricated for the new id.
    let internal = dir.path().join("desks/far-side-id/.hush");
    fs::create_dir_all(&internal).unwrap();
    let stray = named_desk("far-side-id", "Letters", Vec::new());
    fs::write(internal.join("tree.json"), serde_json::to_string(&stray).unwrap()).unwrap();

    let forest = store.load_forest().unwrap();
    assert_eq!(forest.iter().filter(|n| n.node_type == "desk").count(), 1);
    // And the copy that wins is the user's folder, not the fabricated one.
    let desk = forest.iter().find(|n| n.id == "far-side-id").unwrap();
    assert_eq!(desk.children.iter().filter(|c| c.file_id.is_some()).count(), 1);
}

/// A folder whose desk sidecars exist only as iCloud placeholders is a
/// desk the provider hasn't delivered yet — never a blank folder to
/// initialise a *new* desk into. Doing that mints a second identity for
/// the folder, which is how the two installs ended up disagreeing.
#[test]
fn a_desk_folder_awaiting_download_is_not_initialised_as_new() {
    let dir = tmp();
    let store = DeskStore::new(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    fs::create_dir_all(folder.join(".hush")).unwrap();
    // What iOS shows for evicted files: `.<name>.icloud` placeholders.
    fs::write(folder.join("..hushdesk.icloud"), "plist").unwrap();
    fs::write(folder.join(".hush/.tree.json.icloud"), "plist").unwrap();
    fs::write(folder.join(".Ideas.md.icloud"), "plist").unwrap();

    let err = store.open_folder_as_desk(&folder, None).unwrap_err().to_string();
    assert!(err.contains("hasn't finished downloading"), "unexpected error: {err}");
    assert!(store.list_roots().is_empty());
    // Nothing was written over the folder's own sidecars.
    assert!(!folder.join(".hushdesk").exists());
    assert!(!folder.join(".hush/tree.json").exists());
}

/// A file and the sidecar that names it arrive **separately**, and in
/// whatever order the provider feels like. When the file lands first,
/// the reconciler used to mint a brand-new fileId for it and add a
/// second node beside the one the synced `tree.json` already carried —
/// so the far device's row was left pointing at an id this install had
/// just orphaned. Its writes then went to `.staging/<id>`, a per-device
/// file that never syncs: the notebook appeared on both machines and
/// then quietly stopped carrying anything drawn into it.
///
/// The tree is an identity record too. If it already claims the path,
/// that claim wins over minting.
#[test]
fn a_file_that_arrives_before_the_index_keeps_the_tree_s_id() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    // The far side's tree.json arrived (it names the notebook) and so
    // did the notebook, but its index.json hasn't.
    let mut desk = store.load_desk_tree("d1").unwrap();
    desk.children.push(node("n2", "notebook", "Sketch", Some("far-file-id"), Vec::new()));
    fs::write(
        folder.join(".hush/tree.json"),
        serde_json::to_string_pretty(&desk).unwrap(),
    )
    .unwrap();
    fs::write(folder.join("Sketch.hushnote"), b"PK\x03\x04 pretend zip").unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.added, 0, "the tree already had the row");
    assert_eq!(report.matched, 1);

    // The path resolves to the id the far side is still writing under.
    let index = store.load_index("d1");
    assert_eq!(index.get("far-file-id").map(String::as_str), Some("Sketch.hushnote"));
    // ...and no second row was invented for it.
    let desk = store.load_desk_tree("d1").unwrap();
    let sketches: Vec<&TreeNode> = desk.children.iter().filter(|n| n.name == "Sketch").collect();
    assert_eq!(sketches.len(), 1);
    assert_eq!(sketches[0].file_id.as_deref(), Some("far-file-id"));
}

/// "Not downloaded yet" and "gone" are different answers, and the open
/// path needs to tell them apart: one is worth waiting for and saying
/// so, the other is content loss worth pointing at the repair tool. On
/// iOS every read of an evicted file comes back ENOENT — the bytes sit
/// behind a `.<name>.icloud` placeholder — so the placeholder is the
/// only thing that distinguishes them.
#[test]
fn an_undelivered_file_reads_as_awaiting_download_not_missing() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();
    assert_eq!(store.availability("f1").0, "ready");

    // iCloud evicts it: the file goes, a placeholder stands in.
    fs::remove_file(folder.join("Doc.md")).unwrap();
    fs::write(folder.join(".Doc.md.icloud"), "plist").unwrap();
    let (state, path) = store.availability("f1");
    assert_eq!(state, "awaiting-download");
    assert_eq!(path.as_deref(), folder.join("Doc.md").to_str());
    let err = store.read_by_id("f1").unwrap_err().to_string();
    assert!(err.starts_with("awaiting-download:"), "unexpected error: {err}");

    // Without the placeholder it is simply gone, and says so.
    fs::remove_file(folder.join(".Doc.md.icloud")).unwrap();
    assert_eq!(store.availability("f1").0, "missing");
    let err = store.read_by_id("f1").unwrap_err().to_string();
    assert!(!err.contains("awaiting-download"), "unexpected error: {err}");
}

/// Both devices adding files at once. Each sees the other's file arrive
/// before the index naming it, mints its own id, and publishes a whole
/// `index.json` — so the second write erases the first device's ids.
/// That device's *tree* still holds them, and every one of its rows is
/// now pointing at an id nothing can resolve: "file not found", on every
/// open, until the app restarts and re-reads the shared tree.
///
/// The index in the folder is the published answer for a path. A node
/// whose id isn't in it, sitting at a path the index does claim, adopts
/// the published id.
#[test]
fn a_node_orphaned_by_the_far_index_adopts_the_published_id() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Shared");
    store.make_desk_local("d1", &folder, None).unwrap();

    // We minted `mine` for a file that arrived from the far device...
    fs::write(folder.join("Theirs.md"), "from the other machine").unwrap();
    let mut desk = store.load_desk_tree("d1").unwrap();
    desk.children.push(node("n2", "document", "Theirs", Some("mine"), Vec::new()));
    fs::write(folder.join(".hush/tree.json"), serde_json::to_string(&desk).unwrap()).unwrap();
    let mut index = store.load_index("d1");
    index.insert("mine".into(), "Theirs.md".into());
    store.save_index("d1", &index).unwrap();
    assert!(store.read_by_id("mine").is_ok());

    // ...and then their index.json landed, carrying *their* id for it.
    index.remove("mine");
    index.insert("theirs".into(), "Theirs.md".into());
    store.save_index("d1", &index).unwrap();
    assert!(store.read_by_id("mine").is_err(), "precondition: the row is orphaned");

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.rekeyed, 1);
    assert_eq!(report.added, 0, "the file is not new — it already had a row");

    // The row resolves again, under the id both devices now agree on.
    let desk = store.load_desk_tree("d1").unwrap();
    let row = desk.children.iter().find(|n| n.name == "Theirs").unwrap();
    assert_eq!(row.file_id.as_deref(), Some("theirs"));
    let (content, _, _) = store.read_by_id("theirs").unwrap();
    assert_eq!(content, "from the other machine");
}

/// The other half: don't publish a fresh id for a path the folder's
/// index already names. The far device's id was published first, so it
/// is the one that survives — the tree row, the index entry and the hash
/// cache all move over. Adopting rather than asserting is what makes two
/// installs converge instead of taking turns overwriting each other.
#[test]
fn a_freshly_minted_id_yields_to_one_already_published() {
    use crate::desk_hashes::HashEntry;
    use std::collections::HashMap;

    let mut desk = named_desk("d1", "Desk", vec![
        node("n1", "document", "Arrived", Some("ours"), Vec::new()),
        node("n2", "document", "OnlyHere", Some("solo"), Vec::new()),
    ]);
    let minted = vec![
        ("ours".to_string(), "Arrived.md".to_string()),
        ("solo".to_string(), "OnlyHere.md".to_string()),
    ];
    let published: HashMap<String, String> =
        [("far-id".to_string(), "Arrived.md".to_string())].into_iter().collect();
    let mut index: HashMap<String, String> = [
        ("ours".to_string(), "Arrived.md".to_string()),
        ("solo".to_string(), "OnlyHere.md".to_string()),
    ].into_iter().collect();
    let mut hashes: HashMap<String, HashEntry> =
        [("ours".to_string(), HashEntry { hash: "abc".into(), mtime: 7 })].into_iter().collect();

    let handed_back = crate::desk_scan::defer_to_published(
        &minted, &published, &mut index, &mut desk, &mut hashes,
    );

    assert_eq!(handed_back, 1);
    // The contested path resolves to the published id, once.
    assert_eq!(index.get("far-id").map(String::as_str), Some("Arrived.md"));
    assert!(!index.contains_key("ours"));
    assert_eq!(index.values().filter(|r| r.as_str() == "Arrived.md").count(), 1);
    let row = desk.children.iter().find(|n| n.name == "Arrived").unwrap();
    assert_eq!(row.file_id.as_deref(), Some("far-id"), "the row follows the id");
    assert_eq!(hashes.get("far-id").map(|e| e.hash.as_str()), Some("abc"));
    // A path only *we* know about keeps the id we minted.
    assert_eq!(index.get("solo").map(String::as_str), Some("OnlyHere.md"));
    let solo = desk.children.iter().find(|n| n.name == "OnlyHere").unwrap();
    assert_eq!(solo.file_id.as_deref(), Some("solo"));
}

/// `.hush/index.json` present but unreadable (a half-synced sidecar) is
/// not "this desk has no files" — reconciling on that reading re-mints a
/// fileId for every file in the folder and strands every node the tree
/// already had.
#[test]
fn reconcile_refuses_an_unreadable_index_sidecar() {
    let dir = tmp();
    let store = seed_simple_desk(dir.path());
    let external = tmp();
    let folder = external.path().join("Letters");
    store.make_desk_local("d1", &folder, None).unwrap();

    fs::write(folder.join(".hush/index.json"), "{ truncated").unwrap();
    let err = store.reconcile_desk_from_disk("d1").unwrap_err().to_string();
    assert!(err.contains("index"), "unexpected error: {err}");
    // The tree is untouched — no re-minted ids, no dropped nodes.
    let desk = store.load_desk_tree("d1").unwrap();
    assert_eq!(desk.children.len(), 1);
}
