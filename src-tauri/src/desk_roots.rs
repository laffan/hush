//! Local desk roots — pointing a desk at a folder outside app data.
//!
//! Phase 3 of LOCAL-DESKS-PLANNING.md. `{data_dir}/desks/roots.json`
//! maps deskId → absolute folder path; `DeskStore::desk_dir` consults it,
//! which is the *entire* redirection — files, images, snapshots, and the
//! tree all resolve through that one seam, so a local desk behaves
//! identically to an internal one.
//!
//! - **Make Desk Local** moves the desk's folder contents to a
//!   user-picked directory (same-volume rename with a recursive
//!   copy+delete fallback for cross-volume targets) and registers the
//!   root.
//! - **Make Desk Internal** moves the contents back under
//!   `{data_dir}/desks/<id>/` and unregisters; the emptied external
//!   folder is removed only when nothing (beyond `.DS_Store`) remains.
//! - **Adopt** registers an existing desk folder (it must carry
//!   `.hushdesk` + `.hush/tree.json`) — the handoff seam: any Hush
//!   install can open a desk another install produced.
//!
//! Paths are per-device state (roots.json never travels). The map is
//! mtime-cached because `desk_dir` sits on every storage hot path.
//!
//! On iOS a folder can only be re-opened across launches through a
//! security-scoped bookmark, so a root entry optionally carries one
//! (`{ "path": …, "bookmark": … }`); desktop entries stay bare strings.
//! Bookmarked roots get no filesystem watcher — iOS has none — and are
//! instead reconciled on app foreground.

use crate::atomic::write_atomic_str;
use crate::desk_store::DeskStore;
use crate::TreeNode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

type BoxError = Box<dyn std::error::Error>;

/// One registered local-desk root. `bookmark` is a base64
/// security-scoped bookmark, present only for roots picked on iOS.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RootEntry {
    /// Desktop form — just the absolute path.
    Path(String),
    /// iOS form — path plus the bookmark that re-grants access to it.
    Bookmarked { path: String, bookmark: String },
}

impl RootEntry {
    pub fn path(&self) -> &str {
        match self {
            RootEntry::Path(p) => p,
            RootEntry::Bookmarked { path, .. } => path,
        }
    }
    pub fn bookmark(&self) -> Option<&str> {
        match self {
            RootEntry::Path(_) => None,
            RootEntry::Bookmarked { bookmark, .. } => Some(bookmark),
        }
    }
    pub fn new(path: String, bookmark: Option<String>) -> Self {
        match bookmark {
            Some(b) => RootEntry::Bookmarked { path, bookmark: b },
            None => RootEntry::Path(path),
        }
    }
}

fn roots_path(desks_dir: &Path) -> PathBuf {
    desks_dir.join("roots.json")
}

type CacheMap = HashMap<PathBuf, (Option<SystemTime>, HashMap<String, RootEntry>)>;
static CACHE: OnceLock<Mutex<CacheMap>> = OnceLock::new();

fn cache() -> &'static Mutex<CacheMap> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The full deskId → entry map, re-read only when roots.json's mtime
/// moves.
pub fn load_entries(desks_dir: &Path) -> HashMap<String, RootEntry> {
    let path = roots_path(desks_dir);
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut guard = cache().lock().unwrap();
    if let Some((cached_mtime, map)) = guard.get(desks_dir) {
        if *cached_mtime == mtime {
            return map.clone();
        }
    }
    let map: HashMap<String, RootEntry> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("roots")
                .and_then(|r| serde_json::from_value(r.clone()).ok())
        })
        .unwrap_or_default();
    guard.insert(desks_dir.to_path_buf(), (mtime, map.clone()));
    map
}

/// The deskId → root path map (bookmarks dropped) — what most callers
/// need.
pub fn load_roots(desks_dir: &Path) -> HashMap<String, String> {
    load_entries(desks_dir)
        .into_iter()
        .map(|(id, e)| (id, e.path().to_string()))
        .collect()
}

fn save_entries(desks_dir: &Path, map: &HashMap<String, RootEntry>) -> Result<(), BoxError> {
    let payload = serde_json::json!({ "format": "hush-desk-roots", "version": 2, "roots": map });
    crate::atomic::write_atomic_str(
        &roots_path(desks_dir),
        &serde_json::to_string_pretty(&payload)?,
    )?;
    cache().lock().unwrap().remove(desks_dir);
    Ok(())
}

/// External root for `desk_id`, when one is registered.
pub fn root_for(desks_dir: &Path, desk_id: &str) -> Option<PathBuf> {
    load_entries(desks_dir)
        .get(desk_id)
        .map(|e| PathBuf::from(e.path()))
}

/// Drop a desk's root registration (leaves the folder untouched).
pub fn unregister(desks_dir: &Path, desk_id: &str) {
    let mut map = load_entries(desks_dir);
    if map.remove(desk_id).is_some() {
        let _ = save_entries(desks_dir, &map);
    }
}

/// Repoint a registered root — the iOS boot path, where a bookmark can
/// resolve to a different container path than the one it was minted at.
/// A `bookmark` of `None` keeps the stored one.
pub fn update_root(
    desks_dir: &Path,
    desk_id: &str,
    new_path: &str,
    bookmark: Option<String>,
) -> Result<(), BoxError> {
    let mut map = load_entries(desks_dir);
    let Some(existing) = map.get(desk_id) else {
        return Err(format!("desk {} is not local", desk_id).into());
    };
    let kept = bookmark.or_else(|| existing.bookmark().map(str::to_string));
    map.insert(desk_id.to_string(), RootEntry::new(new_path.to_string(), kept));
    save_entries(desks_dir, &map)
}

impl DeskStore {
    pub fn list_roots(&self) -> HashMap<String, String> {
        load_roots(&self.desks_dir)
    }

    /// Move a desk's folder to `target` and register the root. `target`
    /// must be absolute, outside app data, and empty (or missing).
    /// `bookmark` is the iOS security-scoped bookmark for the target,
    /// when there is one.
    pub fn make_desk_local(
        &self,
        desk_id: &str,
        target: &Path,
        bookmark: Option<String>,
    ) -> Result<(), BoxError> {
        if !target.is_absolute() {
            return Err("target must be an absolute path".into());
        }
        let data_dir = self.desks_dir.parent().unwrap_or(&self.desks_dir);
        if target.starts_with(data_dir) {
            return Err("target must live outside Hush's app data".into());
        }
        let mut roots = load_entries(&self.desks_dir);
        if roots.contains_key(desk_id) {
            return Err("desk is already local".into());
        }
        let src = self.desks_dir.join(desk_id);
        if !src.join(".hush").join("tree.json").exists() {
            return Err(format!("no internal desk folder for {}", desk_id).into());
        }
        if target.exists() {
            if !target.is_dir() {
                return Err("target exists and is not a directory".into());
            }
            if !dir_is_effectively_empty(target)? {
                return Err("target folder is not empty".into());
            }
        } else {
            fs::create_dir_all(target)?;
        }

        move_dir_contents(&src, target)?;
        let _ = fs::remove_dir(&src);
        roots.insert(
            desk_id.to_string(),
            RootEntry::new(target.to_string_lossy().into_owned(), bookmark),
        );
        save_entries(&self.desks_dir, &roots)?;
        Ok(())
    }

    /// Move a local desk's contents back into app data and unregister.
    /// Returns the now-internal folder path.
    pub fn make_desk_internal(&self, desk_id: &str) -> Result<PathBuf, BoxError> {
        let mut roots = load_entries(&self.desks_dir);
        let Some(root) = roots.get(desk_id).map(|e| PathBuf::from(e.path())) else {
            return Err("desk is not local".into());
        };
        let dst = self.desks_dir.join(desk_id);
        if dst.exists() && !dir_is_effectively_empty(&dst)? {
            return Err("internal desk folder unexpectedly occupied".into());
        }
        fs::create_dir_all(&dst)?;
        move_dir_contents(&root, &dst)?;
        // Remove the emptied external folder; if the user had unrelated
        // files in it they survive and the folder stays.
        if dir_is_effectively_empty(&root).unwrap_or(false) {
            let _ = fs::remove_dir_all(&root);
        }
        roots.remove(desk_id);
        save_entries(&self.desks_dir, &roots)?;
        Ok(dst)
    }

    /// Register an existing desk folder produced by any Hush install.
    /// Returns the adopted desk's id. `bookmark` is the iOS
    /// security-scoped bookmark for the folder, when there is one.
    pub fn adopt_desk_folder(
        &self,
        path: &Path,
        bookmark: Option<String>,
    ) -> Result<String, BoxError> {
        if !path.is_absolute() {
            return Err("path must be absolute".into());
        }
        let meta_raw = fs::read_to_string(path.join(".hushdesk"))
            .map_err(|_| "not a desk folder (missing .hushdesk)")?;
        let meta: serde_json::Value = serde_json::from_str(&meta_raw)?;
        let desk_id = meta
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("malformed .hushdesk (no id)")?
            .to_string();
        if !path.join(".hush").join("tree.json").exists() {
            return Err("not a desk folder (missing .hush/tree.json)".into());
        }
        let mut roots = load_entries(&self.desks_dir);
        if roots.contains_key(&desk_id)
            || self.desks_dir.join(&desk_id).join(".hush").join("tree.json").exists()
        {
            return Err(format!("desk {} is already registered", desk_id).into());
        }
        roots.insert(
            desk_id.clone(),
            RootEntry::new(path.to_string_lossy().into_owned(), bookmark),
        );
        save_entries(&self.desks_dir, &roots)?;
        self.append_to_order(&desk_id)?;
        Ok(desk_id)
    }

    /// Open **any** folder as a desk, in place.
    ///
    /// A folder that already carries `.hushdesk` + `.hush/tree.json` is
    /// adopted as-is (the handoff case). Anything else is *initialised*:
    /// whatever docs, notebooks and images are already inside are
    /// absorbed into the desk tree **first** — the sidecar written into
    /// the folder the user picked already carries them, so at no point
    /// does the folder look like an empty desk (a window a concurrent
    /// tree save once mistook for "this desk has no files", which is how
    /// a populated folder could be wiped to a bare skeleton). The folder
    /// itself becomes the desk root; nothing is moved or nested. A
    /// failure mid-initialise removes the partial sidecars so the folder
    /// is left exactly as picked.
    ///
    /// Returns the desk id either way.
    pub fn open_folder_as_desk(
        &self,
        path: &Path,
        bookmark: Option<String>,
    ) -> Result<String, BoxError> {
        if !path.is_absolute() {
            return Err("path must be absolute".into());
        }
        if !path.is_dir() {
            return Err("that isn't a folder".into());
        }
        // Already a desk — the adopt path owns identity and registration.
        if path.join(".hushdesk").exists() && path.join(".hush").join("tree.json").exists() {
            return self.adopt_desk_folder(path, bookmark);
        }
        let data_dir = self.desks_dir.parent().unwrap_or(&self.desks_dir);
        if path.starts_with(data_dir) {
            return Err("folder must live outside Hush's app data".into());
        }
        let mut roots = load_entries(&self.desks_dir);
        if roots.values().any(|e| Path::new(e.path()) == path) {
            return Err("that folder is already open as a desk".into());
        }
        // A half-initialised folder (one sidecar but not the other) is
        // not something to guess at — say so rather than overwrite.
        if path.join(".hushdesk").exists() || path.join(".hush").exists() {
            return Err("that folder holds a damaged desk (.hushdesk / .hush mismatch)".into());
        }

        let desk_id = uuid::Uuid::new_v4().to_string();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Desk")
            .to_string();
        let created_at = now_secs();
        let mut desk = TreeNode {
            id: desk_id.clone(),
            name: name.clone(),
            node_type: "desk".to_string(),
            children: desk_specials(&desk_id),
            ..Default::default()
        };
        // Absorb the folder's existing files into the tree + index
        // before anything is written, so the first sidecar on disk is
        // already complete. The specials were seeded above, so an
        // existing `Inbox/` (or `Images/`, …) directory folds into the
        // matching special instead of doubling beside it.
        let mut index = std::collections::HashMap::new();
        crate::desk_scan::absorb_disk_files(path, &mut desk, &mut index);

        // Written directly against `path` rather than through
        // `self.tree_path(&desk_id)` so the sidecar lands before the root
        // is registered — no dependence on the roots cache refreshing
        // between the two writes. Any failure from here on rolls the
        // partial sidecars back so a re-pick starts clean.
        let init = || -> Result<(), BoxError> {
            let hush_dir = path.join(".hush");
            fs::create_dir_all(&hush_dir)?;
            write_atomic_str(
                &hush_dir.join("tree.json"),
                &serde_json::to_string_pretty(&desk)?,
            )?;
            write_atomic_str(
                &hush_dir.join("index.json"),
                &serde_json::to_string_pretty(&serde_json::json!({
                    "format": "hush-index", "version": 1, "files": index,
                }))?,
            )?;
            write_atomic_str(
                &path.join(".hushdesk"),
                &serde_json::to_string_pretty(&serde_json::json!({
                    "format": "hush-desk",
                    "version": 1,
                    "id": desk_id,
                    "name": name,
                    "createdAt": created_at,
                }))?,
            )?;
            Ok(())
        };
        if let Err(e) = init() {
            let _ = fs::remove_file(path.join(".hushdesk"));
            let _ = fs::remove_dir_all(path.join(".hush"));
            return Err(e);
        }

        roots.insert(
            desk_id.clone(),
            RootEntry::new(path.to_string_lossy().into_owned(), bookmark),
        );
        save_entries(&self.desks_dir, &roots)?;
        self.append_to_order(&desk_id)?;
        Ok(desk_id)
    }
}

/// The four per-desk specials, ids namespaced exactly the way
/// `state-desks.js#specialNodeId` builds them (`<kind>:<deskId>`) and in
/// the order `ensureDeskSpecials` pins them: Inbox first, then Images,
/// Archive, Trash. Created up front so the reconcile that follows folds
/// an existing `Inbox/` (or `Images/`, …) directory into the matching
/// special instead of adding a second plain folder beside it.
fn desk_specials(desk_id: &str) -> Vec<TreeNode> {
    [
        ("__inbox__", "project", "Inbox"),
        ("__images__", "folder", "Images"),
        ("__archive__", "folder", "Archive"),
        ("__trash__", "folder", "Trash"),
    ]
    .into_iter()
    .map(|(kind, node_type, name)| TreeNode {
        id: format!("{}:{}", kind, desk_id),
        name: name.to_string(),
        node_type: node_type.to_string(),
        ..Default::default()
    })
    .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Empty, or nothing but `.DS_Store` junk.
fn dir_is_effectively_empty(dir: &Path) -> Result<bool, BoxError> {
    for entry in fs::read_dir(dir)?.flatten() {
        if entry.file_name().to_string_lossy() != ".DS_Store" {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Move every entry of `src` into `dst` (which exists and is empty).
/// Per-entry `fs::rename` with a recursive copy+delete fallback so
/// cross-volume targets work.
fn move_dir_contents(src: &Path, dst: &Path) -> Result<(), BoxError> {
    for entry in fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if fs::rename(&from, &to).is_ok() {
            continue;
        }
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
            fs::remove_dir_all(&from)?;
        } else {
            fs::copy(&from, &to)?;
            fs::remove_file(&from)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), BoxError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
