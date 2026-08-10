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
use crate::desk_identity::{note_tree_seen, tree_is_foreign};
use crate::desk_tree_ops::{
    find_node_by_file_id, remove_node_by_file_id, rename_or_move_node,
};
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
    /// Files on disk that the tree already had a row for, re-paired with
    /// that row's fileId instead of being minted as new — the sidecar
    /// hadn't arrived yet. Structure didn't change; the index did.
    pub matched: usize,
    /// Rows re-pointed at the fileId the folder's index publishes for
    /// their path, because the id they held resolves to nothing. That
    /// happens when both devices minted an id for the same arriving file
    /// and the far one's `index.json` landed last.
    pub rekeyed: usize,
    /// Ids this pass minted and then gave up, because the folder's index
    /// had gained the far device's id for the same path while we walked.
    pub deferred: usize,
    pub conflicts: usize,
    /// The desk's `tree.json` on disk is not the one this process last
    /// wrote or last read — i.e. the *far* device restructured the desk.
    /// Moving a file to Trash, renaming a folder, reordering: all of it
    /// lands in `tree.json` with nothing for the reconciler to do, so
    /// without this the change reaches disk and never reaches the UI.
    pub tree_changed: bool,
    /// Indexed files that had no tree row and were given one back under
    /// the id the index publishes — a stale tree save dropped the row, or
    /// a `tree.json` arrived that predates it. Not `added`: nothing about
    /// the folder is new, and the distinction is what tells the two apart
    /// in a log.
    pub restored: usize,
    /// Rows moved to where their file actually is, because the folder
    /// (or our own placement rebase) put it somewhere the tree doesn't
    /// say. This is how a far device's move to Trash reaches the sidebar.
    pub relocated: usize,
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
            || self.matched > 0 || self.rekeyed > 0 || self.deferred > 0
            || self.restored > 0 || self.relocated > 0
    }

    /// Whether the *tree* changed — what the frontend needs to reload
    /// for. A match only rewrites the index; a re-key rewrites the row's
    /// fileId, which the frontend very much needs to pick up.
    pub fn structural(&self) -> bool {
        self.added > 0 || self.removed > 0 || self.renamed > 0
            || self.rekeyed > 0 || self.deferred > 0 || self.restored > 0
            || self.relocated > 0
    }

    /// Whether the frontend should re-read the tree: either we changed
    /// it, or the far device did.
    pub fn needs_tree_reload(&self) -> bool {
        self.structural() || self.tree_changed
    }
}

impl DeskStore {
    /// Make `desk_id`'s tree + index follow its folder. Returns what
    /// changed so callers can skip UI refreshes on no-ops.
    pub fn reconcile_desk_from_disk(&self, desk_id: &str) -> Result<ScanReport, BoxError> {
        let (mut desk, raw_tree) = self
            .load_desk_tree_raw(desk_id)
            .ok_or_else(|| format!("no tree for desk {}", desk_id))?;
        // Strict: an index we can't read is not an empty one. Rebuilding
        // the desk from that reading re-mints a fileId for every file in
        // the folder and strands every node the tree already had.
        let mut index = self.try_load_index(desk_id)?;
        let root = self.desk_dir(desk_id);
        let mut report = ScanReport::default();
        // Did the far device restructure this desk while we weren't
        // looking? Nothing else in this pass can tell: the tree on disk
        // and the files on disk agree with each other, and it's *our*
        // copy that's stale.
        report.tree_changed = tree_is_foreign(&root, desk_id, &raw_tree);

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
        // Ids invented in this pass, with the path each was invented
        // for — re-checked against the folder's index before publishing.
        let mut minted: Vec<(String, String)> = Vec::new();

        // Paths the *tree* already claims for a fileId the index doesn't
        // place yet. A desk folder's sidecars sync as separate files, in
        // whatever order the provider likes, so a file routinely lands
        // before the `index.json` naming it — while `tree.json`, which
        // names it too, may well have arrived already. Minting a fresh
        // id on that reading orphans the id the *other* device is still
        // writing under, and its saves fall through to `.staging/<id>`,
        // a per-device file that never syncs: the file appears on both
        // machines and then silently stops carrying anything. The tree
        // is an identity record; consult it before inventing one.
        let mut expected = HashMap::new();
        {
            let mut dirs = HashSet::new();
            crate::desk_paths::collect_expected(
                &desk.children,
                &mut Vec::new(),
                &mut expected,
                &mut dirs,
            );
        }
        let mut tree_claims: HashMap<String, String> = HashMap::new();
        for (id, rel) in &expected {
            if !index.contains_key(id) {
                tree_claims.insert(rel.clone(), id.clone());
            }
        }

        // ----- Rows the far device's index orphaned. Both installs can
        // mint an id for the same arriving file — each sees the file
        // before the `index.json` naming it — and each then publishes a
        // whole index, so the second write erases the first's ids. That
        // device's rows are left pointing at ids nothing resolves:
        // "file not found" on every open until a restart re-reads the
        // shared tree. The index in the folder is the *published* answer
        // for a path, so a row whose id isn't in it, at a path the index
        // does claim, takes the published id. Always adopting rather
        // than asserting is what makes this converge instead of the two
        // installs swapping ids back and forth forever.
        let by_path: HashMap<&str, &str> =
            index.iter().map(|(id, rel)| (rel.as_str(), id.as_str())).collect();
        let rekeys: Vec<(String, String)> = expected
            .iter()
            .filter(|(id, _)| !index.contains_key(*id))
            .filter_map(|(id, rel)| {
                by_path.get(rel.as_str()).map(|published| (id.clone(), (*published).to_string()))
            })
            .collect();
        for (stale, published) in rekeys {
            if let Some(node) = find_node_by_file_id(&mut desk.children, &stale) {
                node.file_id = Some(published.clone());
                if let Some(entry) = hashes.remove(&stale) {
                    hashes.insert(published, entry);
                    hashes_dirty = true;
                }
                report.rekeyed += 1;
            }
        }

        // ----- Rows the tree lost while the index kept them. The
        // additions pass below can't recover these: the path is already
        // claimed, so the file doesn't read as new, and it stays out of
        // the sidebar until something re-mints an id for it — the exact
        // identity break the merged index write exists to prevent. Hang
        // the row back on the published id instead.
        report.restored =
            crate::desk_index::restore_missing_rows(&root, &mut desk, &index, &placeholders);

        // ----- Rows whose file has moved out from under them. The index
        // is where the file is; the tree follows. Without this the far
        // device's move lands on disk and in the index while our row —
        // and the `tree.json` we publish from it — still points at the
        // old place, which the far device then reloads and un-does.
        report.relocated = crate::desk_index::relocate_rows(&root, &mut desk, &index);

        // ----- Additions: recognised files with no index entry -----
        let known: HashSet<String> = index.values().cloned().collect();
        let mut on_disk = Vec::new();
        walk_files(&root, &root, &mut on_disk);
        for rel in on_disk {
            if known.contains(&rel) {
                continue;
            }
            // The tree's own claim on this path wins over minting.
            if let Some(id) = tree_claims.remove(&rel) {
                if kind_for_rel(&rel).as_deref() != Some("image") {
                    if let Ok(bytes) = fs::read(root.join(&rel)) {
                        hashes.insert(
                            id.clone(),
                            HashEntry {
                                hash: fnv1a_hex(&bytes),
                                mtime: mtime_ms(&root.join(&rel)),
                            },
                        );
                        hashes_dirty = true;
                    }
                }
                index.insert(id, rel);
                report.matched += 1;
                continue;
            }
            let Some((node_type, name, segments)) = crate::desk_index::node_shape(&rel) else {
                continue;
            };

            if node_type != "image" {
                let disk_hash = fs::read(root.join(&rel)).ok().map(|b| fnv1a_hex(&b));
                let hit = crate::desk_index::pair_vanished(
                    &rel,
                    &node_type,
                    disk_hash.as_deref(),
                    &missing,
                    &paired,
                    &hashes,
                );
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
                    minted.push((file_id.clone(), rel.clone()));
                    index.insert(file_id, rel);
                    report.added += 1;
                    continue;
                }
            }
            // Images (addressed by filename) and unreadable files.
            let file_id = if node_type == "image" {
                name.clone()
            } else {
                Uuid::new_v4().to_string()
            };
            let container = ensure_container_chain(&mut desk, &segments);
            container.push(new_node(&node_type, &name, Some(&file_id)));
            if node_type != "image" {
                minted.push((file_id.clone(), rel.clone()));
            }
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

        // ----- Before publishing anything we minted this pass, look at
        // the folder's index *again*. The far device may have published
        // its own id for one of these paths in the seconds we spent
        // walking the folder, and the id that was published first is the
        // one to keep — otherwise the two installs take turns
        // overwriting each other's answer and every row on the losing
        // side goes unresolvable. Cheap: one small read, only when this
        // pass actually minted something.
        if !minted.is_empty() {
            let published = self.try_load_index(desk_id).unwrap_or_default();
            report.deferred =
                defer_to_published(&minted, &published, &mut index, &mut desk, &mut hashes);
            if report.deferred > 0 {
                hashes_dirty = true;
            }
        }

        if report.changed() {
            // Merged, not replaced — the far device may have published
            // entries we've never seen while this pass was walking.
            self.save_index_merged(desk_id, &index)?;
        }
        // The tree is only rewritten when the *tree* changed. A re-paired
        // file leaves it byte-identical, and rewriting it anyway bumps
        // the mtime of a file sitting in a synced folder — which the far
        // device's watcher then reports as a change, for nothing.
        if report.structural() {
            let rewritten = serde_json::to_string_pretty(&desk)?;
            crate::atomic::write_atomic_str(&self.tree_path(desk_id), &rewritten)?;
            note_tree_seen(&root, desk_id, &rewritten);
        } else {
            // Nothing to write, but we've now *seen* this tree — so the
            // next pass compares against it rather than re-reporting the
            // same foreign change forever.
            note_tree_seen(&root, desk_id, &raw_tree);
        }
        if hashes_dirty {
            let _ = self.save_hashes(desk_id, &hashes);
        }
        Ok(report)
    }
}

/// Hand back ids this pass minted for paths the folder's index already
/// names, adopting the published id instead — in the index, on the tree
/// row, and in the hash cache. Returns how many were handed back.
///
/// Always *adopting* rather than asserting is the point: it's what makes
/// two installs that both minted for the same arriving file converge on
/// one answer, instead of taking turns overwriting each other's.
pub(crate) fn defer_to_published(
    minted: &[(String, String)],
    published: &HashMap<String, String>,
    index: &mut HashMap<String, String>,
    desk: &mut TreeNode,
    hashes: &mut HashMap<String, HashEntry>,
) -> usize {
    let by_path: HashMap<&str, &str> =
        published.iter().map(|(id, rel)| (rel.as_str(), id.as_str())).collect();
    let mut handed_back = 0;
    for (ours, rel) in minted {
        let Some(theirs) = by_path.get(rel.as_str()) else { continue };
        if *theirs == ours.as_str() {
            continue;
        }
        index.remove(ours);
        index.insert((*theirs).to_string(), rel.clone());
        if let Some(node) = find_node_by_file_id(&mut desk.children, ours) {
            node.file_id = Some((*theirs).to_string());
        }
        if let Some(entry) = hashes.remove(ours) {
            hashes.insert((*theirs).to_string(), entry);
        }
        handed_back += 1;
    }
    handed_back
}

/// The directory chain of a desk-relative path, as name segments.
pub(crate) fn dir_segments(path: &Path) -> Vec<String> {
    path.parent()
        .map(|d| {
            d.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
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

pub(crate) fn kind_for_rel(rel: &str) -> Option<String> {
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
        let Some((node_type, name, segments)) = crate::desk_index::node_shape(&rel) else {
            continue;
        };
        let file_id = if node_type == "image" {
            name.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        let container = ensure_container_chain(desk, &segments);
        container.push(new_node(&node_type, &name, Some(&file_id)));
        index.insert(file_id, rel);
    }
}

pub(crate) fn new_node(node_type: &str, name: &str, file_id: Option<&str>) -> TreeNode {
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
