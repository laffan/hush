//! Desk-folder storage — every desk is a self-contained directory.
//!
//! Layout (see LOCAL-DESKS-PLANNING.md):
//!
//! ```text
//! {data_dir}/desks/
//! ├── order.json                  desk ordering + transient stragglers
//! ├── .staging/<fileId>           files created before they have a tree position
//! └── <deskId>/
//!     ├── .hushdesk               desk identity { id, name, createdAt }
//!     ├── .hush/
//!     │   ├── index.json          fileId ↔ relative path
//!     │   ├── tree.json           the desk's TreeNode (structure + decoration)
//!     │   └── orphans/            files whose tree node vanished without a delete
//!     ├── Inbox/…  Trash/…  Images/…
//!     ├── <Project>/<Doc>.md
//!     ├── <Doc>.md  <Notebook>.hushnote  <Stack>.hushstack
//! ```
//!
//! The tree (`tree.json`) is authoritative for structure and ordering in
//! this phase; the content files mirror it. `reconcile` runs on every
//! tree save: it computes each fileId's expected path from the tree,
//! compares against the index, and moves/creates/adopts files so the
//! folder always matches. Filesystem-wins reconciliation (for shared /
//! local desk folders) layers on top of this in a later phase.
//!
//! PDFs are intentionally absent: their registry is metadata-only and
//! binaries stay a per-device cache (`files/pdfs/`).

use crate::atomic::{write_atomic, write_atomic_str};
use crate::desk_paths::{collect_expected, sanitize_segment};
use crate::hushnote;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

pub struct DeskStore {
    pub desks_dir: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct OrderFile {
    #[serde(default)]
    order: Vec<String>,
    #[serde(default)]
    stragglers: Vec<TreeNode>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct IndexFile {
    #[serde(default)]
    files: HashMap<String, String>, // fileId -> relative path
}

impl DeskStore {
    pub fn new(data_dir: &Path) -> Self {
        let desks_dir = data_dir.join("desks");
        fs::create_dir_all(&desks_dir).ok();
        Self { desks_dir }
    }

    // ===== Paths =====

    pub(crate) fn desk_dir(&self, desk_id: &str) -> PathBuf {
        // Local desks resolve through roots.json — the single seam that
        // makes an external folder behave exactly like an internal desk.
        if let Some(root) = crate::desk_roots::root_for(&self.desks_dir, desk_id) {
            return root;
        }
        self.desks_dir.join(desk_id)
    }
    pub(crate) fn index_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("index.json")
    }
    pub(crate) fn tree_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("tree.json")
    }
    fn order_path(&self) -> PathBuf {
        self.desks_dir.join("order.json")
    }
    pub(crate) fn staging_path(&self, id: &str) -> PathBuf {
        self.desks_dir.join(".staging").join(id)
    }

    fn abs_path(&self, desk_id: &str, rel: &str) -> PathBuf {
        self.desk_dir(desk_id).join(rel)
    }

    // ===== Index IO =====

    pub(crate) fn load_index(&self, desk_id: &str) -> HashMap<String, String> {
        fs::read_to_string(self.index_path(desk_id))
            .ok()
            .and_then(|s| serde_json::from_str::<IndexFile>(&s).ok())
            .map(|f| f.files)
            .unwrap_or_default()
    }

    pub(crate) fn save_index(&self, desk_id: &str, files: &HashMap<String, String>) -> Result<(), BoxError> {
        let path = self.index_path(desk_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let payload = serde_json::json!({
            "format": "hush-index", "version": 1, "files": files,
        });
        write_atomic_str(&path, &serde_json::to_string_pretty(&payload)?)?;
        Ok(())
    }

    /// Every desk id with a resolvable folder: internal subdirectories
    /// plus registered local roots (both validated by their tree.json).
    pub(crate) fn desk_ids_on_disk(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.desks_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !entry.path().is_dir() {
                    continue;
                }
                if entry.path().join(".hush").join("tree.json").exists() {
                    out.push(name);
                }
            }
        }
        for (desk_id, root) in crate::desk_roots::load_roots(&self.desks_dir) {
            if out.contains(&desk_id) {
                continue;
            }
            if Path::new(&root).join(".hush").join("tree.json").exists() {
                out.push(desk_id);
            }
        }
        out
    }

    /// Append a desk id to order.json (used by the adopt flow so a newly
    /// registered desk lands at a stable position instead of re-sorting
    /// on every load).
    pub(crate) fn append_to_order(&self, desk_id: &str) -> Result<(), BoxError> {
        let mut order: OrderFile = fs::read_to_string(self.order_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if !order.order.iter().any(|d| d == desk_id) {
            order.order.push(desk_id.to_string());
            write_atomic_str(&self.order_path(), &serde_json::to_string_pretty(&order)?)?;
        }
        Ok(())
    }

    /// fileId -> (deskId, relPath) across every desk.
    pub fn global_index(&self) -> HashMap<String, (String, String)> {
        let mut out = HashMap::new();
        for desk_id in self.desk_ids_on_disk() {
            for (id, rel) in self.load_index(&desk_id) {
                out.insert(id, (desk_id.clone(), rel));
            }
        }
        out
    }

    /// Ids currently parked in staging (created, not yet placed in a tree).
    pub fn staged_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(self.desks_dir.join(".staging")) {
            for entry in rd.flatten() {
                if entry.path().is_file() {
                    out.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        out
    }

    // ===== Forest (tree of desks) =====

    pub fn has_store(&self) -> bool {
        self.order_path().exists()
    }

    pub fn load_forest(&self) -> Result<Vec<TreeNode>, BoxError> {
        let order: OrderFile = fs::read_to_string(self.order_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let mut seen = HashSet::new();
        let mut forest = Vec::new();
        for desk_id in &order.order {
            if let Some(node) = self.load_desk_tree(desk_id) {
                seen.insert(desk_id.clone());
                forest.push(node);
            }
        }
        // Desk folders present on disk but missing from order.json (e.g. a
        // folder dropped in by hand) append at the end — the adopt seam.
        for desk_id in self.desk_ids_on_disk() {
            if !seen.contains(&desk_id) {
                if let Some(node) = self.load_desk_tree(&desk_id) {
                    forest.push(node);
                }
            }
        }
        forest.extend(order.stragglers);
        Ok(forest)
    }

    pub(crate) fn load_desk_tree(&self, desk_id: &str) -> Option<TreeNode> {
        let s = fs::read_to_string(self.tree_path(desk_id)).ok()?;
        serde_json::from_str::<TreeNode>(&s).ok()
    }

    /// Persist the full forest: per-desk tree.json + .hushdesk + path
    /// reconciliation, order.json with stragglers, and retirement of desk
    /// folders whose desk node vanished (moved to `.deleted/`, never wiped).
    pub fn save_forest(&self, tree: &[TreeNode]) -> Result<(), BoxError> {
        let desks: Vec<&TreeNode> = tree.iter().filter(|n| n.node_type == "desk").collect();
        let stragglers: Vec<TreeNode> = tree
            .iter()
            .filter(|n| n.node_type != "desk")
            .cloned()
            .collect();

        let old_global = self.global_index();

        // Expected placement for every file-backed node, per desk.
        let mut new_indexes: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut expected_dirs: HashMap<String, HashSet<PathBuf>> = HashMap::new();
        for desk in &desks {
            let mut files = HashMap::new();
            let mut dirs = HashSet::new();
            collect_expected(&desk.children, &mut Vec::new(), &mut files, &mut dirs);
            new_indexes.insert(desk.id.clone(), files);
            expected_dirs.insert(desk.id.clone(), dirs);
        }

        // Move / create / adopt every expected file.
        for desk in &desks {
            fs::create_dir_all(self.desk_dir(&desk.id).join(".hush"))?;
            for dir in expected_dirs.get(&desk.id).into_iter().flatten() {
                fs::create_dir_all(self.desk_dir(&desk.id).join(dir))?;
            }
            let files = &new_indexes[&desk.id];
            for (id, rel) in files {
                self.place_file(id, &desk.id, rel, &old_global)?;
            }
        }

        // Files referenced by straggler nodes (transient non-desk
        // top-level entries awaiting absorption) keep their current
        // placement — orphaning them would blank docs the tree still
        // shows. Their index entries carry over verbatim.
        let mut straggler_ids = Vec::new();
        collect_file_ids(&stragglers, &mut straggler_ids);
        for (id, _) in &straggler_ids {
            if let Some((desk_id, rel)) = old_global.get(id) {
                new_indexes
                    .entry(desk_id.clone())
                    .or_default()
                    .insert(id.clone(), rel.clone());
            }
        }

        // Orphans: indexed files whose node vanished without a delete.
        // Park them under .hush/orphans/ so nothing is silently lost and
        // the namespace stays clean for future same-name files.
        let mut all_new: HashSet<&String> = HashSet::new();
        for files in new_indexes.values() {
            all_new.extend(files.keys());
        }
        let live_ids: HashSet<&str> = desks.iter().map(|d| d.id.as_str()).collect();
        for (id, (desk_id, rel)) in &old_global {
            if all_new.contains(id) {
                continue;
            }
            // The whole desk is vanishing — retirement (or, for local
            // desks, unregistration) owns its folder; shuffling files
            // into orphans first would rearrange a user's directory.
            if !live_ids.contains(desk_id.as_str()) {
                continue;
            }
            let src = self.abs_path(desk_id, rel);
            if src.exists() {
                let orphan_dir = self.desk_dir(desk_id).join(".hush").join("orphans");
                fs::create_dir_all(&orphan_dir)?;
                let base = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let mut dst = orphan_dir.join(&base);
                let mut i = 2;
                while dst.exists() {
                    dst = orphan_dir.join(format!("{} ({})", base, i));
                    i += 1;
                }
                let _ = fs::rename(&src, &dst);
            }
        }

        // Persist per-desk metadata + indexes.
        for desk in &desks {
            self.save_index(&desk.id, &new_indexes[&desk.id])?;
            write_atomic_str(
                &self.tree_path(&desk.id),
                &serde_json::to_string_pretty(desk)?,
            )?;
            let meta_path = self.desk_dir(&desk.id).join(".hushdesk");
            // Start from the existing file so createdAt and any fields
            // other writers own (the per-desk "meta" object — style,
            // last file, stickies) survive the rewrite.
            let mut meta: serde_json::Value = fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            meta["format"] = "hush-desk".into();
            meta["version"] = 1.into();
            meta["id"] = desk.id.clone().into();
            meta["name"] = desk.name.clone().into();
            if meta.get("createdAt").is_none() {
                meta["createdAt"] = now_secs().into();
            }
            write_atomic_str(&meta_path, &serde_json::to_string_pretty(&meta)?)?;
            self.prune_empty_dirs(&desk.id, &expected_dirs[&desk.id]);
        }

        // Retire desk folders whose node vanished. Guarded on the tree
        // actually carrying desks so a transient empty save can't retire
        // the whole library.
        if !desks.is_empty() {
            let live: HashSet<&str> = desks.iter().map(|d| d.id.as_str()).collect();
            let roots = crate::desk_roots::load_roots(&self.desks_dir);
            for desk_id in self.desk_ids_on_disk() {
                if live.contains(desk_id.as_str()) {
                    continue;
                }
                if roots.contains_key(&desk_id) {
                    // A local desk's folder belongs to the user — never
                    // relocate it into app data. Deleting the desk just
                    // unregisters the root.
                    crate::desk_roots::unregister(&self.desks_dir, &desk_id);
                    continue;
                }
                let trash = self.desks_dir.join(".deleted");
                fs::create_dir_all(&trash).ok();
                let dst = trash.join(format!("{}-{}", desk_id, now_secs()));
                let _ = fs::rename(self.desk_dir(&desk_id), &dst);
            }
        }

        let order = OrderFile {
            order: desks.iter().map(|d| d.id.clone()).collect(),
            stragglers,
        };
        write_atomic_str(&self.order_path(), &serde_json::to_string_pretty(&order)?)?;
        Ok(())
    }

    /// Ensure the file for `id` exists at its expected location, sourcing
    /// from (in priority order) its previous indexed location, the staging
    /// area, an already-present file at the target (adopt), or — for text
    /// kinds — a fresh default payload.
    fn place_file(
        &self,
        id: &str,
        desk_id: &str,
        rel: &str,
        old_global: &HashMap<String, (String, String)>,
    ) -> Result<(), BoxError> {
        let dst = self.abs_path(desk_id, rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }

        if let Some((old_desk, old_rel)) = old_global.get(id) {
            if old_desk == desk_id && old_rel == rel {
                return Ok(()); // already in place
            }
            let src = self.abs_path(old_desk, old_rel);
            if src.exists() {
                if dst.exists() {
                    // Shouldn't happen (names are deduped) — don't clobber.
                    return Ok(());
                }
                fs::rename(&src, &dst)?;
                // A cross-desk move carries the file's version history
                // along so a handed-off desk stays complete.
                if old_desk != desk_id {
                    let old_versions = self.desk_dir(old_desk).join(".hush").join("versions").join(id);
                    if old_versions.is_dir() {
                        let new_versions = self.desk_dir(desk_id).join(".hush").join("versions").join(id);
                        if let Some(parent) = new_versions.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if !new_versions.exists() {
                            let _ = fs::rename(&old_versions, &new_versions);
                        }
                    }
                }
                return Ok(());
            }
        }

        let staged = self.staging_path(id);
        if staged.exists() {
            let content = fs::read_to_string(&staged).unwrap_or_default();
            write_content_at(&dst, &content)?;
            let _ = fs::remove_file(&staged);
            return Ok(());
        }

        if dst.exists() {
            return Ok(()); // adopt (e.g. a binary the image manager already wrote)
        }

        // Images have no default payload — the binary either exists or the
        // ref is broken; creating an empty file would mask that.
        if is_image_rel(rel) {
            return Ok(());
        }
        write_content_at(&dst, "")?;
        Ok(())
    }

    /// Remove directories that are now empty and no longer expected.
    fn prune_empty_dirs(&self, desk_id: &str, expected: &HashSet<PathBuf>) {
        let root = self.desk_dir(desk_id);
        let mut dirs = Vec::new();
        collect_dirs(&root, &root, &mut dirs);
        // Deepest first so nested empties collapse upward.
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for rel in dirs {
            if rel.starts_with(".hush") {
                continue;
            }
            if expected.contains(&rel) {
                continue;
            }
            let abs = root.join(&rel);
            if fs::read_dir(&abs).map(|mut it| it.next().is_none()).unwrap_or(false) {
                let _ = fs::remove_dir(&abs);
            }
        }
    }

    // ===== Content by fileId =====

    pub fn locate(&self, id: &str) -> Option<(String, String)> {
        for desk_id in self.desk_ids_on_disk() {
            if let Some(rel) = self.load_index(&desk_id).remove(id) {
                return Some((desk_id, rel));
            }
        }
        None
    }

    pub fn stage_new(&self, id: &str) -> Result<(), BoxError> {
        let path = self.staging_path(id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic_str(&path, "")?;
        Ok(())
    }

    /// Read a file's content (unpacked to the internal string form), its
    /// mtime, and a display name derived from the filename — from a known
    /// desk id + relative path, skipping the id → location lookup.
    /// `list_files` already holds (desk, rel) from `list_ids`, so it
    /// reads directly instead of re-`locate`-ing every id — which
    /// re-parses each desk's full index once per file (O(N²) over the
    /// library, the cost that stalled autosave on large desks).
    pub fn read_at(&self, desk_id: &str, rel: &str) -> Result<(String, u64, String), BoxError> {
        let abs = self.abs_path(desk_id, rel);
        let content = read_content_at(&abs)?;
        let modified = mtime_secs(&abs);
        let name = Path::new(rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        Ok((content, modified, name))
    }

    /// Same tuple as `read_at`, but locates the file by id first (for
    /// single-file reads where the caller doesn't already know the path).
    pub fn read_by_id(&self, id: &str) -> Result<(String, u64, String), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            return self.read_at(&desk_id, &rel);
        }
        let staged = self.staging_path(id);
        if staged.exists() {
            let content = fs::read_to_string(&staged)?;
            return Ok((content, mtime_secs(&staged), "Untitled".to_string()));
        }
        Err(format!("file not found: {}", id).into())
    }

    pub fn write_by_id(&self, id: &str, content: &str) -> Result<(), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            let hash = write_content_at(&abs, content)?;
            if !is_image_rel(&rel) {
                self.record_hash(&desk_id, id, &hash, crate::desk_hashes::mtime_ms(&abs));
            }
            return Ok(());
        }
        // Not placed yet — keep (or put) it in staging; the next tree save
        // moves it to its real path.
        let staged = self.staging_path(id);
        if let Some(parent) = staged.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic_str(&staged, content)?;
        Ok(())
    }

    pub fn delete_by_id(&self, id: &str) -> Result<(), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            if abs.exists() {
                fs::remove_file(&abs)?;
            }
            let mut index = self.load_index(&desk_id);
            index.remove(id);
            self.save_index(&desk_id, &index)?;
            return Ok(());
        }
        let staged = self.staging_path(id);
        if staged.exists() {
            fs::remove_file(&staged)?;
        }
        Ok(())
    }

    /// Rename the backing file in place (same directory, extension kept).
    /// Staged / unplaced ids are a no-op — the tree name wins at placement.
    pub fn rename_by_id(&self, id: &str, new_name: &str) -> Result<(), BoxError> {
        let Some((desk_id, rel)) = self.locate(id) else { return Ok(()) };
        let rel_path = Path::new(&rel);
        let ext = rel_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let dir = rel_path.parent().unwrap_or(Path::new(""));
        let mut base = sanitize_segment(new_name);
        if !ext.is_empty() {
            let suffix = format!(".{}", ext);
            if base.to_lowercase().ends_with(&suffix) {
                base.truncate(base.len() - suffix.len());
            }
        }
        let new_rel_path = if ext.is_empty() {
            dir.join(&base)
        } else {
            dir.join(format!("{}.{}", base, ext))
        };
        let new_rel = new_rel_path.to_string_lossy().replace('\\', "/");
        if new_rel == rel {
            return Ok(());
        }
        let src = self.abs_path(&desk_id, &rel);
        let dst = self.abs_path(&desk_id, &new_rel);
        if dst.exists() {
            return Ok(()); // collision — leave it; reconcile dedupes on the next tree save
        }
        if src.exists() {
            fs::rename(&src, &dst)?;
        }
        let mut index = self.load_index(&desk_id);
        index.insert(id.to_string(), new_rel);
        self.save_index(&desk_id, &index)?;
        Ok(())
    }

    /// All known file ids: indexed (with desk + rel) plus staged.
    pub fn list_ids(&self) -> (Vec<(String, String, String)>, Vec<String>) {
        let mut indexed = Vec::new();
        for desk_id in self.desk_ids_on_disk() {
            for (id, rel) in self.load_index(&desk_id) {
                indexed.push((id, desk_id.clone(), rel));
            }
        }
        (indexed, self.staged_ids())
    }
}

// ===== Content IO by extension =====

fn is_hushnote(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("hushnote")
}

fn is_image_rel(rel: &str) -> bool {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "heic" | "heif" | "avif"
            | "tif" | "tiff"
    )
}

pub fn read_content_at(path: &Path) -> Result<String, BoxError> {
    if is_hushnote(path) {
        let bytes = fs::read(path)?;
        return hushnote::unpack(&bytes);
    }
    Ok(fs::read_to_string(path)?)
}

/// Write content in its on-disk form; returns the FNV-1a hash of the
/// bytes actually written (which differ from `content` for hushnotes),
/// so callers can feed the rename-pairing cache without a re-read.
pub fn write_content_at(path: &Path, content: &str) -> Result<String, BoxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if is_hushnote(path) {
        let bytes = hushnote::pack(content)?;
        write_atomic(path, &bytes)?;
        return Ok(crate::desk_hashes::fnv1a_hex(&bytes));
    }
    write_atomic_str(path, content)?;
    Ok(crate::desk_hashes::fnv1a_hex(content.as_bytes()))
}

// ===== Small helpers =====

fn collect_dirs(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(rel) = path.strip_prefix(root) {
                if rel.starts_with(".hush") {
                    continue;
                }
                out.push(rel.to_path_buf());
            }
            collect_dirs(root, &path, out);
        }
    }
}

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn collect_file_ids(nodes: &[TreeNode], out: &mut Vec<(String, String)>) {
    for n in nodes {
        if let Some(ref fid) = n.file_id {
            out.push((fid.clone(), n.node_type.clone()));
        }
        collect_file_ids(&n.children, out);
    }
}

#[cfg(test)]
#[path = "desk_store_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "desk_soak_tests.rs"]
mod soak_tests;
