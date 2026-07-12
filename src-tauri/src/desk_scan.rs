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
//! - an index entry whose file vanished ⇒ node + entry dropped (the
//!   file's snapshots in `.hush/versions/` remain the recovery path);
//! - everything else is left exactly as the tree says.
//!
//! A provider-level *rename* arrives as remove + add, which today mints
//! a fresh fileId (history stays under the old id). Content-hash rename
//! pairing is the Phase 4 refinement.

use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use uuid::Uuid;

type BoxError = Box<dyn std::error::Error>;

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub added: usize,
    pub removed: usize,
}

impl ScanReport {
    pub fn changed(&self) -> bool {
        self.added > 0 || self.removed > 0
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

        // ----- Removals: index entries whose file is gone -----
        let missing: Vec<String> = index
            .iter()
            .filter(|(_, rel)| !root.join(rel).exists())
            .map(|(id, _)| id.clone())
            .collect();
        for id in &missing {
            index.remove(id);
            if remove_node_by_file_id(&mut desk.children, id) {
                report.removed += 1;
            }
        }

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
            // Images are addressed by filename; everything else gets a
            // fresh uuid.
            let file_id = if node_type == "image" {
                filename.clone()
            } else {
                Uuid::new_v4().to_string()
            };
            let name = if node_type == "image" {
                filename.clone()
            } else {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename)
                    .to_string()
            };
            let segments: Vec<String> = path
                .parent()
                .map(|d| {
                    d.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            let container = ensure_container_chain(&mut desk, &segments);
            container.push(new_node(&node_type, &name, Some(&file_id)));
            index.insert(file_id, rel);
            report.added += 1;
        }

        if report.changed() {
            self.save_index(desk_id, &index)?;
            crate::atomic::write_atomic_str(
                &self.tree_path(desk_id),
                &serde_json::to_string_pretty(&desk)?,
            )?;
        }
        Ok(report)
    }
}

/// Recognised files under `dir` as desk-relative paths. Hidden entries
/// and the `.hush` sidecar are skipped.
fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
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
/// desk's specials — match by name; missing segments become plain
/// folders.
fn ensure_container_chain<'a>(desk: &'a mut TreeNode, segments: &[String]) -> &'a mut Vec<TreeNode> {
    let mut current: &mut Vec<TreeNode> = &mut desk.children;
    for seg in segments {
        let pos = current.iter().position(|n| {
            (n.node_type == "folder" || n.node_type == "project") && n.name == *seg
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
    }
}
