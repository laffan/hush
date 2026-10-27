//! Reading and recovering desk backups (desk_backup.rs).
//!
//! The Recover Desk Version browser looks inside a backup without
//! unpacking it: the tree (to draw the files), and one file's text at a
//! time (to preview a document). Recovering unpacks the backup into a
//! **new internal desk** through the archive re-identify pass — the live
//! desk is never written to, so a recovery can sit beside it.
//!
//! PDFs need one more step, because a backup carries their registry
//! entries but not their bytes, and because the re-identify pass only
//! remints ids the desk's index knows (PDFs have no index entry — their
//! binaries live in the app-wide cache). Left alone, the recovered PDF
//! rows would share fileIds with the live desk's, which is exactly what
//! the one-desk-per-file invariant (desk_dedupe.rs) forbids. So:
//!
//! - **Re-connect** mints a fresh fileId per PDF (aliases follow their
//!   original), copies any cached binary, cover and meta across to it,
//!   and hands the registry entries back for the frontend to register
//!   and download what wasn't cached.
//! - Otherwise the PDF rows are left out of the recovered desk.

use crate::desk_backup::{desk_pdfs, read_tree, PDFS_ENTRY};
use crate::desk_store::DeskStore;
use crate::pdfs::PdfManager;
use crate::TreeNode;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

type BoxError = Box<dyn std::error::Error>;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupContents {
    /// The desk's tree as it was when backed up.
    pub tree: TreeNode,
    /// fileId → path inside the desk, for documents the viewer can open.
    pub index: HashMap<String, String>,
    /// fileId → PDF registry entry, for every PDF the desk held.
    pub pdfs: serde_json::Value,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoredPdf {
    pub file_id: String,
    pub entry: serde_json::Value,
    /// A binary for it was already on this device and has been copied.
    pub cached: bool,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoredBackup {
    pub desk_id: String,
    pub pdfs: Vec<RestoredPdf>,
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<fs::File>, BoxError> {
    Ok(zip::ZipArchive::new(fs::File::open(path)?)?)
}

fn read_entry(zip: &mut zip::ZipArchive<fs::File>, name: &str) -> Result<Vec<u8>, BoxError> {
    let mut entry = zip.by_name(name)?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf)?;
    Ok(buf)
}

impl DeskStore {
    pub fn backup_contents(&self, desk_id: &str, file: &str) -> Result<BackupContents, BoxError> {
        let mut zip = open_zip(&self.backup_path(desk_id, file)?)?;
        let tree: TreeNode = serde_json::from_slice(&read_entry(&mut zip, "desk/.hush/tree.json")?)?;
        let index: HashMap<String, String> = read_entry(&mut zip, "desk/.hush/index.json")
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| serde_json::from_value(v.get("files")?.clone()).ok())
            .unwrap_or_default();
        let pdfs = read_entry(&mut zip, PDFS_ENTRY)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("items").cloned())
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(BackupContents { tree, index, pdfs })
    }

    /// One file's text out of a backup, by the fileId the backed-up index
    /// gave it.
    pub fn backup_read_file(&self, desk_id: &str, file: &str, file_id: &str) -> Result<String, BoxError> {
        let mut zip = open_zip(&self.backup_path(desk_id, file)?)?;
        let index: serde_json::Value = serde_json::from_slice(&read_entry(&mut zip, "desk/.hush/index.json")?)?;
        let rel = index
            .get("files")
            .and_then(|f| f.get(file_id))
            .and_then(|v| v.as_str())
            .ok_or("that file isn't in this backup")?
            .to_string();
        let bytes = read_entry(&mut zip, &format!("desk/{}", rel))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Build a new internal desk named `new_name` from a backup.
    pub fn restore_backup(
        &self,
        desk_id: &str,
        file: &str,
        new_name: &str,
        reconnect_pdfs: bool,
    ) -> Result<RestoredBackup, BoxError> {
        let bytes = fs::read(self.backup_path(desk_id, file)?)?;
        let entries: serde_json::Value = {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes))?;
            let mut raw = String::new();
            match zip.by_name(PDFS_ENTRY) {
                Ok(mut e) => {
                    e.read_to_string(&mut raw)?;
                }
                Err(_) => raw.push_str("{}"),
            }
            serde_json::from_str::<serde_json::Value>(&raw)?
                .get("items")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}))
        };

        let new_id = self.restore_desk_bytes(bytes)?;
        let root = self.desks_dir.join(&new_id);
        let mut pdfs = Vec::new();
        if let Some(mut tree) = read_tree(&root) {
            let mut found = Vec::new();
            desk_pdfs(&tree, &mut found);
            if reconnect_pdfs {
                let cache = PdfManager::new(&self.desks_dir.parent().unwrap_or(&self.desks_dir).to_path_buf());
                let mut remap = HashMap::new();
                for (old, name) in found {
                    let fresh = uuid::Uuid::new_v4().to_string();
                    let cached = copy_cached_pdf(&cache, &old, &fresh);
                    let mut entry = entries
                        .get(&old)
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({ "title": name }));
                    entry["fileId"] = fresh.clone().into();
                    pdfs.push(RestoredPdf { file_id: fresh.clone(), entry, cached });
                    remap.insert(old, fresh);
                }
                remap_pdf_nodes(&mut tree, &remap);
            } else {
                drop_pdf_nodes(&mut tree);
            }
            crate::atomic::write_atomic_str(
                &root.join(".hush").join("tree.json"),
                &serde_json::to_string_pretty(&tree)?,
            )?;
        }
        crate::desk_recovery::rename_restored_desk(&root, new_name)?;
        crate::activity_log::note(
            "desks",
            "info",
            format!(
                "Recovered desk \"{}\" from backup {} of {} ({} PDFs re-connected)",
                new_name,
                file,
                desk_id,
                pdfs.len()
            ),
        );
        Ok(RestoredBackup { desk_id: new_id, pdfs })
    }
}

/// Copy a cached PDF binary (and its cover and meta) to a new fileId.
/// True when the binary was there to copy.
fn copy_cached_pdf(cache: &PdfManager, old: &str, fresh: &str) -> bool {
    let Ok(bytes) = cache.load(old) else { return false };
    if cache.save(fresh, &bytes).is_err() {
        return false;
    }
    if let Ok(Some(cover)) = cache.load_cover(old) {
        let _ = cache.save_cover(fresh, &cover);
    }
    if let Ok(Some(mut meta)) = cache.load_meta(old) {
        meta.file_id = fresh.to_string();
        let _ = cache.save_meta(fresh, &meta);
    }
    true
}

/// Point every PDF row — originals and their project aliases — at the
/// fileId its PDF was given.
fn remap_pdf_nodes(node: &mut TreeNode, remap: &HashMap<String, String>) {
    for child in node.children.iter_mut() {
        if child.node_type == "pdf" {
            if let Some(fresh) = child.file_id.as_ref().and_then(|f| remap.get(f)) {
                child.file_id = Some(fresh.clone());
            }
        }
        remap_pdf_nodes(child, remap);
    }
}

fn drop_pdf_nodes(node: &mut TreeNode) {
    node.children.retain(|c| c.node_type != "pdf");
    for child in node.children.iter_mut() {
        drop_pdf_nodes(child);
    }
}
