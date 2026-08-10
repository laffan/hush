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
