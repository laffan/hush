//! Cross-desk identity repair for the forest a window hands to
//! `save_forest`.
//!
//! Every file-backed node carries a `fileId`, and that id is the *only*
//! way content is addressed: `DeskStore::locate` walks the desks' indexes
//! and returns the first hit. The store therefore has one hard invariant —
//! **a fileId belongs to exactly one desk** — and nothing used to enforce
//! it.
//!
//! When a forest broke the invariant (the same subtree recorded under two
//! desks, which several boot-repair and multi-window seams could produce)
//! `save_forest` wrote it out verbatim and the damage compounded:
//!
//!   1. both desks' `index.json` claimed the id, at different paths;
//!   2. `place_file` moved the bytes to whichever desk it walked last,
//!      leaving the other desk's index pointing at a path with no file;
//!   3. `locate` returned whichever desk `read_dir` yielded first, so the
//!      file still opened — from both sidebars — and looked healthy;
//!   4. deleting either desk took the only copy of the bytes with it and
//!      left the *other* desk showing rows that could no longer open.
//!
//! `repair_forest` closes that off at the one choke point every write goes
//! through. It fixes two shapes:
//!
//! - **Contested files** — a fileId claimed by two desks is resolved to a
//!   single owner, preferring the desk that already holds the bytes so the
//!   repair never moves a file, and the loser's node is dropped.
//! - **Foreign specials** — an `__inbox__:<otherDesk>` (or Images /
//!   Archive / Trash) node sitting inside a desk it doesn't belong to is
//!   the "second Inbox" symptom. Whatever survived pruning inside it is
//!   lifted into this desk's own special of the same kind (or to the desk
//!   root when it has none) and the foreign shell is dropped.
//!
//! Returns `None` when the forest is already sound, so the common path
//! doesn't pay for a clone.

use crate::TreeNode;
use std::collections::{HashMap, HashSet};

const SPECIAL_KINDS: [&str; 5] = [
    "__inbox__",
    "__images__",
    "__pdfs__",
    "__archive__",
    "__trash__",
];

/// `("__inbox__", "abc123")` for `__inbox__:abc123`; `None` for anything
/// that isn't a per-desk special id.
fn parse_special(id: &str) -> Option<(&'static str, &str)> {
    for kind in SPECIAL_KINDS {
        if let Some(rest) = id.strip_prefix(kind) {
            if let Some(desk) = rest.strip_prefix(':') {
                return Some((kind, desk));
            }
        }
    }
    None
}

/// Repair a forest that records the same file — or another desk's
/// special — under more than one desk.
///
/// `old_global` is `DeskStore::global_index()` — fileId → (deskId,
/// relPath) as it stands on disk — used to pick the owner that keeps the
/// bytes where they already are.
pub fn repair_forest(
    tree: &[TreeNode],
    old_global: &HashMap<String, (String, String)>,
) -> Option<Vec<TreeNode>> {
    let owner = contested_owners(tree, old_global);
    let has_foreign_special = tree
        .iter()
        .filter(|n| n.node_type == "desk")
        .any(|d| d.children.iter().any(|c| is_foreign_special(&c.id, &d.id)));
    if owner.is_empty() && !has_foreign_special {
        return None;
    }

    let mut repaired: Vec<TreeNode> = tree.to_vec();
    for node in repaired.iter_mut() {
        if node.node_type != "desk" {
            continue;
        }
        let desk_id = node.id.clone();
        if !owner.is_empty() {
            prune_foreign(&mut node.children, &desk_id, &owner);
        }
        rehome_foreign_specials(node);
    }
    Some(repaired)
}

fn is_foreign_special(id: &str, desk_id: &str) -> bool {
    matches!(parse_special(id), Some((_, owner)) if owner != desk_id)
}

/// fileId → the desk that gets to keep it, for every id claimed twice.
/// Empty when the forest holds no contested ids.
fn contested_owners(
    tree: &[TreeNode],
    old_global: &HashMap<String, (String, String)>,
) -> HashMap<String, String> {
    let mut claims: Vec<(String, HashSet<String>)> = Vec::new();
    for node in tree.iter().filter(|n| n.node_type == "desk") {
        let mut ids = HashSet::new();
        collect_ids(&node.children, &mut ids);
        claims.push((node.id.clone(), ids));
    }
    let mut owner = HashMap::new();
    if claims.len() < 2 {
        return owner;
    }

    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (_, ids) in &claims {
        for id in ids {
            *counts.entry(id.as_str()).or_insert(0) += 1;
        }
    }
    let contested: Vec<&str> = counts
        .into_iter()
        .filter(|&(_, n)| n > 1)
        .map(|(id, _)| id)
        .collect();

    // Owner per contested id: the desk whose folder already holds the
    // bytes, else the first desk in forest order that claims it. Picking
    // the on-disk holder means the repair is pure bookkeeping — no file
    // moves, so nothing can go missing while it runs.
    for id in contested {
        let on_disk = old_global.get(id).map(|(desk, _)| desk.as_str());
        let pick = claims
            .iter()
            .find(|(desk_id, ids)| ids.contains(id) && Some(desk_id.as_str()) == on_disk)
            .or_else(|| claims.iter().find(|(_, ids)| ids.contains(id)));
        if let Some((desk_id, _)) = pick {
            owner.insert(id.to_string(), desk_id.clone());
        }
    }
    owner
}

/// Every fileId reachable under `nodes`. PDF nodes are skipped: their
/// binaries are a per-device cache keyed by the registry id and a project
/// alias legitimately shares one desk-wide id, so they were never part of
/// the per-desk index in the first place (see `collect_expected`).
fn collect_ids(nodes: &[TreeNode], out: &mut HashSet<String>) {
    for n in nodes {
        if matches!(
            n.node_type.as_str(),
            "document" | "notebook" | "stack" | "image"
        ) {
            if let Some(ref id) = n.file_id {
                out.insert(id.clone());
            }
        }
        collect_ids(&n.children, out);
    }
}

/// Drop nodes whose fileId is owned by another desk. A container goes with
/// them once pruning empties it *and* it held something before — so a
/// transplanted project doesn't leave a hollow folder behind, while a
/// container the user deliberately left empty stays.
fn prune_foreign(nodes: &mut Vec<TreeNode>, desk_id: &str, owner: &HashMap<String, String>) {
    nodes.retain_mut(|n| {
        let is_file = matches!(
            n.node_type.as_str(),
            "document" | "notebook" | "stack" | "image"
        );
        if is_file {
            if let Some(ref id) = n.file_id {
                if owner.get(id).map(|o| o != desk_id).unwrap_or(false) {
                    return false;
                }
            }
            return true;
        }
        if !matches!(n.node_type.as_str(), "folder" | "project") {
            return true;
        }
        // Specials are structural — never dropped for being empty.
        let structural = n.id.starts_with("__");
        let had_children = !n.children.is_empty();
        prune_foreign(&mut n.children, desk_id, owner);
        structural || !had_children || !n.children.is_empty()
    });
}

/// Lift the contents of another desk's special out of `desk` and into
/// `desk`'s own special of the same kind, then drop the foreign shell.
/// Content is never discarded: with no matching special to receive it the
/// children land at the desk root, where the sidebar still shows them.
fn rehome_foreign_specials(desk: &mut TreeNode) {
    let desk_id = desk.id.clone();
    let mut rescued: Vec<(&'static str, Vec<TreeNode>)> = Vec::new();
    desk.children.retain_mut(|c| match parse_special(&c.id) {
        Some((kind, owner)) if owner != desk_id => {
            rescued.push((kind, std::mem::take(&mut c.children)));
            false
        }
        _ => true,
    });
    for (kind, children) in rescued {
        if children.is_empty() {
            continue;
        }
        let own_id = format!("{}:{}", kind, desk_id);
        match desk.children.iter_mut().find(|n| n.id == own_id) {
            Some(target) => target.children.extend(children),
            None => desk.children.extend(children),
        }
    }
}

#[cfg(test)]
#[path = "desk_dedupe_tests.rs"]
mod tests;
