//! FileManager — the app-facing storage API, now backed by the
//! desk-folder store (`desk_store.rs`). The command surface is unchanged
//! from the flat-store era (`load_file` / `save_file` / tree ops keyed by
//! fileId), so the frontend is agnostic to the layout underneath: ids
//! resolve to real paths through each desk's `.hush/index.json`, and
//! every tree save reconciles the folder to match the tree.

use crate::desk_store::DeskStore;
use crate::{FileEntry, TreeNode};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct FileManager {
    store: DeskStore,
}

impl FileManager {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            store: DeskStore::new(data_dir),
        }
    }

    // ===== File Tree =====

    pub fn get_file_tree(&self) -> Result<Vec<TreeNode>, Box<dyn std::error::Error>> {
        self.store.load_forest()
    }

    /// Returns `Some(repaired)` when the store's cross-desk repair
    /// rewrote the forest before persisting — the frontend adopts it so
    /// it doesn't keep re-saving the unrepaired shape.
    pub fn save_file_tree(
        &self,
        tree: &[TreeNode],
    ) -> Result<Option<Vec<TreeNode>>, Box<dyn std::error::Error>> {
        self.store.save_forest(tree)
    }

    /// Disk-wins reconcile for one desk, run through this manager so the
    /// caller holds the same mutex `save_file_tree` / `get_file_tree`
    /// serialize on. The reconciler and a forest save both rewrite
    /// per-desk `tree.json`; unsynchronized (the old command built its
    /// own `DeskStore`), a reconcile could load a desk's tree, have
    /// `save_forest` rewrite it, then write its stale copy back —
    /// resurrecting nodes the save had just moved to another desk.
    pub fn reconcile_desk(
        &self,
        desk_id: &str,
    ) -> Result<crate::desk_scan::ScanReport, Box<dyn std::error::Error>> {
        self.store.reconcile_desk_from_disk(desk_id)
    }

    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<TreeNode, Box<dyn std::error::Error>> {
        let node = new_node("folder", name, None);
        let mut tree = self.get_file_tree()?;
        insert_into_tree(&mut tree, parent_id, node.clone());
        self.save_file_tree(&tree)?;
        Ok(node)
    }

    pub fn create_project(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<TreeNode, Box<dyn std::error::Error>> {
        let node = new_node("project", name, None);
        let mut tree = self.get_file_tree()?;
        insert_into_tree(&mut tree, parent_id, node.clone());
        self.save_file_tree(&tree)?;
        Ok(node)
    }

    pub fn create_notebook(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<(TreeNode, FileEntry), Box<dyn std::error::Error>> {
        let file = self.create_file()?;
        self.save_file(&file.id, "[]")?;
        let node = new_node("notebook", name, Some(&file.id));
        let mut tree = self.get_file_tree()?;
        insert_into_tree(&mut tree, parent_id, node.clone());
        self.save_file_tree(&tree)?;
        Ok((node, file))
    }

    pub fn create_stack(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<(TreeNode, FileEntry), Box<dyn std::error::Error>> {
        let file = self.create_file()?;
        let initial = r#"{"format":"hushstack","version":1,"items":[],"scrollX":0}"#;
        self.save_file(&file.id, initial)?;
        let node = new_node("stack", name, Some(&file.id));
        let mut tree = self.get_file_tree()?;
        insert_into_tree(&mut tree, parent_id, node.clone());
        self.save_file_tree(&tree)?;
        Ok((node, file))
    }

    pub fn load_project_content(
        &self,
        project_id: &str,
    ) -> Result<Vec<FileEntry>, Box<dyn std::error::Error>> {
        let tree = self.get_file_tree()?;
        let project = find_node(&tree, project_id)
            .ok_or_else(|| format!("Project not found: {}", project_id))?;
        let mut entries = Vec::new();
        collect_document_files(&project.children, &mut entries);
        let mut result = Vec::new();
        for file_id in entries {
            match self.load_file(&file_id) {
                Ok(entry) => result.push(entry),
                Err(e) => {
                    eprintln!("load_project_content: skipping file {}: {}", file_id, e);
                    continue;
                }
            }
        }
        Ok(result)
    }

    // ===== Individual files (fileId-addressed) =====

    /// Mint a new file id in the staging area. It gets a real path the
    /// moment a tree save places its node (see DeskStore::save_forest).
    pub fn create_file(&self) -> Result<FileEntry, Box<dyn std::error::Error>> {
        let id = Uuid::new_v4().to_string();
        self.store.stage_new(&id)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        Ok(FileEntry {
            id,
            name: "Untitled".to_string(),
            content: String::new(),
            modified: now,
        })
    }

    /// See `DeskStore::availability` — a stat, safe to ask before a
    /// heavyweight open.
    pub fn availability(&self, id: &str) -> (&'static str, Option<String>) {
        self.store.availability(id)
    }

    /// See `DeskStore::mtimes` — stats, no reads.
    pub fn mtimes(&self, ids: &[String]) -> std::collections::HashMap<String, u64> {
        self.store.mtimes(ids)
    }

    pub fn save_file(&self, id: &str, content: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.store.write_by_id(id, content)
    }

    pub fn load_file(&self, id: &str) -> Result<FileEntry, Box<dyn std::error::Error>> {
        let (content, modified, name) = self.store.read_by_id(id)?;
        Ok(FileEntry {
            id: id.to_string(),
            name,
            content,
            modified,
        })
    }

    pub fn list_files(&self) -> Result<Vec<FileEntry>, Box<dyn std::error::Error>> {
        let (indexed, staged) = self.store.list_ids();
        let mut entries = Vec::new();
        for (id, desk_id, rel) in indexed {
            // Read straight from the (desk, rel) list_ids already
            // resolved. Calling load_file(&id) here would re-`locate`
            // each id, re-parsing every desk index once per file —
            // O(N²) over the library.
            if let Ok((content, modified, name)) = self.store.read_at(&desk_id, &rel) {
                entries.push(FileEntry { id, name, content, modified });
            }
        }
        for id in staged {
            if let Ok(entry) = self.load_file(&id) {
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(entries)
    }

    pub fn delete_file(&self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.store.delete_by_id(id)
    }

    pub fn rename_file(&self, id: &str, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.store.rename_by_id(id, name)
    }
}

// ===== Tree helpers =====

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

fn insert_into_tree(tree: &mut Vec<TreeNode>, parent_id: Option<&str>, node: TreeNode) {
    if let Some(pid) = parent_id {
        if insert_into_children(tree, pid, node.clone()) {
            return;
        }
    }
    // No (or unknown) parent: land in the first desk's children, above its
    // pinned Images/Trash tail so the entry stays visible.
    if let Some(desk) = tree.iter_mut().find(|n| n.node_type == "desk") {
        let idx = desk
            .children
            .iter()
            .position(|n| n.id.starts_with("__images__") || n.id.starts_with("__trash__"))
            .unwrap_or(desk.children.len());
        desk.children.insert(idx, node);
        return;
    }
    tree.push(node);
}

fn insert_into_children(nodes: &mut Vec<TreeNode>, parent_id: &str, node: TreeNode) -> bool {
    for n in nodes.iter_mut() {
        if n.id == parent_id {
            n.children.push(node);
            return true;
        }
        if insert_into_children(&mut n.children, parent_id, node.clone()) {
            return true;
        }
    }
    false
}

fn find_node<'a>(nodes: &'a [TreeNode], id: &str) -> Option<&'a TreeNode> {
    for n in nodes {
        if n.id == id {
            return Some(n);
        }
        if let Some(found) = find_node(&n.children, id) {
            return Some(found);
        }
    }
    None
}

fn collect_document_files(nodes: &[TreeNode], out: &mut Vec<String>) {
    for n in nodes {
        if n.node_type == "document" || n.node_type == "notebook" {
            if let Some(ref fid) = n.file_id {
                out.push(fid.clone());
            }
        }
        collect_document_files(&n.children, out);
    }
}
