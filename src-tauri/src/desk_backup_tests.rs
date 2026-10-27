//! Desk backups: named so several desks can share a folder, PDFs left
//! out with their registry entries kept, thinned by the Versions policy,
//! and recovered as new desks whose PDFs never share a fileId with the
//! live desk.

use super::*;
use crate::desk_store::DeskStore;
use crate::pdfs::PdfManager;
use crate::TreeNode;

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
    kids.push(node(&format!("__trash__:{}", id), "folder", "Trash", None, Vec::new()));
    node(id, "desk", name, None, kids)
}

/// An internal desk holding one doc and one PDF, with backups pointed at
/// `folder`. The PDF is in the registry, with a cached binary.
fn seed(store: &DeskStore, data_dir: &Path, folder: &Path, desk_id: &str) {
    store.write_by_id("f-doc", "the draft").unwrap();
    store
        .save_forest(&[desk(
            desk_id,
            "Field Notes",
            vec![
                node("n1", "document", "Draft", Some("f-doc"), Vec::new()),
                node("n2", "pdf", "Paper", Some("f-pdf"), Vec::new()),
            ],
        )])
        .unwrap();
    let cache = PdfManager::new(&data_dir.to_path_buf());
    cache
        .save_registry(
            &serde_json::json!({
                "format": "hush-pdfs", "version": 1,
                "items": { "f-pdf": { "fileId": "f-pdf", "title": "A Paper", "zoteroAttKey": "ATT1" } }
            })
            .to_string(),
        )
        .unwrap();
    cache.save("f-pdf", b"%PDF-1.4 bytes").unwrap();
    store
        .set_backup_target(desk_id, Some(BackupTarget { path: folder.to_string_lossy().into_owned(), bookmark: None }))
        .unwrap();
}

fn zip_names(path: &Path) -> Vec<String> {
    let zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    zip.file_names().map(|s| s.to_string()).collect()
}

#[test]
fn backup_names_round_trip_and_keep_desks_apart() {
    let at = 1_790_000_000;
    let name = backup_file_name("Field Notes", "abc", at);
    assert!(name.starts_with("Field-Notes_") && name.ends_with("_abc.zip"), "{}", name);
    assert_eq!(parse_backup_name(&name, "abc"), Some(at));
    assert_eq!(parse_backup_name(&name, "x-abc"), None);
    let other = backup_file_name("Field Notes", "x-abc", at);
    assert_eq!(parse_backup_name(&other, "abc"), None, "a longer id ending in ours is not ours");
    assert_eq!(parse_backup_name("notes.zip", "abc"), None);
}

#[test]
fn a_backup_leaves_pdfs_out_and_carries_their_registry_entries() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-pdf");
    // A loose PDF in the desk folder stays out too.
    fs::write(store.desk_dir("bk-pdf").join("loose.PDF"), b"%PDF").unwrap();

    let info = store.backup_desk("bk-pdf").unwrap();
    let names = zip_names(Path::new(&info.path));
    assert!(names.iter().any(|n| n == "desk/.hush/tree.json"));
    assert!(names.iter().any(|n| n == PDFS_ENTRY));
    assert!(!names.iter().any(|n| n.to_ascii_lowercase().ends_with(".pdf")), "{:?}", names);

    let listed = store.list_backups("bk-pdf");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Field Notes");

    let contents = store.backup_contents("bk-pdf", &info.file).unwrap();
    assert_eq!(contents.pdfs["f-pdf"]["zoteroAttKey"], "ATT1");
    assert_eq!(store.backup_read_file("bk-pdf", &info.file, "f-doc").unwrap(), "the draft");
}

#[test]
fn a_recovery_reconnects_pdfs_under_fresh_ids() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-rt");
    let info = store.backup_desk("bk-rt").unwrap();

    let restored = store.restore_backup("bk-rt", &info.file, "Field Notes Backup", true).unwrap();
    assert_ne!(restored.desk_id, "bk-rt");
    assert_eq!(restored.pdfs.len(), 1);
    let pdf = &restored.pdfs[0];
    assert_ne!(pdf.file_id, "f-pdf", "a recovered PDF can't share the live desk's fileId");
    assert_eq!(pdf.entry["fileId"], pdf.file_id.as_str());
    assert_eq!(pdf.entry["zoteroAttKey"], "ATT1");
    assert!(pdf.cached, "the cached binary is copied across");
    assert!(PdfManager::new(&dir.path().to_path_buf()).exists(&pdf.file_id));

    let forest = store.load_forest().unwrap();
    let new_desk = forest.iter().find(|d| d.id == restored.desk_id).unwrap();
    assert_eq!(new_desk.name, "Field Notes Backup");
    let mut pdfs = Vec::new();
    desk_pdfs(new_desk, &mut pdfs);
    assert_eq!(pdfs, vec![(pdf.file_id.clone(), "Paper".to_string())]);
    // The live desk still has its own.
    let live = forest.iter().find(|d| d.id == "bk-rt").unwrap();
    let mut live_pdfs = Vec::new();
    desk_pdfs(live, &mut live_pdfs);
    assert_eq!(live_pdfs[0].0, "f-pdf");
}

#[test]
fn a_recovery_without_reconnecting_drops_the_pdf_rows() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-drop");
    let info = store.backup_desk("bk-drop").unwrap();

    let restored = store.restore_backup("bk-drop", &info.file, "No PDFs", false).unwrap();
    assert!(restored.pdfs.is_empty());
    let forest = store.load_forest().unwrap();
    let new_desk = forest.iter().find(|d| d.id == restored.desk_id).unwrap();
    let mut pdfs = Vec::new();
    desk_pdfs(new_desk, &mut pdfs);
    assert!(pdfs.is_empty());
}

#[test]
fn old_backups_thin_out_like_versions() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-prune");
    // Three backups from one day ten days ago: the policy keeps one.
    let day = (now_secs() - 10 * 86_400) / 86_400 * 86_400;
    for offset in [3_600, 7_200, 10_800] {
        fs::write(folder.path().join(backup_file_name("Field Notes", "bk-prune", day + offset)), b"x").unwrap();
    }
    store.backup_desk("bk-prune").unwrap();
    let kept: Vec<u64> = store.list_backups("bk-prune").iter().map(|b| b.archived_at).collect();
    assert_eq!(kept.len(), 2, "today's backup and one from that day: {:?}", kept);
    assert!(kept.contains(&(day + 10_800)), "the newest of the day is the one kept");
}

#[test]
fn backups_are_due_hourly_and_only_after_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-due");
    let now = now_secs();
    assert!(backup_due(&store, "bk-due", now), "no backup yet");
    tick(dir.path(), now);
    assert_eq!(store.list_backups("bk-due").len(), 1);
    assert!(!backup_due(&store, "bk-due", now + 60), "inside the hour");
    // An hour on, nothing in the folder is newer than the backup.
    assert!(!backup_due(&store, "bk-due", now + BACKUP_INTERVAL_SECS + 5));
}

#[test]
fn a_backup_folder_inside_app_data_or_the_desk_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    store.write_by_id("f-doc", "x").unwrap();
    let local = tempfile::tempdir().unwrap();
    store.save_forest(&[desk("bk-ref", "Refuse", Vec::new()), desk("bk-loc", "Local", Vec::new())]).unwrap();
    store.make_desk_local("bk-loc", &local.path().join("Local"), None).unwrap();
    let inside_data = dir.path().join("backups");
    let inside_desk = store.desk_dir("bk-ref").join("backups");
    let inside_other = local.path().join("Local").join("backups");
    for path in [inside_data, inside_desk, inside_other] {
        let target = BackupTarget { path: path.to_string_lossy().into_owned(), bookmark: None };
        assert!(store.set_backup_target("bk-ref", Some(target)).is_err(), "{:?}", path);
    }
    assert!(store.backup_target("bk-ref").is_none());
}

#[test]
fn backup_handles_reject_other_files() {
    let dir = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let store = DeskStore::new(dir.path());
    seed(&store, dir.path(), folder.path(), "bk-h");
    assert!(store.backup_path("bk-h", "../secret.zip").is_err());
    assert!(store.backup_path("bk-h", "notes.zip").is_err());
    let other = backup_file_name("Other", "someone-else", 1_790_000_000);
    assert!(store.backup_path("bk-h", &other).is_err());
}
