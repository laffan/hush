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
        self.desks_dir.join(desk_id)
    }
    fn index_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("index.json")
    }
    fn tree_path(&self, desk_id: &str) -> PathBuf {
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

    fn load_index(&self, desk_id: &str) -> HashMap<String, String> {
        fs::read_to_string(self.index_path(desk_id))
            .ok()
            .and_then(|s| serde_json::from_str::<IndexFile>(&s).ok())
            .map(|f| f.files)
            .unwrap_or_default()
    }

    fn save_index(&self, desk_id: &str, files: &HashMap<String, String>) -> Result<(), BoxError> {
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

    /// Every desk id that has a folder with an index or tree.
    fn desk_ids_on_disk(&self) -> Vec<String> {
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
        out
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

    fn load_desk_tree(&self, desk_id: &str) -> Option<TreeNode> {
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
        for (id, (desk_id, rel)) in &old_global {
            if all_new.contains(id) {
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
            let meta = serde_json::json!({
                "format": "hush-desk", "version": 1,
                "id": desk.id, "name": desk.name,
                "createdAt": now_secs(),
            });
            let meta_path = self.desk_dir(&desk.id).join(".hushdesk");
            // Preserve the original createdAt across rewrites.
            let existing: Option<serde_json::Value> = fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
            let mut meta = meta;
            if let Some(prev) = existing.as_ref().and_then(|v| v.get("createdAt")).cloned() {
                meta["createdAt"] = prev;
            }
            write_atomic_str(&meta_path, &serde_json::to_string_pretty(&meta)?)?;
            self.prune_empty_dirs(&desk.id, &expected_dirs[&desk.id]);
        }

        // Retire desk folders whose node vanished. Guarded on the tree
        // actually carrying desks so a transient empty save can't retire
        // the whole library.
        if !desks.is_empty() {
            let live: HashSet<&str> = desks.iter().map(|d| d.id.as_str()).collect();
            for desk_id in self.desk_ids_on_disk() {
                if !live.contains(desk_id.as_str()) {
                    let trash = self.desks_dir.join(".deleted");
                    fs::create_dir_all(&trash).ok();
                    let dst = trash.join(format!("{}-{}", desk_id, now_secs()));
                    let _ = fs::rename(self.desk_dir(&desk_id), &dst);
                }
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
        write_content_at(&dst, "")
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
    /// mtime, and a display name derived from the filename.
    pub fn read_by_id(&self, id: &str) -> Result<(String, u64, String), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            let content = read_content_at(&abs)?;
            let modified = mtime_secs(&abs);
            let name = Path::new(&rel)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            return Ok((content, modified, name));
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
            return write_content_at(&self.abs_path(&desk_id, &rel), content);
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

// ===== Path computation =====

/// Walk a desk's children computing each file-backed node's relative path
/// and the set of expected directories. Sibling filenames are deduped with
/// " (n)" so two same-named nodes of different types can't collide.
fn collect_expected(
    nodes: &[TreeNode],
    dir_stack: &mut Vec<String>,
    files: &mut HashMap<String, String>,
    dirs: &mut HashSet<PathBuf>,
) {
    let mut used: HashSet<String> = HashSet::new();
    for node in nodes {
        match node.node_type.as_str() {
            "folder" | "project" | "desk" => {
                let seg = dedupe(&sanitize_segment(&node.name), "", &mut used);
                dir_stack.push(seg);
                dirs.insert(PathBuf::from(dir_stack.join("/")));
                collect_expected(&node.children, dir_stack, files, dirs);
                dir_stack.pop();
            }
            "document" | "notebook" | "stack" | "image" => {
                let Some(id) = node.file_id.as_ref() else { continue };
                let (base, ext) = match node.node_type.as_str() {
                    "document" => (sanitize_segment(&node.name), ".md"),
                    "notebook" => (sanitize_segment(&node.name), ".hushnote"),
                    "stack" => (sanitize_segment(&node.name), ".hushstack"),
                    // Image names already carry their extension (the
                    // filename IS the id).
                    _ => (sanitize_segment(&node.name), ""),
                };
                let filename = dedupe(&base, ext, &mut used);
                let rel = if dir_stack.is_empty() {
                    filename
                } else {
                    format!("{}/{}", dir_stack.join("/"), filename)
                };
                files.insert(id.clone(), rel);
            }
            _ => {} // pdf (registry-only) and anything unknown
        }
    }
}

fn dedupe(base: &str, ext: &str, used: &mut HashSet<String>) -> String {
    // Avoid double extensions when the display name already carries one.
    let base = if !ext.is_empty() && base.to_lowercase().ends_with(ext) {
        &base[..base.len() - ext.len()]
    } else {
        base
    };
    let mut candidate = format!("{}{}", base, ext);
    let mut i = 2;
    while !used.insert(candidate.to_lowercase()) {
        candidate = format!("{} ({}){}", base, i, ext);
        i += 1;
    }
    candidate
}

/// A tree name as a single path segment: no separators, no leading dot,
/// never empty, bounded length.
pub fn sanitize_segment(name: &str) -> String {
    let mut cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    while cleaned.starts_with('.') {
        cleaned.remove(0);
    }
    let cleaned = cleaned.trim().to_string();
    let mut out = if cleaned.is_empty() { "Untitled".to_string() } else { cleaned };
    if out.chars().count() > 150 {
        out = out.chars().take(150).collect();
    }
    out
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

pub fn write_content_at(path: &Path, content: &str) -> Result<(), BoxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if is_hushnote(path) {
        let bytes = hushnote::pack(content)?;
        write_atomic(path, &bytes)?;
        return Ok(());
    }
    write_atomic_str(path, content)?;
    Ok(())
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
