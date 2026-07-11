//! One-shot migration from the flat store (`{data_dir}/files/*.json` +
//! `file_tree.json`) into the desk-folder layout. Runs once at boot; the
//! old payload files are left in place as an inert backup and
//! `file_tree.json` is renamed so the migration can't run twice.

use crate::atomic::write_atomic_str;
use crate::desk_store::{collect_file_ids, DeskStore};
use crate::TreeNode;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

type BoxError = Box<dyn std::error::Error>;

/// Returns true when a migration ran.
pub fn migrate_from_flat(data_dir: &Path) -> Result<bool, BoxError> {
    let store = DeskStore::new(data_dir);
    let tree_path = data_dir.join("file_tree.json");
    if store.has_store() || !tree_path.exists() {
        return Ok(false);
    }

    let tree: Vec<TreeNode> = serde_json::from_str(&fs::read_to_string(&tree_path)?)?;

    // Stage every file-backed node's content so save_forest's placement
    // pass sources the real payloads rather than minting defaults.
    let files_dir = data_dir.join("files");
    let mut staged = 0usize;
    let mut old_entries: HashMap<String, String> = HashMap::new();
    if let Ok(rd) = fs::read_dir(&files_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else { continue };
            let Ok(parsed) = serde_json::from_str::<crate::FileEntry>(&raw) else { continue };
            old_entries.insert(parsed.id, parsed.content);
        }
    }
    let mut ids = Vec::new();
    collect_file_ids(&tree, &mut ids);
    for (id, node_type) in &ids {
        if node_type == "image" || node_type == "pdf" {
            continue;
        }
        if let Some(content) = old_entries.get(id) {
            let path = store.staging_path(id);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            write_atomic_str(&path, content)?;
            staged += 1;
        }
    }

    // Copy image binaries into each desk's Images/ ahead of the forest
    // save so placement adopts them at their expected paths.
    let legacy_images = files_dir.join("images");
    for desk in tree.iter().filter(|n| n.node_type == "desk") {
        let mut image_ids = Vec::new();
        collect_images(&desk.children, &mut image_ids);
        if image_ids.is_empty() {
            continue;
        }
        let target_dir = store.desk_dir(&desk.id).join("Images");
        fs::create_dir_all(&target_dir)?;
        for filename in image_ids {
            let src = legacy_images.join(&filename);
            let dst = target_dir.join(&filename);
            if src.exists() && !dst.exists() {
                let _ = fs::copy(&src, &dst);
            }
        }
    }

    store.save_forest(&tree)?;

    // Disarm: the flat tree is now the backup, not the source of truth.
    let backup = data_dir.join("file_tree.json.pre-desks.bak");
    fs::rename(&tree_path, &backup)?;
    eprintln!(
        "desk-store migration: {} desks, {} files staged",
        tree.iter().filter(|n| n.node_type == "desk").count(),
        staged
    );
    Ok(true)
}

fn collect_images(nodes: &[TreeNode], out: &mut Vec<String>) {
    for n in nodes {
        if n.node_type == "image" {
            if let Some(ref fid) = n.file_id {
                out.push(fid.clone());
            }
        }
        collect_images(&n.children, out);
    }
}

