//! Path computation for the desk-folder store: tree names → on-disk
//! relative paths. Split from `desk_store.rs` for the line cap.

use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Walk a desk's children computing each file-backed node's relative path
/// and the set of expected directories. Sibling filenames are deduped with
/// " (n)" so two same-named nodes of different types can't collide.
pub(crate) fn collect_expected(
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

pub(crate) fn dedupe(base: &str, ext: &str, used: &mut HashSet<String>) -> String {
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

