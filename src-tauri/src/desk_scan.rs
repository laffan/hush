//! Disk-wins reconciliation for desk folders.
//!
//! A local desk's folder can be mutated by anything — Finder, another
//! app, another Hush install on the far side of iCloud/Dropbox/Syncthing.
//! `reconcile_desk_from_disk` makes the tree follow the folder:
//!
//! - a recognised file on disk with no index entry ⇒ a new tree node,
//!   inserted along a container chain mirroring its directory path
//!   (matching existing folders/projects/specials by name, creating
//!   plain folders for the rest);
//! - an index entry whose file vanished ⇒ node + entry dropped, but
//!   **only once the absence has persisted** — see below (the file's
//!   snapshots in `.hush/versions/` remain the recovery path);
//! - everything else is left exactly as the tree says.
//!
//! **Absent is not deleted.** Inside a provider-synced folder, "not in
//! the directory listing" routinely means *not delivered yet*: a desk
//! adopted on a second device before iCloud has propagated its files,
//! or an iOS install where an evicted file is only a `.Name.icloud`
//! placeholder dotfile. Treating that as deletion — and writing the
//! shrunken `tree.json`/`index.json` back into the synced folder — is
//! how a freshly-filled desk could open empty on the next device and
//! propagate the amnesia back to the first. Two guards close it:
//!
//! - a **placeholder** (`.Name.icloud` beside where `Name` belongs) is
//!   "present, just not local": the entry is never dropped, and the
//!   logical path is reported in `ScanReport::pending_downloads` so the
//!   frontend can ask the provider to materialise it (iOS routes these
//!   through the icloud-folder plugin's coordinated reads);
//! - any other absence starts a **grace clock** (`MISSING_SINCE`,
//!   process-wide): the entry is dropped only when a later scan — at
//!   least `REMOVAL_GRACE_SECS` after the first miss — still can't see
//!   the file. A single scan can never remove anything, so the
//!   post-adopt reconcile is additions-only by construction. The ledger
//!   is in-memory on purpose: a restart merely restarts the clock,
//!   which errs toward keeping files.
//!
//! A provider-level *rename* also arrives as remove + add — the
//! filesystem offers no identity but the path. The reconciler pairs a
//! vanished index entry with an added file of identical content hash
//! and kind (via the `.hush/hashes.json` cache — see `desk_hashes`) and
//! treats the pair as a rename: same fileId, so version history, panes,
//! and recents survive. Images are excluded (their fileId *is* the
//! filename); an unpairable vanish/add falls back to remove + add.
//! Pairing consults every absent entry regardless of its grace clock,
//! so a rename never has to wait out the window.

use crate::desk_hashes::{fnv1a_hex, mtime_ms, HashEntry};
use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type BoxError = Box<dyn std::error::Error>;

/// How long an index entry's file must stay missing before the
/// reconciler treats the absence as a real deletion. Long enough for a
/// provider to finish propagating a freshly-created desk; short enough
/// that a genuine Finder delete still clears out within a session. A
/// ghost row is the cost of guessing wrong in one direction; lost work
/// is the cost in the other.
pub(crate) const REMOVAL_GRACE_SECS: u64 = 10 * 60;

/// (desk root path, fileId) → epoch secs the file was first seen
/// missing. Keyed by root path rather than desk id so parallel stores
/// over different data dirs (tests) can't cross-talk.
static MISSING_SINCE: OnceLock<Mutex<HashMap<(String, String), u64>>> = OnceLock::new();

fn missing_ledger() -> &'static Mutex<HashMap<(String, String), u64>> {
    MISSING_SINCE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Backdate a file's first-missing stamp so tests can cross the grace
/// window without sleeping.
#[cfg(test)]
pub(crate) fn backdate_missing_for_tests(root: &Path, file_id: &str, secs: u64) {
    let key = (root.to_string_lossy().into_owned(), file_id.to_string());
    let mut ledger = missing_ledger().lock().unwrap();
    if let Some(t) = ledger.get_mut(&key) {
        *t = t.saturating_sub(secs);
    }
}

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub added: usize,
    pub removed: usize,
    pub renamed: usize,
    pub conflicts: usize,
    /// Index entries whose file is absent but deliberately *kept*: an
    /// iCloud placeholder stands in for it, or the absence hasn't
    /// outlasted the removal grace window yet.
    pub pending: usize,
    /// Logical absolute paths of every `.icloud` placeholder seen
    /// (indexed or not) — the frontend asks the provider to download
    /// these on iOS, where nothing else ever would.
    pub pending_downloads: Vec<String>,
}

impl ScanReport {
    /// Whether the tree/index changed (conflict adoption rewrites file
    /// *content* but leaves structure alone, so it isn't counted here).
    pub fn changed(&self) -> bool {
        self.added > 0 || self.removed > 0 || self.renamed > 0
    }
}

impl DeskStore {
    /// Make `desk_id`'s tree + index follow its folder. Returns what
    /// changed so callers can skip UI refreshes on no-ops.
    pub fn reconcile_desk_from_disk(&self, desk_id: &str) -> Result<ScanReport, BoxError> {
        let mut desk = self
            .load_desk_tree(desk_id)
            .ok_or_else(|| format!("no tree for desk {}", desk_id))?;
        let mut index = self.load_index(desk_id);
        let root = self.desk_dir(desk_id);
        let mut report = ScanReport::default();

        // Fold provider conflict siblings back into their mapped files
        // first, so they never surface as new files below.
        report.conflicts = self.adopt_conflicted_copies(desk_id, &index);

        // Every `.icloud` placeholder in the folder, as the logical
        // path it stands for. Indexed ones are held out of the vanish
        // scan below; all of them are surfaced so the frontend can ask
        // the provider to download the real bytes.
        let mut placeholder_rels = Vec::new();
        walk_placeholders(&root, &root, &mut placeholder_rels);
        let placeholders: HashSet<String> = placeholder_rels.iter().cloned().collect();
        report.pending_downloads = placeholder_rels
            .iter()
            .map(|rel| root.join(rel).to_string_lossy().into_owned())
            .collect();

        let mut hashes = self.load_hashes(desk_id);
        let mut hashes_dirty = false;

        // ----- Pass 0: refresh the hash cache for files still present
        // whose mtime moved since the hash was taken (external edits,
        // adopted desks with no cache yet).
        for (id, rel) in &index {
            if kind_for_rel(rel).as_deref() == Some("image") {
                continue;
            }
            let abs = root.join(rel);
            if !abs.exists() {
                continue;
            }
            let mtime = mtime_ms(&abs);
            if hashes.get(id).map(|e| e.mtime == mtime).unwrap_or(false) {
                continue;
            }
            if let Ok(bytes) = fs::read(&abs) {
                hashes.insert(id.clone(), HashEntry { hash: fnv1a_hex(&bytes), mtime });
                hashes_dirty = true;
            }
        }

        // ----- Vanished: index entries whose file is gone. Held back
        // from removal until additions had a chance to pair with them —
        // and, past that, until the absence outlasts the grace window.
        // A placeholder-backed entry is not vanished at all: the
        // provider is telling us the file exists and simply isn't local.
        let root_key = root.to_string_lossy().into_owned();
        let now = now_secs();
        let mut missing: Vec<(String, String)> = Vec::new();
        {
            let mut ledger = missing_ledger().lock().unwrap();
            for (id, rel) in &index {
                if root.join(rel).exists() {
                    ledger.remove(&(root_key.clone(), id.clone()));
                } else if placeholders.contains(rel) {
                    ledger.remove(&(root_key.clone(), id.clone()));
                    report.pending += 1;
                } else {
                    missing.push((id.clone(), rel.clone()));
                }
            }
        }
        let mut paired: HashSet<String> = HashSet::new();

        // ----- Additions: recognised files with no index entry -----
        let known: HashSet<String> = index.values().cloned().collect();
        let mut on_disk = Vec::new();
        walk_files(&root, &root, &mut on_disk);
        for rel in on_disk {
            if known.contains(&rel) {
                continue;
            }
            let Some(node_type) = kind_for_rel(&rel) else { continue };
            let path = Path::new(&rel);
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&rel)
                .to_string();
            let name = if node_type == "image" {
                filename.clone()
            } else {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename)
                    .to_string()
            };
            let segments = dir_segments(path);

            // Rename pairing: an added file whose bytes hash to a
            // vanished entry's cached hash (same kind) is that file,
            // renamed or relocated outside Hush. Keep its fileId.
            if node_type != "image" {
                let disk_hash = fs::read(root.join(&rel)).ok().map(|b| fnv1a_hex(&b));
                let hit = disk_hash.as_ref().and_then(|h| {
                    missing
                        .iter()
                        .find(|(id, old_rel)| {
                            !paired.contains(id)
                                && kind_for_rel(old_rel) == Some(node_type.clone())
                                && hashes.get(id).map(|e| &e.hash == h).unwrap_or(false)
                        })
                        .cloned()
                });
                if let Some((old_id, old_rel)) = hit {
                    rename_or_move_node(&mut desk, &old_id, &name, &old_rel, &segments);
                    index.insert(old_id.clone(), rel.clone());
                    hashes.insert(
                        old_id.clone(),
                        HashEntry {
                            hash: disk_hash.unwrap(),
                            mtime: mtime_ms(&root.join(&rel)),
                        },
                    );
                    hashes_dirty = true;
                    paired.insert(old_id);
                    report.renamed += 1;
                    continue;
                }
                // Genuinely new — remember its hash for future pairing.
                if let Some(h) = disk_hash {
                    let file_id = Uuid::new_v4().to_string();
                    hashes.insert(
                        file_id.clone(),
                        HashEntry { hash: h, mtime: mtime_ms(&root.join(&rel)) },
                    );
                    hashes_dirty = true;
                    let container = ensure_container_chain(&mut desk, &segments);
                    container.push(new_node(&node_type, &name, Some(&file_id)));
                    index.insert(file_id, rel);
                    report.added += 1;
                    continue;
                }
            }
            // Images (addressed by filename) and unreadable files.
            let file_id = if node_type == "image" {
                filename.clone()
            } else {
                Uuid::new_v4().to_string()
            };
            let container = ensure_container_chain(&mut desk, &segments);
            container.push(new_node(&node_type, &name, Some(&file_id)));
            index.insert(file_id, rel);
            report.added += 1;
        }

        // ----- Removals: vanished entries nothing paired with — and
        // only once a *later* scan finds the absence has persisted for
        // the whole grace window. The first scan to miss a file can
        // never remove it, which is what makes the post-adopt reconcile
        // safe against a folder the provider hasn't fully delivered.
        let mut to_remove: Vec<String> = Vec::new();
        {
            let mut ledger = missing_ledger().lock().unwrap();
            for (id, _) in &missing {
                let key = (root_key.clone(), id.clone());
                if paired.contains(id) {
                    ledger.remove(&key); // renamed — not missing after all
                    continue;
                }
                let first = *ledger.entry(key.clone()).or_insert(now);
                if now.saturating_sub(first) >= REMOVAL_GRACE_SECS {
                    ledger.remove(&key);
                    to_remove.push(id.clone());
                } else {
                    report.pending += 1;
                }
            }
        }
        for id in &to_remove {
            index.remove(id);
            if hashes.remove(id).is_some() {
                hashes_dirty = true;
            }
            if remove_node_by_file_id(&mut desk.children, id) {
                report.removed += 1;
            }
        }

        if report.changed() {
            self.save_index(desk_id, &index)?;
            crate::atomic::write_atomic_str(
                &self.tree_path(desk_id),
                &serde_json::to_string_pretty(&desk)?,
            )?;
        }
        if hashes_dirty {
            let _ = self.save_hashes(desk_id, &hashes);
        }
        Ok(report)
    }
}

/// The directory chain of a desk-relative path, as name segments.
fn dir_segments(path: &Path) -> Vec<String> {
    path.parent()
        .map(|d| {
            d.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Apply an external rename/relocation to the tree node carrying
/// `file_id`: rename in place when the directory didn't change (keeps
/// sibling ordering), otherwise lift the node — decoration, children and
/// all — into the container chain for its new directory.
fn rename_or_move_node(
    desk: &mut TreeNode,
    file_id: &str,
    new_name: &str,
    old_rel: &str,
    new_segments: &[String],
) {
    let old_segments = dir_segments(Path::new(old_rel));
    if old_segments == new_segments {
        if let Some(node) = find_node_by_file_id(&mut desk.children, file_id) {
            node.name = new_name.to_string();
            return;
        }
    }
    if let Some(mut node) = take_node_by_file_id(&mut desk.children, file_id) {
        node.name = new_name.to_string();
        ensure_container_chain(desk, new_segments).push(node);
    }
}

fn find_node_by_file_id<'a>(
    nodes: &'a mut Vec<TreeNode>,
    file_id: &str,
) -> Option<&'a mut TreeNode> {
    for node in nodes.iter_mut() {
        if node.file_id.as_deref() == Some(file_id) {
            return Some(node);
        }
        if let Some(found) = find_node_by_file_id(&mut node.children, file_id) {
            return Some(found);
        }
    }
    None
}

fn take_node_by_file_id(nodes: &mut Vec<TreeNode>, file_id: &str) -> Option<TreeNode> {
    for i in 0..nodes.len() {
        if nodes[i].file_id.as_deref() == Some(file_id) {
            return Some(nodes.remove(i));
        }
        if let Some(taken) = take_node_by_file_id(&mut nodes[i].children, file_id) {
            return Some(taken);
        }
    }
    None
}

/// Recognised files under `dir` as desk-relative paths. Hidden entries
/// and the `.hush` sidecar are skipped.
pub(crate) fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // .hush, .hushdesk, .DS_Store, dotfiles
        }
        if path.is_dir() {
            walk_files(root, &path, out);
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Logical desk-relative paths of every iCloud placeholder under `dir`.
/// A file iCloud knows about but hasn't delivered locally is a plist
/// dotfile named `.<Name>.icloud` beside where `<Name>` belongs — the
/// normal on-disk state for evicted/undownloaded files on iOS, where
/// plain `std::fs` never triggers a download. `walk_files` skips them
/// as dotfiles, so this walk is how the reconciler learns the file
/// exists at all. Dot-directories (`.hush`) are skipped, and a
/// placeholder whose logical name is itself a dotfile is ignored.
pub(crate) fn walk_placeholders(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !name.starts_with('.') {
                walk_placeholders(root, &path, out);
            }
            continue;
        }
        let Some(stem) = name.strip_prefix('.').and_then(|s| s.strip_suffix(".icloud")) else {
            continue;
        };
        if stem.is_empty() || stem.starts_with('.') {
            continue;
        }
        if let Ok(rel_dir) = dir.strip_prefix(root) {
            let rel = if rel_dir.as_os_str().is_empty() {
                stem.to_string()
            } else {
                format!("{}/{}", rel_dir.to_string_lossy().replace('\\', "/"), stem)
            };
            out.push(rel);
        }
    }
}

fn kind_for_rel(rel: &str) -> Option<String> {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match ext.as_str() {
        "md" | "markdown" | "txt" => "document",
        "hushnote" => "notebook",
        "hushstack" => "stack",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "heic" | "heif" | "avif"
        | "tif" | "tiff" => "image",
        _ => return None,
    };
    Some(kind.to_string())
}

/// Resolve (creating as needed) the children Vec for a directory chain
/// under the desk. Existing containers — folders, projects, and the
/// desk's specials — match by name (exact first, then case-insensitive,
/// so a folder holding `inbox/` or `TRASH/` folds into the matching
/// special instead of forking an `inbox (2)` sibling on the next save —
/// macOS filesystems treat those as the same directory anyway); missing
/// segments become plain folders.
pub(crate) fn ensure_container_chain<'a>(
    desk: &'a mut TreeNode,
    segments: &[String],
) -> &'a mut Vec<TreeNode> {
    let mut current: &mut Vec<TreeNode> = &mut desk.children;
    for seg in segments {
        let is_container = |n: &TreeNode| n.node_type == "folder" || n.node_type == "project";
        let pos = current
            .iter()
            .position(|n| is_container(n) && n.name == *seg)
            .or_else(|| {
                current
                    .iter()
                    .position(|n| is_container(n) && n.name.eq_ignore_ascii_case(seg))
            });
        let idx = match pos {
            Some(i) => i,
            None => {
                current.push(new_node("folder", seg, None));
                current.len() - 1
            }
        };
        current = &mut current[idx].children;
    }
    current
}

/// Absorb a folder's existing files into a fresh desk node + index —
/// the initialise-in-place half of `open_folder_as_desk`. Same mapping
/// the reconciler applies (directories mirror as containers, an
/// existing `Inbox/` folds into the seeded special) but built *before*
/// any sidecar exists, so the desk's first `tree.json` already carries
/// the folder's contents and there is no empty-skeleton window for a
/// concurrent tree save to mistake for a desk with no files.
pub(crate) fn absorb_disk_files(
    root: &Path,
    desk: &mut TreeNode,
    index: &mut std::collections::HashMap<String, String>,
) {
    let mut on_disk = Vec::new();
    walk_files(root, root, &mut on_disk);
    for rel in on_disk {
        let Some(node_type) = kind_for_rel(&rel) else { continue };
        let path = Path::new(&rel);
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel)
            .to_string();
        let name = if node_type == "image" {
            filename.clone()
        } else {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&filename)
                .to_string()
        };
        let file_id = if node_type == "image" {
            filename
        } else {
            Uuid::new_v4().to_string()
        };
        let segments = dir_segments(path);
        let container = ensure_container_chain(desk, &segments);
        container.push(new_node(&node_type, &name, Some(&file_id)));
        index.insert(file_id, rel);
    }
}

fn remove_node_by_file_id(nodes: &mut Vec<TreeNode>, file_id: &str) -> bool {
    for i in 0..nodes.len() {
        if nodes[i].file_id.as_deref() == Some(file_id) {
            nodes.remove(i);
            return true;
        }
        if remove_node_by_file_id(&mut nodes[i].children, file_id) {
            return true;
        }
    }
    false
}

fn new_node(node_type: &str, name: &str, file_id: Option<&str>) -> TreeNode {
    TreeNode {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        node_type: node_type.to_string(),
        file_id: file_id.map(|s| s.to_string()),
        children: Vec::new(),
        flagged: false,
        sync_folder_id: None,
        locked_style_id: None,
        use_as_note: false,
        zotero_att_key: None,
        bg_color: None,
        show_numbers: false,
        gutter: false,
        ..Default::default()
    }
}
