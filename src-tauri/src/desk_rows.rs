//! One row per file inside a desk.
//!
//! `desk_dedupe` keeps a fileId from being claimed by two *desks*. This
//! is the same rule one level down: two rows for one fileId inside the
//! same desk. Nothing stopped that shape, and the reconciler produced it
//! in ordinary use — a file minted a fresh id because its index entry
//! hadn't arrived, then handed that row the far device's id once the
//! index did, beside the row that already carried it (see
//! `desk_scan::defer_to_published` and the re-key pass).
//!
//! It is worse than a cosmetic duplicate. `collect_expected` computes one
//! path per fileId and the last row walked wins, so the *file* follows
//! whichever row happens to sit later in the tree: trash the row that
//! looks like the stray copy and the only file goes to the Trash; rename
//! it and the real document is renamed; the first-line naming rule,
//! finding the other row by that name, suffixes it `(2)` and the two rows
//! start renaming one file back and forth. Every edit shows up "in both
//! copies", because there is one.
//!
//! So the extra rows go. They carry no bytes of their own — the file is
//! the same — and the row kept is the one that already describes where
//! the file is, so the repair never moves anything.

use crate::desk_paths::sanitize_segment;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Kinds whose fileId names a file this desk owns outright. Images are
/// addressed by filename and PDFs by a registry (project aliases share
/// the original's id on purpose), so neither is touched here.
fn owns_file(n: &TreeNode) -> bool {
    matches!(n.node_type.as_str(), "document" | "notebook" | "stack")
}

struct Row {
    node_id: String,
    file_id: String,
    /// Container names from the desk root down, sanitised the way paths
    /// are.
    chain: Vec<String>,
    name: String,
    in_trash: bool,
}

fn collect_rows(nodes: &[TreeNode], chain: &mut Vec<String>, trash: bool, out: &mut Vec<Row>) {
    for n in nodes {
        if owns_file(n) {
            if let Some(ref fid) = n.file_id {
                out.push(Row {
                    node_id: n.id.clone(),
                    file_id: fid.clone(),
                    chain: chain.clone(),
                    name: sanitize_segment(&n.name),
                    in_trash: trash,
                });
            }
        }
        if !n.children.is_empty() {
            let is_trash = n.id == "__trash__" || n.id.starts_with("__trash__:");
            chain.push(sanitize_segment(&n.name));
            collect_rows(&n.children, chain, trash || is_trash, out);
            chain.pop();
        }
    }
}

/// True when some fileId has more than one row in `desk` — the cheap
/// check that lets the common path skip cloning the tree.
pub(crate) fn has_duplicate_rows(desk: &TreeNode) -> bool {
    let mut rows = Vec::new();
    collect_rows(&desk.children, &mut Vec::new(), false, &mut rows);
    let mut seen = HashSet::new();
    rows.iter().any(|r| !seen.insert(r.file_id.as_str()))
}

/// Drop every extra row for a fileId, keeping the one that describes
/// where the file already is (`current`: fileId → desk-relative path),
/// else the first outside the Trash, else the first. Returns how many
/// rows were removed.
pub(crate) fn dedupe_rows_by_file_id(desk: &mut TreeNode, current: &HashMap<String, String>) -> usize {
    let mut rows = Vec::new();
    collect_rows(&desk.children, &mut Vec::new(), false, &mut rows);
    let mut by_file: HashMap<&str, Vec<&Row>> = HashMap::new();
    for r in &rows {
        by_file.entry(r.file_id.as_str()).or_default().push(r);
    }
    let mut doomed: HashSet<String> = HashSet::new();
    for (file_id, group) in by_file {
        if group.len() < 2 {
            continue;
        }
        let describes_file =
            |r: &Row| current.get(file_id).map(|rel| row_matches_path(r, rel)).unwrap_or(false);
        let keep = group
            .iter()
            .copied()
            .find(|r| describes_file(r))
            .or_else(|| group.iter().copied().find(|r| !r.in_trash))
            .unwrap_or(group[0]);
        for r in &group {
            if r.node_id != keep.node_id {
                doomed.insert(r.node_id.clone());
            }
        }
    }
    if doomed.is_empty() {
        return 0;
    }
    remove_nodes(&mut desk.children, &doomed)
}

/// Does this row's container chain + name spell `rel` (ignoring the
/// extension and any ` (n)` a collision added)?
fn row_matches_path(r: &Row, rel: &str) -> bool {
    let path = Path::new(rel);
    let dirs: Vec<String> = crate::desk_scan::dir_segments(path);
    if dirs != r.chain {
        return false;
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    stem == r.name
        || stem
            .strip_prefix(r.name.as_str())
            .and_then(|rest| rest.strip_prefix(" ("))
            .and_then(|rest| rest.strip_suffix(')'))
            .map(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or(false)
}

fn remove_nodes(nodes: &mut Vec<TreeNode>, doomed: &HashSet<String>) -> usize {
    let before = nodes.len();
    nodes.retain(|n| !doomed.contains(&n.id));
    let mut removed = before - nodes.len();
    for n in nodes.iter_mut() {
        removed += remove_nodes(&mut n.children, doomed);
    }
    removed
}

/// Whether the tree already has a row for `file_id`.
pub(crate) fn has_row(nodes: &[TreeNode], file_id: &str) -> bool {
    nodes
        .iter()
        .any(|n| (owns_file(n) && n.file_id.as_deref() == Some(file_id)) || has_row(&n.children, file_id))
}

/// Resolve index entries that name one file under two ids — the same
/// path, or two spellings of one file on a case-insensitive volume.
///
/// That is the state in which one document's autosave replaces another's
/// text, and the write path refuses it outright (`desk_write`), so it has
/// to heal somewhere: here. The id kept is the one a tree row places at
/// that path, else one with any row at all, else the first by id (so two
/// devices repairing the same folder pick the same one). The others lose
/// the entry, and their rows — which could only ever have shown this same
/// file — go too, or take the kept id when it has no row of its own.
/// Returns how many entries were dropped.
pub(crate) fn unshare_index_paths(
    root: &Path,
    desk: &mut TreeNode,
    index: &mut HashMap<String, String>,
) -> usize {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for (id, rel) in index.iter() {
        let key = match crate::desk_paths::file_key(&root.join(rel)) {
            Some((dev, ino)) => format!("{}:{}", dev, ino),
            None => format!("path:{}", rel),
        };
        groups.entry(key).or_default().push(id.clone());
    }
    let mut expected = HashMap::new();
    crate::desk_paths::collect_expected(&desk.children, &mut Vec::new(), &mut expected, &mut HashSet::new());
    let mut dropped = 0;
    for (_, mut ids) in groups {
        if ids.len() < 2 {
            continue;
        }
        ids.sort();
        let placed_here = |id: &String| expected.get(id).map(|e| e == &index[id]).unwrap_or(false);
        let keep = ids
            .iter()
            .find(|id| placed_here(id))
            .or_else(|| ids.iter().find(|id| has_row(&desk.children, id)))
            .unwrap_or(&ids[0])
            .clone();
        for id in ids.iter().filter(|id| **id != keep) {
            crate::activity_log::note(
                "desks",
                "warn",
                format!("{} and {} were indexed as the same file ({}) — keeping {}", keep, id, index[id], keep),
            );
            index.remove(id);
            if has_row(&desk.children, &keep) {
                while crate::desk_tree_ops::remove_node_by_file_id(&mut desk.children, id) {}
            } else if let Some(node) = crate::desk_tree_ops::find_node_by_file_id(&mut desk.children, id) {
                node.file_id = Some(keep.clone());
            }
            dropped += 1;
        }
    }
    dropped
}

/// The forest with every desk reduced to one row per fileId, or `None`
/// when no desk has a duplicate (the common case pays one walk).
/// `old_global` is where each file is now — the row describing that
/// place is the one kept, so nothing moves.
pub(crate) fn dedupe_forest_rows(
    tree: &[TreeNode],
    old_global: &HashMap<String, (String, String)>,
) -> Option<Vec<TreeNode>> {
    let dirty = tree.iter().any(|n| n.node_type == "desk" && has_duplicate_rows(n));
    if !dirty {
        return None;
    }
    let mut fixed = tree.to_vec();
    for desk in fixed.iter_mut().filter(|n| n.node_type == "desk") {
        let current: HashMap<String, String> = old_global
            .iter()
            .filter(|(_, (d, _))| d == &desk.id)
            .map(|(id, (_, rel))| (id.clone(), rel.clone()))
            .collect();
        let removed = dedupe_rows_by_file_id(desk, &current);
        if removed > 0 {
            crate::activity_log::note(
                "desks",
                "warn",
                format!(
                    "Dropped {} duplicate row(s) in desk {} — each named a file another row already shows",
                    removed, desk.id
                ),
            );
        }
    }
    Some(fixed)
}
