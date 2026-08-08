//! Unit tests for local desk roots — Make Local / Make Internal, opening
//! any folder as a desk, and the disk-wins reconcile. Split out of
//! `desk_store_tests.rs` for the line cap; `use super::*` pulls in that
//! module's helpers (`node`, `tmp`, `seed_simple_desk`, …) along with
//! everything `desk_store.rs` itself re-exports into scope.

use super::*;

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
fn opening_a_plain_folder_initialises_it_as_a_desk_in_place() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Novel");
    fs::create_dir_all(folder.join("Chapters")).unwrap();
    fs::write(folder.join("Outline.md"), "# Outline").unwrap();
    fs::write(folder.join("Chapters/One.md"), "chapter one").unwrap();
    fs::write(folder.join("ignore-me.pages"), "unrecognised").unwrap();

    let desk_id = store.open_folder_as_desk(&folder, None).unwrap();

    // The picked folder *is* the desk root — nothing moved or nested.
    assert_eq!(store.list_roots().get(&desk_id).map(String::as_str), Some(folder.to_str().unwrap()));
    assert!(folder.join(".hushdesk").exists());
    assert!(folder.join(".hush/tree.json").exists());
    assert!(folder.join("Outline.md").exists());
    assert!(folder.join("Chapters/One.md").exists());

    let forest = store.load_forest().unwrap();
    assert_eq!(forest.len(), 1);
    let desk = &forest[0];
    assert_eq!(desk.name, "Novel", "desk takes the folder's name");
    assert_eq!(desk.node_type, "desk");
    // Specials are seeded with the ids the JS side builds.
    let ids: Vec<&str> = desk.children.iter().map(|c| c.id.as_str()).collect();
    for kind in ["__inbox__", "__images__", "__archive__", "__trash__"] {
        assert!(ids.contains(&format!("{}:{}", kind, desk_id).as_str()), "missing {}", kind);
    }
    // The files already in the folder were absorbed.
    let outline = desk.children.iter().find(|c| c.name == "Outline").expect("Outline absorbed");
    assert_eq!(outline.node_type, "document");
    let chapters = desk.children.iter().find(|c| c.name == "Chapters").expect("Chapters absorbed");
    assert_eq!(chapters.children.len(), 1);
    assert_eq!(chapters.children[0].name, "One");
    let (content, _, _) = store.read_by_id(outline.file_id.as_ref().unwrap()).unwrap();
    assert_eq!(content, "# Outline");
    // Unrecognised extensions are left alone rather than adopted.
    assert!(desk.children.iter().all(|c| c.name != "ignore-me"));
}

#[test]
fn absorbed_docs_keep_their_own_extension_across_tree_saves() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    let external = tmp();
    let folder = external.path().join("Notes");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("plain.txt"), "txt body").unwrap();
    fs::write(folder.join("long.markdown"), "markdown body").unwrap();

    store.open_folder_as_desk(&folder, None).unwrap();
    let desk = store.load_forest().unwrap().remove(0);
    let find = |name: &str| {
        desk.children
            .iter()
            .find(|c| c.name == name)
            .and_then(|c| c.file_id.clone())
            .unwrap_or_else(|| panic!("{} absorbed", name))
    };
    let txt_id = find("plain");
    let markdown_id = find("long");

    // A plain tree save must not rewrite the user's files to `.md`.
    store.save_forest(&[desk.clone()]).unwrap();
    assert!(folder.join("plain.txt").exists(), "txt kept its extension");
    assert!(folder.join("long.markdown").exists(), "markdown kept its extension");
    assert!(!folder.join("plain.md").exists());
    assert_eq!(store.read_by_id(&txt_id).unwrap().0, "txt body");
    assert_eq!(store.read_by_id(&markdown_id).unwrap().0, "markdown body");

    // Renaming the node still renames the file — stem only.
    let mut renamed = desk.clone();
    for child in renamed.children.iter_mut() {
        if child.file_id.as_deref() == Some(txt_id.as_str()) {
            child.name = "Renamed".to_string();
        }
    }
    store.save_forest(&[renamed]).unwrap();
    assert!(folder.join("Renamed.txt").exists());
    assert!(!folder.join("plain.txt").exists());

    // A doc Hush creates itself is unaffected — still `.md`.
    let new_id = "fresh-doc";
    store.stage_new(new_id).unwrap();
    store.write_by_id(new_id, "fresh").unwrap();
    let mut with_new = store.load_forest().unwrap().remove(0);
    with_new
        .children
        .push(node("n-fresh", "document", "Fresh", Some(new_id), Vec::new()));
    store.save_forest(&[with_new]).unwrap();
    assert!(folder.join("Fresh.md").exists());
}

#[test]
fn opening_an_existing_desk_folder_adopts_it_and_refuses_twice() {
    // A desk produced by one install...
    let install_a = tmp();
    let store_a = seed_simple_desk(install_a.path());
    let external = tmp();
    let target = external.path().join("Shared Desk");
    store_a.make_desk_local("d1", &target, None).unwrap();

    // ...opened from a second install keeps its identity (no re-init).
    let install_b = tmp();
    let store_b = DeskStore::new(install_b.path());
    assert_eq!(store_b.open_folder_as_desk(&target, None).unwrap(), "d1");
    let (content, _, _) = store_b.read_by_id("f1").unwrap();
    assert_eq!(content, "body");
    assert!(store_b.open_folder_as_desk(&target, None).is_err(), "already registered");
}

#[test]
fn open_folder_as_desk_refuses_bad_folders() {
    let install = tmp();
    let store = DeskStore::new(install.path());
    // Inside app data.
    let inside = install.path().join("desks").join("nested");
    fs::create_dir_all(&inside).unwrap();
    assert!(store.open_folder_as_desk(&inside, None).is_err());
    // A file, not a folder.
    let external = tmp();
    let file = external.path().join("notes.md");
    fs::write(&file, "x").unwrap();
    assert!(store.open_folder_as_desk(&file, None).is_err());
    // Half-initialised: .hushdesk with no .hush/tree.json.
    let broken = external.path().join("Broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(".hushdesk"), "{}").unwrap();
    assert!(store.open_folder_as_desk(&broken, None).is_err());
}

#[test]
fn deleting_a_local_desk_takes_an_explicit_unregister() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();

    // A tree save that merely lacks the desk (a stale tree from a second
    // window, an interleaved save) must NOT disconnect it — the desk
    // stays registered and resurfaces from its folder on the next load.
    let tree = vec![node("d2", "desk", "Other", None, Vec::new())];
    store.save_forest(&tree).unwrap();
    assert!(target.join("Doc.md").exists(), "user folder untouched");
    assert_eq!(store.list_roots().len(), 1, "stale save keeps the registration");
    let forest = store.load_forest().unwrap();
    assert!(
        forest.iter().any(|d| d.id == "d1" && !d.children.is_empty()),
        "desk resurrects from its folder"
    );

    // Real deletion says so out loud (the delete-desk flow calls
    // `desk_unregister_root` before the tree save). Folder untouched.
    crate::desk_roots::unregister(&store.desks_dir, "d1");
    store.save_forest(&tree).unwrap();
    assert!(store.list_roots().is_empty(), "explicit unregister removes the root");
    assert!(target.join("Doc.md").exists(), "user folder still untouched");
    assert!(store.load_forest().unwrap().iter().all(|d| d.id != "d1"));
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

    // Additions land immediately; the deletion only starts the grace
    // clock — inside a synced folder, "absent" routinely means "not
    // delivered yet", so a single scan can never remove anything.
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.added, 2);
    assert_eq!(report.removed, 0);
    assert_eq!(report.pending, 1);
    let forest = store.load_forest().unwrap();
    assert!(forest[0].children.iter().any(|n| n.name == "Doc"),
        "a just-missed file is held, not dropped");

    // Once the absence has outlasted the grace window, a later scan
    // treats it as the real deletion it is.
    crate::desk_scan::backdate_missing_for_tests(
        &target, "f1", crate::desk_scan::REMOVAL_GRACE_SECS + 1,
    );
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.removed, 1);
    assert_eq!(report.pending, 0);

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
    // Different bytes can't pair as a rename, so the add lands and the
    // vanish waits out the grace window like any other absence.
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.renamed, report.added, report.removed), (0, 1, 0));
    assert_eq!(report.pending, 1);
    crate::desk_scan::backdate_missing_for_tests(
        &target, "f1", crate::desk_scan::REMOVAL_GRACE_SECS + 1,
    );
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.renamed, report.added, report.removed), (0, 0, 1));
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

#[test]
fn an_icloud_placeholder_holds_the_file_indefinitely() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();

    // iCloud evicts the local copy: the file becomes a `.Doc.md.icloud`
    // placeholder — the provider saying "exists, just not local".
    fs::remove_file(target.join("Doc.md")).unwrap();
    fs::write(target.join(".Doc.md.icloud"), "plist stub").unwrap();

    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert!(!report.changed(), "nothing to rewrite — the file is merely not local");
    assert_eq!(report.pending, 1);
    assert_eq!(
        report.pending_downloads,
        vec![target.join("Doc.md").to_string_lossy().into_owned()],
        "the logical path is surfaced so the frontend can trigger the download"
    );

    // Even far past the grace window a placeholder-backed file is never
    // treated as deleted — there is no clock to run out.
    crate::desk_scan::backdate_missing_for_tests(
        &target, "f1", crate::desk_scan::REMOVAL_GRACE_SECS * 10,
    );
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!(report.removed, 0);
    assert!(store.load_desk_tree("d1").unwrap().children.iter().any(|n| n.name == "Doc"));

    // The download lands: the placeholder becomes the real file again.
    fs::remove_file(target.join(".Doc.md.icloud")).unwrap();
    fs::write(target.join("Doc.md"), "body").unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.added, report.removed, report.pending), (0, 0, 0));
    assert_eq!(store.read_by_id("f1").unwrap().0, "body");
}

#[test]
fn a_reappearing_file_resets_the_removal_clock() {
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();

    // Miss once — the clock starts.
    fs::remove_file(target.join("Doc.md")).unwrap();
    assert_eq!(store.reconcile_desk_from_disk("d1").unwrap().pending, 1);

    // The file comes back (a slow provider finished delivering it).
    fs::write(target.join("Doc.md"), "body").unwrap();
    assert_eq!(store.reconcile_desk_from_disk("d1").unwrap().pending, 0);

    // A later miss starts a *fresh* clock: backdating would only have
    // bitten if the first miss's stamp had survived the reappearance.
    fs::remove_file(target.join("Doc.md")).unwrap();
    let report = store.reconcile_desk_from_disk("d1").unwrap();
    assert_eq!((report.removed, report.pending), (0, 1));
    assert!(store.load_desk_tree("d1").unwrap().children.iter().any(|n| n.name == "Doc"));
}

#[test]
fn post_adopt_reconcile_cannot_shed_undelivered_files() {
    // The iPad → Mac disaster: a desk folder whose sidecars synced ahead
    // of its content. tree.json/index.json list the docs; the docs
    // themselves haven't been delivered yet. Adopting the folder must
    // not rewrite the sidecars minus the "missing" files.
    let dir = tmp();
    let external = tmp();
    let target = external.path().join("Desk");
    let store = seed_simple_desk(dir.path());
    store.make_desk_local("d1", &target, None).unwrap();
    crate::desk_roots::unregister(&store.desks_dir, "d1");

    // Simulate the half-delivered folder: sidecars intact, content gone.
    fs::remove_file(target.join("Doc.md")).unwrap();

    // A second install adopts it (fresh data dir = fresh store).
    let dir_b = tmp();
    let store_b = DeskStore::new(dir_b.path());
    let desk_id = store_b.open_folder_as_desk(&target, None).unwrap();
    assert_eq!(desk_id, "d1", "adopted by its .hushdesk identity");
    let report = store_b.reconcile_desk_from_disk(&desk_id).unwrap();
    assert_eq!(report.removed, 0, "the post-adopt scan never removes");

    let index = store_b.load_index(&desk_id);
    assert_eq!(index.get("f1").map(String::as_str), Some("Doc.md"),
        "the shared index still carries the undelivered file");
    assert!(store_b.load_desk_tree(&desk_id).unwrap().children.iter().any(|n| n.name == "Doc"),
        "the shared tree still carries the undelivered file");
}
