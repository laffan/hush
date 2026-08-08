//! Desk archives — a desk folded into one file and kept.
//!
//! Archiving replaces deleting. A desk is a folder (internal, or one the
//! user picked); archiving zips that folder whole — content, `.hushdesk`
//! identity, `.hush/` index, tree and version history — into
//! `{data_dir}/desk-archives/<name>-<epoch>.husharchive`, then takes the
//! desk out of the app. A local desk's own folder is never touched: the
//! archive is a copy and the root is simply unregistered.
//!
//! Restoring goes the other way, and mints a **new identity**: a fresh
//! desk id, fresh special-node ids, and fresh fileIds throughout. That
//! isn't ceremony — the store's one hard invariant is that a fileId
//! belongs to exactly one desk (see `desk_dedupe`), and "Create New Desk
//! From Archive" run twice would otherwise produce two desks claiming the
//! same files, which is precisely the corruption that made archiving
//! worth building. Reminting makes a restore safe any number of times,
//! including alongside the desk it came from.

use crate::atomic::write_atomic_str;
use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::FileOptions;

type BoxError = Box<dyn std::error::Error>;

pub const ARCHIVE_EXT: &str = "husharchive";

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    /// Filename inside the archive directory — the handle every other
    /// command takes.
    pub file: String,
    /// Absolute path, for the desktop "Share" save dialog.
    pub path: String,
    pub name: String,
    /// The desk id this archive was made from (historical; a restore
    /// mints a new one).
    pub desk_id: String,
    pub archived_at: u64,
    pub bytes: u64,
    pub files: usize,
    /// True when the desk was operating from a folder the user picked.
    pub was_local: bool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A filename component that's safe on every platform we ship to.
fn slug(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim().replace(' ', "-");
    if cleaned.is_empty() { "desk".to_string() } else { cleaned.chars().take(80).collect() }
}

/// Every file under `dir`, as (relative path, absolute path). Unlike the
/// desk reconciler's walk this deliberately keeps dotfiles: `.hushdesk`
/// and `.hush/` *are* the desk's identity and history, and an archive
/// without them would restore as a folder of loose files.
pub(crate) fn walk_all(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        if path.is_dir() {
            walk_all(root, &path, out);
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('\\', "/"), path));
            }
        }
    }
}

impl DeskStore {
    /// Where archives live: beside `desks/`, under the same data dir the
    /// store was opened on — so it follows the store rather than reading
    /// the OS data dir independently.
    pub fn archives_dir(&self) -> PathBuf {
        self.desks_dir
            .parent()
            .unwrap_or(&self.desks_dir)
            .join("desk-archives")
    }

    /// Zip a desk's folder into the archive directory and return the
    /// entry. Does **not** remove the desk — the caller decides that, so
    /// a failed archive can't cost the user their desk.
    pub fn archive_desk(&self, desk_id: &str, desk_name: &str) -> Result<ArchiveInfo, BoxError> {
        let root = self.desk_dir(desk_id);
        if !root.is_dir() {
            return Err(format!("desk {} has no folder to archive", desk_id).into());
        }
        let was_local = crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some();
        let dir = self.archives_dir();
        fs::create_dir_all(&dir)?;

        let stamp = now_secs();
        let file_name = format!("{}-{}.{}", slug(desk_name), stamp, ARCHIVE_EXT);
        let path = dir.join(&file_name);

        let (buf, files) = build_desk_zip(&root, desk_name, desk_id, was_local, stamp)?;
        let bytes = buf.len() as u64;
        fs::write(&path, &buf)?;

        crate::activity_log::note(
            "desks",
            "info",
            format!("Archived desk \"{}\" ({} files) to {}", desk_name, files, file_name),
        );

        Ok(ArchiveInfo {
            file: file_name,
            path: path.to_string_lossy().into_owned(),
            name: desk_name.to_string(),
            desk_id: desk_id.to_string(),
            archived_at: stamp,
            bytes,
            files,
            was_local,
        })
    }

    /// Remove an archived desk's live folder. Only ever called after
    /// `archive_desk` returned successfully, and never for a local desk —
    /// that folder belongs to the user, so archiving it just makes a copy
    /// and the root is unregistered instead.
    pub fn discard_archived_desk(&self, desk_id: &str) -> Result<(), BoxError> {
        if crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some() {
            return Ok(());
        }
        let root = self.desks_dir.join(desk_id);
        if root.is_dir() {
            fs::remove_dir_all(&root)?;
        }
        Ok(())
    }

    /// Unpack an archive into a brand-new internal desk. Returns the new
    /// desk id.
    pub fn restore_archive(&self, file: &str) -> Result<String, BoxError> {
        let src = self.archives_dir().join(sanitize_handle(file)?);
        let new_id = self.restore_desk_zip(&src)?;
        crate::activity_log::note(
            "desks",
            "info",
            format!("Created desk {} from archive {}", new_id, file),
        );
        Ok(new_id)
    }

    /// Unpack any desk zip — an archive or a recovery snapshot (see
    /// desk_recovery.rs) — into a brand-new internal desk with a fresh
    /// identity throughout. Returns the new desk id.
    pub(crate) fn restore_desk_zip(&self, src: &Path) -> Result<String, BoxError> {
        let bytes = fs::read(src)?;
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;

        let new_id = uuid::Uuid::new_v4().to_string();
        let dst = self.desks_dir.join(&new_id);
        if dst.exists() {
            return Err("a desk folder with the new id already exists".into());
        }
        fs::create_dir_all(&dst)?;

        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let Some(name) = entry.enclosed_name().map(|p| p.to_path_buf()) else { continue };
            // Everything the desk owns lives under `desk/`; `archive.json`
            // is metadata about the archive, not part of the desk.
            let Ok(rel) = name.strip_prefix("desk") else { continue };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = dst.join(rel);
            if entry.is_dir() {
                fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            fs::write(&out, &buf)?;
        }

        reidentify_desk(&dst, &new_id)?;
        self.append_to_order(&new_id)?;
        Ok(new_id)
    }
}

/// Build the zip envelope for a desk folder — every file under `desk/`
/// plus an `archive.json` manifest at the root — entirely in memory, then
/// hand back the bytes and the file count. In memory on purpose: a
/// half-written archive that a caller then treats as successful would be
/// the worst possible outcome, so callers write the finished buffer once.
/// Shared by desk archives (above) and the recovery snapshots
/// (desk_recovery.rs), which differ only in where the bytes land and how
/// they're pruned.
pub(crate) fn build_desk_zip(
    root: &Path,
    desk_name: &str,
    desk_id: &str,
    was_local: bool,
    stamp: u64,
) -> Result<(Vec<u8>, usize), BoxError> {
    let mut entries = Vec::new();
    walk_all(root, root, &mut entries);
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.add_directory("desk/", opts)?;
        for (rel, abs) in &entries {
            let mut bytes = Vec::new();
            File::open(abs)?.read_to_end(&mut bytes)?;
            zip.start_file(format!("desk/{}", rel), opts)?;
            zip.write_all(&bytes)?;
        }
        // A manifest at the root so listing doesn't have to reason
        // about the desk's own sidecars.
        zip.start_file("archive.json", opts)?;
        zip.write_all(
            serde_json::to_string_pretty(&serde_json::json!({
                "format": "hush-desk-archive",
                "version": 1,
                "name": desk_name,
                "deskId": desk_id,
                "archivedAt": stamp,
                "files": entries.len(),
                "wasLocal": was_local,
            }))?
            .as_bytes(),
        )?;
        zip.finish()?;
    }
    let files = entries.len();
    Ok((buf, files))
}

/// Give a just-unpacked desk folder a fresh identity: new desk id on the
/// `.hushdesk` and tree root, new `<kind>:<deskId>` special ids, and a
/// new fileId for every file (index, tree nodes, version-history folders
/// and the Google-Doc link sidecar all move together). Without the fileId
/// remint, restoring an archive twice — or restoring one beside the desk
/// it was made from — would put the same id in two desks, which is the
/// exact state `desk_dedupe` exists to prevent.
fn reidentify_desk(root: &Path, new_id: &str) -> Result<(), BoxError> {
    let hush = root.join(".hush");
    let index_path = hush.join("index.json");
    let old_index: HashMap<String, String> = fs::read_to_string(&index_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| serde_json::from_value(v.get("files")?.clone()).ok())
        .unwrap_or_default();

    // Images are addressed *by filename*, so their "fileId" is the
    // filename and markdown refs point at it — reminting those would
    // break every image reference in the desk.
    let mut remap: HashMap<String, String> = HashMap::new();
    let mut new_index: HashMap<String, String> = HashMap::new();
    for (old, rel) in &old_index {
        let keep = old == Path::new(rel).file_name().map(|s| s.to_string_lossy()).unwrap_or_default().as_ref();
        let fresh = if keep { old.clone() } else { uuid::Uuid::new_v4().to_string() };
        if &fresh != old {
            remap.insert(old.clone(), fresh.clone());
        }
        new_index.insert(fresh, rel.clone());
    }

    // Version history is stored per fileId; move each folder with its id
    // so a restored desk keeps its history.
    let versions = hush.join("versions");
    for (old, fresh) in &remap {
        let from = versions.join(old);
        if from.is_dir() {
            let _ = fs::rename(&from, versions.join(fresh));
        }
    }

    if let Some(tree) = fs::read_to_string(hush.join("tree.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<TreeNode>(&s).ok())
    {
        let mut tree = tree;
        let old_desk_id = tree.id.clone();
        tree.id = new_id.to_string();
        rewrite_node(&mut tree, &old_desk_id, new_id, &remap);
        write_atomic_str(&hush.join("tree.json"), &serde_json::to_string_pretty(&tree)?)?;
    }

    write_atomic_str(
        &index_path,
        &serde_json::to_string_pretty(&serde_json::json!({
            "format": "hush-index", "version": 1, "files": new_index,
        }))?,
    )?;

    // Sidecars keyed by fileId ride along too.
    for sidecar in ["gdoc-links.json", "hashes.json"] {
        let path = hush.join(sidecar);
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        remap_json_keys(&mut value, &remap);
        let _ = write_atomic_str(&path, &serde_json::to_string_pretty(&value)?);
    }

    // `.hushdesk` carries the desk's identity + portable meta.
    let meta_path = root.join(".hushdesk");
    let mut meta: serde_json::Value = fs::read_to_string(&meta_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    meta["format"] = "hush-desk".into();
    meta["version"] = 1.into();
    meta["id"] = new_id.into();
    // The last-open file pointer is a fileId, so it needs remapping like
    // any other; drop it rather than leave it pointing at nothing.
    if let Some(inner) = meta.get_mut("meta").and_then(|m| m.as_object_mut()) {
        if let Some(last) = inner.get("lastFileId").and_then(|v| v.as_str()) {
            match remap.get(last) {
                Some(fresh) => { inner.insert("lastFileId".into(), fresh.clone().into()); }
                None => { inner.remove("lastFileId"); inner.remove("lastFileType"); }
            }
        }
    }
    write_atomic_str(&meta_path, &serde_json::to_string_pretty(&meta)?)?;
    Ok(())
}

/// Rewrite one node (and its subtree) onto the new desk: special ids
/// re-namespaced, fileIds remapped, and every tree-node id refreshed so a
/// restored desk can never collide with the one it came from.
fn rewrite_node(node: &mut TreeNode, old_desk_id: &str, new_id: &str, remap: &HashMap<String, String>) {
    for child in node.children.iter_mut() {
        if let Some(suffix) = child.id.strip_suffix(&format!(":{}", old_desk_id)) {
            child.id = format!("{}:{}", suffix, new_id);
        } else if !child.id.starts_with("__") {
            child.id = uuid::Uuid::new_v4().to_string();
        }
        if let Some(ref fid) = child.file_id {
            if let Some(fresh) = remap.get(fid) {
                child.file_id = Some(fresh.clone());
            }
        }
        rewrite_node(child, old_desk_id, new_id, remap);
    }
}

/// Rewrite the top-level keys of a fileId-keyed JSON object.
fn remap_json_keys(value: &mut serde_json::Value, remap: &HashMap<String, String>) {
    let Some(map) = value.as_object_mut() else { return };
    for (old, fresh) in remap {
        if let Some(v) = map.remove(old) {
            map.insert(fresh.clone(), v);
        }
    }
}

/// Archive filenames come back from the frontend, so treat them as
/// untrusted: a bare filename inside the archive directory, nothing else.
pub fn sanitize_handle(file: &str) -> Result<String, BoxError> {
    let name = Path::new(file)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("not an archive filename")?;
    if name != file || !name.ends_with(&format!(".{}", ARCHIVE_EXT)) {
        return Err(format!("not an archive filename: {}", file).into());
    }
    Ok(name.to_string())
}

impl DeskStore {
/// Every archive on disk, newest first.
pub fn list_archives(&self) -> Vec<ArchiveInfo> {
    let dir = self.archives_dir();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else { return out };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(ARCHIVE_EXT) {
            continue;
        }
        let file = entry.file_name().to_string_lossy().into_owned();
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let manifest = read_manifest(&path).unwrap_or_else(|| serde_json::json!({}));
        out.push(ArchiveInfo {
            name: manifest.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled desk").to_string(),
            desk_id: manifest.get("deskId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            archived_at: manifest.get("archivedAt").and_then(|v| v.as_u64()).unwrap_or(0),
            files: manifest.get("files").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
            was_local: manifest.get("wasLocal").and_then(|v| v.as_bool()).unwrap_or(false),
            path: path.to_string_lossy().into_owned(),
            file,
            bytes,
        });
    }
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    out
}

pub fn delete_archive(&self, file: &str) -> Result<(), BoxError> {
    let path = self.archives_dir().join(sanitize_handle(file)?);
    if path.is_file() {
        fs::remove_file(&path)?;
        crate::activity_log::note("desks", "info", format!("Deleted desk archive {}", file));
    }
    Ok(())
}

/// The archive's bytes, for the iPad share sheet. Desktop uses `path`
/// with a save dialog instead and never calls this.
pub fn read_archive(&self, file: &str) -> Result<Vec<u8>, BoxError> {
    Ok(fs::read(self.archives_dir().join(sanitize_handle(file)?))?)
}
}

pub(crate) fn read_manifest(path: &Path) -> Option<serde_json::Value> {
    let bytes = fs::read(path).ok()?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut raw = String::new();
    zip.by_name("archive.json").ok()?.read_to_string(&mut raw).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
#[path = "desk_archive_tests.rs"]
mod tests;
