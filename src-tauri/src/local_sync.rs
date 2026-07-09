//! Local Sync — desktop-only direct-filesystem folder mounting.
//!
//! Unlike Dropbox sync (which mirrors the internal file tree to a cloud
//! folder) or the external-folder sync (which imports files into the
//! internal store with version control), Local Sync folders are *reflected*:
//! the sidebar shows whatever is on disk under the mounted path, edits
//! write straight back, and `notify`-crate watchers push filesystem
//! changes into the UI as soon as they happen.
//!
//! Unsyncing a folder is strictly non-destructive — the only thing that
//! changes is that the folder disappears from the sidebar.

use crate::atomic::write_atomic_str;
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter};

/// Supported extensions for files visible in the tree. Hidden files (`.foo`)
/// and anything not in this list are filtered out of listings. Images
/// surface so a Local Sync `.md` can reference sibling files on disk and
/// so the sidebar shows them with hover preview.
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt",
    "hushnote", "hushstack", "hushproject",
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
    "heic", "heif", "avif", "tif", "tiff",
];

/// Extensions that the JS side treats as binary image refs. Used to
/// classify entries (and to gate text vs binary read paths).
pub const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
    "heic", "heif", "avif", "tif", "tiff",
];

pub fn is_image_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&lower.as_str())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncFolder {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at: i64,
    /// Optional desk id this mount belongs to. None when desks are off
    /// (or the user hasn't picked one yet — JS side falls back to the
    /// active desk in that case).
    #[serde(default)]
    pub desk_id: Option<String>,
    /// iOS-only — base64 security-scoped bookmark for the mount. On iOS
    /// the `path` is not directly reachable across launches; the JS
    /// layer resolves this bookmark through the icloud-folder plugin to
    /// re-acquire access before any read/write. Absent on desktop mounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSyncEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub modified: u64,
    /// True when this entry's extension is one of the image types. JS
    /// uses this to route clicks to the preview modal instead of the
    /// text editor.
    pub is_image: bool,
}

pub struct LocalSyncManager {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl LocalSyncManager {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Install a watcher for `folder`. Emits `local-sync-changed` events
    /// with payload `{ id, path }` on every filesystem change inside the
    /// mounted root. Idempotent — reinstalling replaces any previous
    /// watcher for the same id.
    pub fn watch(&self, app: AppHandle, folder: &LocalSyncFolder) -> Result<(), String> {
        let id = folder.id.clone();
        let path = PathBuf::from(&folder.path);
        if !path.is_dir() {
            return Err(format!("Not a directory: {}", folder.path));
        }

        let id_for_cb = id.clone();
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(
            move |res: Result<Event, notify::Error>| {
                if let Ok(ev) = res {
                    // Filter to content-affecting events. Metadata-only
                    // modifies are excluded *explicitly* — they're a
                    // `Modify` variant, so the old bare `Modify(_)` arm
                    // let them through. That mattered inside iCloud
                    // Drive folders: bird sets xattrs / upload
                    // bookkeeping on a file seconds after every write,
                    // and those no-content events reached the frontend
                    // as apparent external edits. (The JS side also
                    // detects echoes by content hash; this just drops
                    // the noise at the source.)
                    let content_affecting = match ev.kind {
                        EventKind::Create(_) | EventKind::Remove(_) => true,
                        EventKind::Modify(ModifyKind::Metadata(_)) => false,
                        EventKind::Modify(_) => true,
                        _ => false,
                    };
                    if content_affecting {
                        let payload = serde_json::json!({
                            "id": id_for_cb,
                            "paths": ev
                                .paths
                                .iter()
                                .map(|p| p.to_string_lossy().into_owned())
                                .collect::<Vec<_>>(),
                        });
                        let _ = app.emit("local-sync-changed", payload);
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;

        watcher
            .watch(&path, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        let mut map = self.watchers.lock().unwrap();
        map.insert(id, watcher);
        Ok(())
    }

    pub fn unwatch(&self, id: &str) {
        let mut map = self.watchers.lock().unwrap();
        map.remove(id);
    }

    pub fn unwatch_all(&self) {
        let mut map = self.watchers.lock().unwrap();
        map.clear();
    }
}

/// Return a sorted directory listing for `folder` at `rel_path`.
/// Hidden entries (names starting with `.`) and files whose extension
/// isn't in `SUPPORTED_EXTENSIONS` are skipped.
pub fn list_dir(folder: &LocalSyncFolder, rel_path: &str) -> Result<Vec<LocalSyncEntry>, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if !abs.is_dir() {
        return Err(format!("Not a directory: {}", abs.display()));
    }

    let mut entries = Vec::new();
    let iter = fs::read_dir(&abs).map_err(|e| e.to_string())?;
    for entry in iter.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let mut ext_lower = String::new();
        if !is_dir {
            ext_lower = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
                continue;
            }
        }
        let is_image = !is_dir && is_image_extension(&ext_lower);
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let rel = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_path.trim_end_matches('/'), name)
        };
        entries.push(LocalSyncEntry {
            name,
            rel_path: rel,
            is_dir,
            modified,
            is_image,
        });
    }
    // Directories before files, then name-sorted inside each group.
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    Ok(entries)
}

pub fn read_file(folder: &LocalSyncFolder, rel_path: &str) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

pub fn write_file(folder: &LocalSyncFolder, rel_path: &str, content: &str) -> Result<(), String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic_str(&abs, content).map_err(|e| e.to_string())
}

/// Read raw bytes — used by the JS side to fetch image binaries that
/// live next to a Local Sync `.md` file.
pub fn read_file_bytes(folder: &LocalSyncFolder, rel_path: &str) -> Result<Vec<u8>, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    fs::read(&abs).map_err(|e| e.to_string())
}

/// Overwrite (or create) a binary file at exactly `rel_path` — no
/// collision suffixing. Used to autosave a notebook `.hushnote` back to
/// the same file on every save.
pub fn write_file_bytes_exact(
    folder: &LocalSyncFolder,
    rel_path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::atomic::write_atomic(&abs, bytes).map_err(|e| e.to_string())
}

/// Write raw bytes. Auto-suffixes on collision so a dropped image
/// doesn't clobber an existing sibling. Returns the actual relative
/// path written (the caller uses this for the markdown ref).
pub fn write_file_bytes_unique(
    folder: &LocalSyncFolder,
    rel_path: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let final_abs = unique_path(&abs);
    fs::write(&final_abs, bytes).map_err(|e| e.to_string())?;
    // Recompute the rel_path for the suffixed file.
    let canon_root = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let final_rel = final_abs
        .strip_prefix(&canon_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| rel_path.to_string());
    Ok(final_rel)
}

/// Create a new text file, auto-suffixing the name on collision. Returns
/// the actual relative path written so the caller can open / select it.
pub fn create_file_unique(
    folder: &LocalSyncFolder,
    rel_path: &str,
    content: &str,
) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let final_abs = unique_path(&abs);
    write_atomic_str(&final_abs, content).map_err(|e| e.to_string())?;
    rel_of(&root, &final_abs, rel_path)
}

/// Create a new directory, auto-suffixing the name on collision. Returns
/// the actual relative path created.
pub fn create_dir_unique(folder: &LocalSyncFolder, rel_path: &str) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    let final_abs = unique_dir_path(&abs);
    fs::create_dir_all(&final_abs).map_err(|e| e.to_string())?;
    rel_of(&root, &final_abs, rel_path)
}

/// Rename a file or directory in place (same parent dir). `new_name` is a
/// bare filename (no slashes); on collision a numeric suffix is appended.
/// Returns the new relative path.
pub fn rename_entry(
    folder: &LocalSyncFolder,
    rel_path: &str,
    new_name: &str,
) -> Result<String, String> {
    if new_name.contains('/') || new_name.contains('\\') || new_name.is_empty() {
        return Err("Invalid name".to_string());
    }
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if !abs.exists() {
        return Err(format!("No such entry: {}", rel_path));
    }
    let parent = abs.parent().ok_or_else(|| "No parent".to_string())?;
    let dest = parent.join(new_name);
    // Renaming to the same name is a no-op — return the current rel path.
    if dest == abs {
        return rel_of(&root, &abs, rel_path);
    }
    let is_dir = abs.is_dir();
    let final_dest = if is_dir { unique_dir_path(&dest) } else { unique_path(&dest) };
    fs::rename(&abs, &final_dest).map_err(|e| e.to_string())?;
    rel_of(&root, &final_dest, rel_path)
}

/// Permanently delete a file or directory (recursive for directories).
/// Delete a directory only when nothing meaningful remains inside it —
/// empty directories and macOS `.DS_Store` junk are the only tolerated
/// contents (checked recursively). Returns true when the directory was
/// removed. Used after a folder-move into Hush: the listing filter hides
/// unsupported files (PDFs, dotfiles, `.git`, …), so an unconditional
/// recursive delete could destroy data the import never saw.
pub fn delete_dir_if_clean(folder: &LocalSyncFolder, rel_path: &str) -> Result<bool, String> {
    if rel_path.is_empty() {
        return Err("refusing to remove the mount root".to_string());
    }
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if !abs.is_dir() {
        return Ok(false);
    }
    if !dir_is_clean(&abs)? {
        return Ok(false);
    }
    fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
    Ok(true)
}

fn dir_is_clean(dir: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            if !dir_is_clean(&entry.path())? {
                return Ok(false);
            }
        } else if name != ".DS_Store" {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn delete_entry(folder: &LocalSyncFolder, rel_path: &str) -> Result<(), String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if abs.is_dir() {
        fs::remove_dir_all(&abs).map_err(|e| e.to_string())
    } else if abs.exists() {
        fs::remove_file(&abs).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Move a file or directory into `dst_dir_rel` (a directory relative path,
/// "" for the mount root), keeping its filename. Collision auto-suffixed.
/// Returns the new relative path. Used for intra-mount drag.
pub fn move_entry(
    folder: &LocalSyncFolder,
    src_rel: &str,
    dst_dir_rel: &str,
) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let src_abs = resolve_safely(&root, src_rel)?;
    if !src_abs.exists() {
        return Err(format!("No such entry: {}", src_rel));
    }
    let is_dir = src_abs.is_dir();
    let file_name = src_abs
        .file_name()
        .ok_or_else(|| "No filename".to_string())?
        .to_string_lossy()
        .into_owned();
    let dst_dir_abs = resolve_dir_safely(&root, dst_dir_rel)?;
    if !dst_dir_abs.is_dir() {
        return Err("Destination is not a directory".to_string());
    }
    // Block moving a directory into itself or a descendant.
    if is_dir && dst_dir_abs.starts_with(&src_abs) {
        return Err("Cannot move a folder into itself".to_string());
    }
    let dest = dst_dir_abs.join(&file_name);
    // Same location — no-op.
    if dest == src_abs {
        return rel_of(&root, &src_abs, src_rel);
    }
    let final_dest = if is_dir { unique_dir_path(&dest) } else { unique_path(&dest) };
    fs::rename(&src_abs, &final_dest).map_err(|e| e.to_string())?;
    rel_of(&root, &final_dest, src_rel)
}

/// Duplicate a file (within the same directory), appending "-Copy" before
/// the extension and auto-suffixing further on collision. Directories are
/// copied recursively. Returns the new relative path.
pub fn copy_entry(folder: &LocalSyncFolder, rel_path: &str) -> Result<String, String> {
    let root = PathBuf::from(&folder.path);
    let abs = resolve_safely(&root, rel_path)?;
    if !abs.exists() {
        return Err(format!("No such entry: {}", rel_path));
    }
    let parent = abs.parent().ok_or_else(|| "No parent".to_string())?;
    let is_dir = abs.is_dir();
    let (stem, ext) = if is_dir {
        (abs.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), None)
    } else {
        (
            abs.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "copy".into()),
            abs.extension().map(|s| s.to_string_lossy().into_owned()),
        )
    };
    let base_name = match &ext {
        Some(e) => format!("{}-Copy.{}", stem, e),
        None => format!("{}-Copy", stem),
    };
    let dest = parent.join(&base_name);
    let final_dest = if is_dir { unique_dir_path(&dest) } else { unique_path(&dest) };
    if is_dir {
        copy_dir_recursive(&abs, &final_dest).map_err(|e| e.to_string())?;
    } else {
        fs::copy(&abs, &final_dest).map_err(|e| e.to_string())?;
    }
    rel_of(&root, &final_dest, rel_path)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

/// Compute the mount-relative path for `abs`, falling back to `fallback`
/// when the strip fails (e.g. the canonical root differs by symlink).
fn rel_of(root: &Path, abs: &Path, fallback: &str) -> Result<String, String> {
    let canon_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canon_abs = fs::canonicalize(abs).unwrap_or_else(|_| abs.to_path_buf());
    Ok(canon_abs
        .strip_prefix(&canon_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| fallback.to_string()))
}

/// Like `resolve_safely` but tailored to an existing directory target —
/// "" resolves to the mount root.
fn resolve_dir_safely(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() {
        return fs::canonicalize(root).map_err(|e| e.to_string());
    }
    resolve_safely(root, rel_path)
}

/// Directory-flavoured `unique_path`: appends " 2", " 3" (no extension
/// splitting) when a directory of that name already exists.
fn unique_dir_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("folder")
        .to_string();
    for i in 2..u32::MAX {
        let candidate = parent.join(format!("{} {}", name, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Append " (2)", " (3)", ... before the extension if `path` already
/// exists. Mirrors `ImageManager::unique_filename` so collision
/// suffixing is consistent across image storage backends.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    for i in 2..u32::MAX {
        let name = match &ext {
            Some(e) => format!("{} {}.{}", stem, i, e),
            None => format!("{} {}", stem, i),
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Resolve `rel_path` against `root`, canonicalising both and rejecting
/// anything that escapes the mount (via `..` or symlinks). Returns the
/// canonicalised absolute path.
fn resolve_safely(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    let normalized = rel_path.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let candidate = root.join(trimmed);
    // `canonicalize` requires the target to exist; fall back to the
    // parent for write paths and re-join afterwards.
    let canon_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canon = match fs::canonicalize(&candidate) {
        Ok(p) => p,
        Err(_) => {
            // Path doesn't exist yet (new file). Canonicalise the parent
            // and append the filename — still blocks `..` escapes.
            let parent = candidate
                .parent()
                .ok_or_else(|| "Path has no parent".to_string())?;
            let canon_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
            canon_parent.join(
                candidate
                    .file_name()
                    .ok_or_else(|| "Path has no filename".to_string())?,
            )
        }
    };
    if !canon.starts_with(&canon_root) {
        return Err("Path escapes the local-sync root".to_string());
    }
    Ok(canon)
}
