//! Tests for the cross-desk identity repair, plus the end-to-end shape of
//! the corruption it was written for: a project recorded under two desks
//! at once, which deleting either desk turned into unopenable rows in the
//! other.

use super::*;
use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::fs;

fn node(id: &str, node_type: &str, name: &str, file_id: Option<&str>, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        id: id.to_string(),
        name: name.to_string(),
        node_type: node_type.to_string(),
        file_id: file_id.map(|s| s.to_string()),
        children,
        ..Default::default()
    }
}

fn desk(id: &str, name: &str, extra: Vec<TreeNode>) -> TreeNode {
    let mut kids = vec![node(&format!("__inbox__:{}", id), "project", "Inbox", None, Vec::new())];
    kids.extend(extra);
    kids.push(node(&format!("__images__:{}", id), "folder", "Images", None, Vec::new()));
    kids.push(node(&format!("__archive__:{}", id), "folder", "Archive", None, Vec::new()));
    kids.push(node(&format!("__trash__:{}", id), "folder", "Trash", None, Vec::new()));
    node(id, "desk", name, None, kids)
}

fn essays() -> TreeNode {
    node(
        "p-essays",
        "project",
        "Essays",
        None,
        vec![node("n-cities", "document", "Cities", Some("f-cities"), Vec::new())],
    )
}

fn ids_under(desk: &TreeNode) -> Vec<String> {
    let mut out = std::collections::HashSet::new();
    collect_ids(&desk.children, &mut out);
    let mut v: Vec<String> = out.into_iter().collect();
    v.sort();
    v
}

#[test]
fn a_sound_forest_is_left_alone() {
    let forest = vec![desk("school", "School", vec![essays()]), desk("personal", "Personal", vec![])];
    assert!(repair_forest(&forest, &HashMap::new()).is_none());
}

#[test]
fn a_file_claimed_by_two_desks_stays_with_the_desk_holding_the_bytes() {
    let forest = vec![
        desk("school", "School", vec![essays()]),
        desk("personal", "Personal", vec![essays()]),
    ];
    // The bytes live in School, even though Personal is listed second.
    let mut on_disk = HashMap::new();
    on_disk.insert(
        "f-cities".to_string(),
        ("school".to_string(), "Essays/Cities.md".to_string()),
    );

    let repaired = repair_forest(&forest, &on_disk).expect("contested forest must be repaired");
    let school = repaired.iter().find(|d| d.id == "school").unwrap();
    let personal = repaired.iter().find(|d| d.id == "personal").unwrap();
    assert_eq!(ids_under(school), vec!["f-cities".to_string()]);
    assert!(ids_under(personal).is_empty(), "the duplicate must be gone");
    // The emptied transplant doesn't leave a hollow project behind.
    assert!(personal.children.iter().all(|c| c.name != "Essays"));
    // …but the desk's own specials survive being empty.
    assert!(personal.children.iter().any(|c| c.id == "__inbox__:personal"));
}

#[test]
fn with_no_bytes_on_disk_the_first_desk_in_forest_order_wins() {
    let forest = vec![
        desk("school", "School", vec![essays()]),
        desk("personal", "Personal", vec![essays()]),
    ];
    let repaired = repair_forest(&forest, &HashMap::new()).unwrap();
    let school = repaired.iter().find(|d| d.id == "school").unwrap();
    assert_eq!(ids_under(school), vec!["f-cities".to_string()]);
    assert!(ids_under(repaired.iter().find(|d| d.id == "personal").unwrap()).is_empty());
}

#[test]
fn another_desks_inbox_sitting_in_this_one_is_folded_into_its_own() {
    // The "second Inbox" symptom: School's Inbox node transplanted into
    // Personal, still carrying a doc that exists nowhere else.
    let stray = node(
        "__inbox__:school",
        "project",
        "Inbox",
        None,
        vec![node("n-todo", "document", "Todo", Some("f-todo"), Vec::new())],
    );
    let forest = vec![desk("personal", "Personal", vec![stray])];
    let repaired = repair_forest(&forest, &HashMap::new()).expect("foreign special must be repaired");
    let personal = &repaired[0];

    let inboxes: Vec<&TreeNode> = personal.children.iter().filter(|c| c.name == "Inbox").collect();
    assert_eq!(inboxes.len(), 1, "one Inbox, not two");
    assert_eq!(inboxes[0].id, "__inbox__:personal");
    // The doc it carried was kept — the repair never discards content.
    assert_eq!(ids_under(personal), vec!["f-todo".to_string()]);
}

/// Mint the project's doc the way the app does: content is staged first,
/// and the tree save that follows gives it a real path.
fn stage_cities(store: &DeskStore) {
    store.write_by_id("f-cities", "cities essay").unwrap();
}

/// The regression this whole module exists for, end to end against the
/// real store: two desks recording the same project, then one deleted.
#[test]
fn deleting_one_desk_no_longer_strands_the_other_desks_files() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());

    // A healthy start: School owns the project.
    stage_cities(&store);
    let sound = vec![desk("school", "School", vec![essays()]), desk("personal", "Personal", vec![])];
    store.save_forest(&sound).unwrap();
    assert_eq!(store.locate("f-cities").expect("file should be placed").0, "school");

    // Now a corrupt forest arrives — the project recorded under Personal
    // as well. Before the invariant existed this wrote both indexes.
    let corrupt = vec![
        desk("school", "School", vec![essays()]),
        desk("personal", "Personal", vec![essays()]),
    ];
    store.save_forest(&corrupt).unwrap();
    assert_eq!(
        store.load_index("personal").len(),
        0,
        "Personal must not claim School's file"
    );

    // Deleting Personal leaves School intact and readable.
    store.retire_desk("personal").unwrap();
    store.save_forest(&[desk("school", "School", vec![essays()])]).unwrap();
    assert_eq!(store.read_by_id("f-cities").unwrap().0, "cities essay");
}

/// A stale window saving a forest that has simply never heard of a desk
/// must not take that desk's folder away.
#[test]
fn a_stale_save_cannot_retire_a_desk_it_never_saw() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    stage_cities(&store);
    store
        .save_forest(&[desk("school", "School", vec![essays()]), desk("personal", "Personal", vec![])])
        .unwrap();

    // The stale save: Personal only. School is absent, not deleted.
    store.save_forest(&[desk("personal", "Personal", vec![])]).unwrap();

    assert!(
        dir.path().join("desks/school/.hush/tree.json").exists(),
        "School's folder must survive a save that merely omits it"
    );
    let forest = store.load_forest().unwrap();
    assert!(
        forest.iter().any(|d| d.id == "school"),
        "and load_forest must resurrect it"
    );
    assert_eq!(store.read_by_id("f-cities").unwrap().0, "cities essay");
}

/// The exact shape the user hit: a desk was deleted while another desk's
/// tree still referenced files whose bytes had ended up inside it. Placing
/// them must recover the real content, not fabricate a blank document over
/// it — a blank doc reads as healthy, and the first keystroke would make
/// the loss permanent.
#[test]
fn a_save_recovers_content_stranded_in_a_retired_desk() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    stage_cities(&store);
    store.save_forest(&[desk("personal", "Personal", vec![essays()])]).unwrap();
    assert_eq!(store.read_by_id("f-cities").unwrap().0, "cities essay");

    // The desk holding the bytes is deleted; School's tree still lists them.
    store.retire_desk("personal").unwrap();
    fs::create_dir_all(dir.path().join("desks/school/.hush")).unwrap();
    fs::write(dir.path().join("desks/school/.hush/tree.json"), "{}").unwrap();
    store.save_forest(&[desk("school", "School", vec![essays()])]).unwrap();

    assert_eq!(
        store.read_by_id("f-cities").unwrap().0,
        "cities essay",
        "the essay must come back, not a blank stand-in"
    );
}

/// The same rescue reached directly, for an install already sitting in the
/// broken state: index entries pointing at files that aren't there.
#[test]
fn repair_restores_files_from_a_retired_desk() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    stage_cities(&store);
    store.save_forest(&[desk("school", "School", vec![essays()])]).unwrap();
    let (_, rel) = store.locate("f-cities").unwrap();

    // Stage a copy of the bytes as a retired desk, then delete the live
    // file — the state an install is left in after the bad delete.
    let retired = dir.path().join("desks/.deleted/personal-1");
    fs::create_dir_all(retired.join(".hush")).unwrap();
    fs::write(retired.join("Cities.md"), "cities essay").unwrap();
    fs::write(
        retired.join(".hush/index.json"),
        r#"{"files":{"f-cities":"Cities.md"}}"#,
    )
    .unwrap();
    fs::remove_file(dir.path().join("desks/school").join(&rel)).unwrap();
    assert!(store.read_by_id("f-cities").is_err(), "precondition: file is lost");

    let report = store.recover_desk_files().unwrap();
    assert_eq!(report.broken, 1, "{:?}", report.notes);
    assert_eq!(report.restored, 1, "{:?}", report.notes);
    assert_eq!(store.read_by_id("f-cities").unwrap().0, "cities essay");
}
