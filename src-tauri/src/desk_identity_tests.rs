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
