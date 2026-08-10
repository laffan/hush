//! The `index.json` ↔ `tree.json` contract for a desk folder.
//!
//! Two sidecars name the same files from different directions: the tree
//! says where a fileId sits in the sidebar, the index says which file on
//! disk it *is*. Both are whole-file writes, both sync independently, and
//! either can arrive stale. This module holds the two repairs that keeps
//! them agreeing without either one ever inferring a deletion:
//!
//! - **merging an index write** instead of replacing, so a device can't
//!   erase the ids the other one published while we weren't looking;
//! - **restoring a lost row**, so an entry that survives the merge with
//!   no tree node to its name gets one back under the id already
//!   published — rather than waiting to be re-minted under a new one.
//!
//! They are two halves of one rule: an id, once published for a path, is
//! the answer for that path. Everything downstream — versions, panes,
//! recents, and every write the *far* device aims at that id — depends on
//! it not moving.

use crate::desk_paths::collect_expected;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// (desk root path, deskId) → the placement this device last committed:
/// the fileId → relPath map that its `tree.json` and `index.json` agreed
/// on when they were last written together. The merge base for
/// `adopt_far_moves`. Process-wide, mirroring `TREE_SEEN` — and, like it,
/// deliberately not persisted: a fresh process has just *loaded* the
/// tree from disk, so it isn't stale and has nothing to rebase.
static PLACEMENT_BASE: OnceLock<Mutex<HashMap<(String, String), HashMap<String, String>>>> =
    OnceLock::new();

fn base_key(root: &Path, desk_id: &str) -> (String, String) {
    (root.to_string_lossy().into_owned(), desk_id.to_string())
}

fn placement_base() -> &'static Mutex<HashMap<(String, String), HashMap<String, String>>> {
    PLACEMENT_BASE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where a file sits, ignoring how its name is spelled: directory chain
/// plus stem. The tree computes `X.md` for a doc the folder holds as
/// `X.txt` (adopted extensions), and dedupe can add a ` (2)` — neither is
/// a *move*, and comparing raw paths would read both as one.
fn placement_key(rel: &str) -> String {
    let path = Path::new(rel);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(rel);
    let dir = crate::desk_scan::dir_segments(path).join("/");
    if dir.is_empty() { stem.to_string() } else { format!("{}/{}", dir, stem) }
}

/// Record the placement our in-memory tree currently has.
pub(crate) fn note_placement(root: &Path, desk_id: &str, placement: &HashMap<String, String>) {
    let keyed = placement.iter().map(|(id, rel)| (id.clone(), placement_key(rel))).collect();
    placement_base().lock().unwrap().insert(base_key(root, desk_id), keyed);
}

/// The same, from a desk node — used wherever a tree is *read*, because
/// loading one is never a user move. Without this, a tree that arrives
/// from the far device and gets loaded here reads on the next save as
/// "we moved these files", and the save asserts it: the far device's
/// deletions bounce back out of the Trash a beat after landing.
pub(crate) fn note_tree_placement(root: &Path, desk: &TreeNode) {
    let mut files = HashMap::new();
    collect_expected(&desk.children, &mut Vec::new(), &mut files, &mut HashSet::new());
    note_placement(root, &desk.id, &files);
}

/// Which vanished index entry an added file is, if any — the rename /
/// move pairing. The filesystem offers no identity but the path, so a
/// provider-level move arrives as one entry disappearing and one file
/// appearing, and pairing them is what keeps a fileId (and with it the
/// version history, panes and recents) across the move.
///
/// Two passes, and they cover different halves. **Bytes**: an added file
/// hashing to a vanished entry's cached hash is that file, wherever it
/// went and whatever it's now called. **Name**: a file the far device
/// moved *while both machines were writing into it* arrives with bytes we
/// never cached, so the hash pass sees nothing — but its filename didn't
/// change, because a move doesn't change one. That case (a move to Trash
/// after an edit, which is simply what trashing a file you were working
/// on looks like) minted a fresh id for a file that already had one and
/// left the old row haunting its folder for the whole grace window:
/// `added: 3, pending: 3` in a log where nothing had been created.
///
/// The passes are complementary — a rename changes the name and keeps the
/// bytes; a move keeps the name and may change the bytes.
pub(crate) fn pair_vanished(
    rel: &str,
    node_type: &str,
    disk_hash: Option<&str>,
    missing: &[(String, String)],
    paired: &HashSet<String>,
    hashes: &HashMap<String, crate::desk_hashes::HashEntry>,
) -> Option<(String, String)> {
    let candidates = || {
        missing.iter().filter(|(id, old_rel)| {
            !paired.contains(id)
                && crate::desk_scan::kind_for_rel(old_rel).as_deref() == Some(node_type)
        })
    };
    if let Some(hash) = disk_hash {
        let hit = candidates()
            .find(|(id, _)| hashes.get(id).map(|e| e.hash == hash).unwrap_or(false));
        if let Some(hit) = hit {
            return Some(hit.clone());
        }
    }
    let filename = Path::new(rel).file_name()?.to_str()?;
    candidates()
        .find(|(_, old)| Path::new(old).file_name().and_then(|s| s.to_str()) == Some(filename))
        .cloned()
}

/// Move a row to wherever its file actually is.
///
/// The mirror of `rebase_placement`, and its necessary other half. That
/// rule stops a save dragging the far device's file back out of the
/// Trash — but it leaves the index saying `Trash/X.md` while our tree
/// still hangs the row in `Inbox`, and nothing else in the reconcile
/// closes that gap: the path is claimed, so the file never reads as new,
/// and the rename pairing (which used to do this job, by way of the
/// index still being stale) no longer fires. The row then stays visibly
/// in the wrong place, *and* our `tree.json` publishes that to the far
/// device — which reloads it and undoes its own move.
///
/// The index is where the file is. The tree follows it.
pub(crate) fn relocate_rows(
    root: &Path,
    desk: &mut TreeNode,
    index: &HashMap<String, String>,
) -> usize {
    let mut current = HashMap::new();
    collect_expected(&desk.children, &mut Vec::new(), &mut current, &mut HashSet::new());

    let mut moves: Vec<(&String, &String)> = index
        .iter()
        .filter(|(id, rel)| {
            current.get(*id).map(|now| placement_key(now) != placement_key(rel)).unwrap_or(false)
        })
        .collect();
    moves.sort_by(|a, b| a.1.cmp(b.1));

    let mut moved = 0;
    for (id, rel) in moves {
        // Absent is not deleted, and it isn't relocated either — the
        // removal pass and its grace window own that call.
        if !root.join(rel).exists() {
            continue;
        }
        let Some((_, name, segments)) = node_shape(rel) else { continue };
        let old_rel = current.get(id).cloned().unwrap_or_default();
        crate::desk_tree_ops::rename_or_move_node(desk, id, &name, &old_rel, &segments);
        moved += 1;
    }
    moved
}

/// Take the far device's moves for files **we** didn't move.
///
/// `save_forest` computes every file's path from the tree and then makes
/// the disk match — it *asserts* the tree. That is a data move, and it is
/// wrong whenever our tree is older than the folder. Trashing showed it
/// plainly: two devices moved their own probes to `Trash/` seconds apart,
/// each tree still placing the *other's* files at the root, and the next
/// tree save on either device renamed the far device's three files back
/// out of the Trash. Both machines then agreed — on the wrong answer.
///
/// The reconciler resolves the same disagreement the other way (a file
/// found at a new path drags its row along, `ScanReport::renamed`), so
/// the two halves of the store were asserting opposite things. This makes
/// the save agree with the reconcile.
///
/// Three paths per file: where we last committed it (`base`), where our
/// tree wants it now (`expected`), and where the folder says it is
/// (`published`). Only `base != expected` means *we* moved it — and only
/// then may the file move. Otherwise the far device did, and we adopt.
/// With no base recorded (first save of the process) the tree was just
/// loaded from disk and is trusted, which is the behaviour this replaces.
///
/// The new base is what our tree *says* — recorded before the adoption,
/// not after. A tree the frontend hasn't reloaded yet would otherwise read
/// as a fresh move on the very next save and tug the file back out again.
///
/// Returns the paths adopted, for the log.
pub(crate) fn rebase_placement(
    root: &Path,
    desk_id: &str,
    expected: &mut HashMap<String, String>,
    published: &HashMap<String, String>,
) -> Vec<String> {
    let keyed = expected.iter().map(|(id, rel)| (id.clone(), placement_key(rel))).collect();
    let mut guard = placement_base().lock().unwrap();
    let base = guard.insert(base_key(root, desk_id), keyed);
    let Some(base) = base else { return Vec::new() };
    let mut adopted = Vec::new();
    for (id, rel) in expected.iter_mut() {
        if base.get(id) != Some(&placement_key(rel)) {
            continue; // we moved this one — our move stands
        }
        let Some(theirs) = published.get(id) else { continue };
        if theirs == rel || !root.join(theirs).exists() {
            continue;
        }
        adopted.push(format!("{} → {}", rel, theirs));
        *rel = theirs.clone();
    }
    adopted
}

/// Fold the index the folder currently publishes into the one we're
/// about to write, keeping any entry we don't claim whose file is
/// really there.
///
/// Both installs write this file whole, so a plain replace erases
/// whatever the other one published between our read and our write. When
/// that included the ids for files *we* created, our own rows stopped
/// resolving — they were then re-keyed to the far device's ids, and
/// every write still aimed at the old id fell through to per-device
/// staging, where it synced to nobody. (Both machines reporting
/// `rekeyed: 6` for six files is what that looks like from the log.)
///
/// An entry we don't claim, for a file that really exists, is knowledge
/// the far device has and we don't. Keeping it is the same rule as
/// everywhere else here: never infer deletion. The file-exists condition
/// is what stops the merge resurrecting anything genuinely gone — a
/// deleted file's path has no file at it, and a *moved* file keeps its
/// id, so its old entry is replaced rather than kept. An entry naming a
/// path we already claim under another id is dropped for the same
/// reason: two ids for one file is the state this whole module exists to
/// avoid, and ours is the one the tree we're writing agrees with.
pub(crate) fn merge_published(
    ours: &HashMap<String, String>,
    published: &HashMap<String, String>,
    exists: impl Fn(&str) -> bool,
) -> HashMap<String, String> {
    let mut merged = ours.clone();
    let claimed: HashSet<&str> = ours.values().map(String::as_str).collect();
    for (id, rel) in published {
        if merged.contains_key(id) || claimed.contains(rel.as_str()) {
            continue;
        }
        if exists(rel) {
            merged.insert(id.clone(), rel.clone());
        }
    }
    merged
}

/// The tree row a desk-relative path wants: its kind, its display name,
/// and the container chain it hangs under. `None` for anything Hush
/// doesn't recognise as a file.
///
/// An image's name *is* its filename — the extension is part of its
/// identity (its fileId is the filename too). Everything else drops the
/// extension, which Hush re-derives from the kind on the way back out.
pub(crate) fn node_shape(rel: &str) -> Option<(String, String, Vec<String>)> {
    let node_type = crate::desk_scan::kind_for_rel(rel)?;
    let path = Path::new(rel);
    let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or(rel).to_string();
    let name = if node_type == "image" {
        filename.clone()
    } else {
        path.file_stem().and_then(|s| s.to_str()).unwrap_or(&filename).to_string()
    };
    Some((node_type, name, crate::desk_scan::dir_segments(path)))
}

/// Give a tree row back to every indexed file that lost one.
///
/// A file can end up indexed and rowless from either side: a tree save
/// written off a stale sidebar drops the rows while the merge above
/// (rightly) keeps the entries, and a `tree.json` arriving from the far
/// device can predate the rows it will eventually name. Either way the
/// additions pass can't help — the path is already claimed by an index
/// entry, so it isn't "new" — and the file stays invisible in the
/// sidebar until something re-mints an id for it, which is precisely the
/// identity break the merge was added to prevent.
///
/// So: re-hang the row under the id the index already publishes, along
/// the same container chain an addition would take. A placeholder counts
/// as present (the provider is telling us the file exists and simply
/// isn't local yet); anything genuinely absent is left to the removal
/// pass and its grace window.
///
/// Returns how many rows were restored.
pub(crate) fn restore_missing_rows(
    root: &Path,
    desk: &mut TreeNode,
    index: &HashMap<String, String>,
    placeholders: &HashSet<String>,
) -> usize {
    let mut rowed = HashMap::new();
    collect_expected(&desk.children, &mut Vec::new(), &mut rowed, &mut HashSet::new());

    // Sorted so a multi-file restore lands in a stable order rather than
    // whatever the hash map felt like — the tree is written to a synced
    // folder and gratuitous reordering is a change the far device sees.
    let mut rowless: Vec<(&String, &String)> =
        index.iter().filter(|(id, _)| !rowed.contains_key(*id)).collect();
    rowless.sort_by(|a, b| a.1.cmp(b.1));

    let mut restored = 0;
    for (id, rel) in rowless {
        if !root.join(rel).exists() && !placeholders.contains(rel.as_str()) {
            continue;
        }
        let Some((node_type, name, segments)) = node_shape(rel) else { continue };
        let container = crate::desk_scan::ensure_container_chain(desk, &segments);
        container.push(crate::desk_scan::new_node(&node_type, &name, Some(id)));
        restored += 1;
    }
    restored
}
