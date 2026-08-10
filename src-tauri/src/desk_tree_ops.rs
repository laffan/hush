//! Tree surgery the reconciler needs: find, take, rename, remove a node
//! by its fileId. Pure `TreeNode` manipulation with no policy in it —
//! split out of `desk_scan.rs` for the line cap, and because "how do I
//! move a node" reads better away from "when should I".

use crate::desk_scan::dir_segments;
use crate::TreeNode;
use std::path::Path;

/// Apply an external rename/relocation to the tree node carrying
/// `file_id`: rename in place when the directory didn't change (keeps
/// sibling ordering), otherwise lift the node — decoration, children and
/// all — into the container chain for its new directory.
pub(crate) fn rename_or_move_node(
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
        crate::desk_scan::ensure_container_chain(desk, new_segments).push(node);
    }
}

pub(crate) fn find_node_by_file_id<'a>(
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

pub(crate) fn take_node_by_file_id(nodes: &mut Vec<TreeNode>, file_id: &str) -> Option<TreeNode> {
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

pub(crate) fn remove_node_by_file_id(nodes: &mut Vec<TreeNode>, file_id: &str) -> bool {
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

