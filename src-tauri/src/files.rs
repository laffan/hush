use crate::atomic::write_atomic_str;
use crate::{FileEntry, TreeNode};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct FileManager {
    files_dir: PathBuf,
}

impl FileManager {
    pub fn new(files_dir: PathBuf) -> Self {
        fs::create_dir_all(&files_dir).ok();
        Self { files_dir }
    }

    // ===== File Tree =====

    fn tree_path(&self) -> PathBuf {
        self.files_dir.parent().unwrap_or(&self.files_dir).join("file_tree.json")
    }

    pub fn get_file_tree(&self) -> Result<Vec<TreeNode>, Box<dyn std::error::Error>> {
        let path = self.tree_path();
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let tree: Vec<TreeNode> = serde_json::from_str(&content)?;
            Ok(tree)
        } else {
            // Migrate: build tree from existing flat files
            let files = self.list_files()?;
            let tree: Vec<TreeNode> = files
                .iter()
                .map(|f| TreeNode {
                    id: Uuid::new_v4().to_string(),
                    name: f.name.clone(),
                    node_type: "document".to_string(),
                    file_id: Some(f.id.clone()),
                    children: Vec::new(),
                    flagged: false,
                    sync_folder_id: None,
                    locked_style_id: None,
                    use_as_note: false,
                    zotero_att_key: None,
                })
                .collect();
            self.save_file_tree(&tree)?;
            Ok(tree)
        }
    }

    pub fn save_file_tree(&self, tree: &[TreeNode]) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.tree_path();
        let content = serde_json::to_string_pretty(tree)?;
        write_atomic_str(&path, &content)?;
        Ok(())
    }

    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<TreeNode, Box<dyn std::error::Error>> {
        let node = TreeNode {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            node_type: "folder".to_string(),
            file_id: None,
            children: Vec::new(),
            flagged: false,
            sync_folder_id: None,
            locked_style_id: None,
            use_as_note: false,
            zotero_att_key: None,
        };
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
        let node = TreeNode {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            node_type: "project".to_string(),
            file_id: None,
            children: Vec::new(),
            flagged: false,
            sync_folder_id: None,
            locked_style_id: None,
            use_as_note: false,
            zotero_att_key: None,
        };
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
        // Create a backing file for the notebook (stores shapes JSON)
        let file = self.create_file()?;
        // Save initial empty notebook content
        self.save_file(&file.id, "[]")?;

        let node = TreeNode {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            node_type: "notebook".to_string(),
            file_id: Some(file.id.clone()),
            children: Vec::new(),
            flagged: false,
            sync_folder_id: None,
            locked_style_id: None,
            use_as_note: false,
            zotero_att_key: None,
        };
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

        let node = TreeNode {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            node_type: "stack".to_string(),
            file_id: Some(file.id.clone()),
            children: Vec::new(),
            flagged: false,
            sync_folder_id: None,
            locked_style_id: None,
            use_as_note: false,
            zotero_att_key: None,
        };
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

    // ===== Individual Files (unchanged) =====

    pub fn create_file(&self) -> Result<FileEntry, Box<dyn std::error::Error>> {
        let id = Uuid::new_v4().to_string();
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let entry = FileEntry {
            id: id.clone(),
            name: "Untitled".to_string(),
            content: String::new(),
            modified: now,
        };
        let path = self.files_dir.join(format!("{}.json", id));
        write_atomic_str(&path, &serde_json::to_string(&entry)?)?;
        Ok(entry)
    }

    pub fn save_file(&self, id: &str, content: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.files_dir.join(format!("{}.json", id));
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        // Preserve existing name once set. Auto-derive only while the file
        // is still "Untitled" so the initial save gives it a sensible name
        // but subsequent edits don't rename (and churn sync paths).
        let existing_name = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<FileEntry>(&s).ok())
            .map(|e| e.name);
        // Notebook payloads are JSON envelopes; deriving a name from them
        // produces garbage like `{"format":"hushnote"...`. Notebooks are
        // identified by the tree-node name, so leaving "Untitled" on the
        // FileEntry is harmless (callers fall back to the tree node).
        let name = match existing_name {
            Some(n) if n != "Untitled" => n,
            _ if looks_like_notebook_content(content) => "Untitled".to_string(),
            _ => derive_name(content),
        };
        let entry = FileEntry {
            id: id.to_string(),
            name,
            content: content.to_string(),
            modified: now,
        };
        write_atomic_str(&path, &serde_json::to_string(&entry)?)?;
        Ok(())
    }

    pub fn load_file(&self, id: &str) -> Result<FileEntry, Box<dyn std::error::Error>> {
        let path = self.files_dir.join(format!("{}.json", id));
        let content = fs::read_to_string(&path)?;
        let entry: FileEntry = serde_json::from_str(&content)?;
        Ok(entry)
    }

    pub fn list_files(&self) -> Result<Vec<FileEntry>, Box<dyn std::error::Error>> {
        let mut entries = Vec::new();
        if let Ok(read_dir) = fs::read_dir(&self.files_dir) {
            for entry in read_dir.flatten() {
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(file_entry) = serde_json::from_str::<FileEntry>(&content) {
                            entries.push(file_entry);
                        }
                    }
                }
            }
        }
        entries.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(entries)
    }

    pub fn delete_file(&self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.files_dir.join(format!("{}.json", id));
        fs::remove_file(&path)?;
        Ok(())
    }

    pub fn rename_file(&self, id: &str, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.files_dir.join(format!("{}.json", id));
        let content = fs::read_to_string(&path)?;
        let mut entry: FileEntry = serde_json::from_str(&content)?;
        entry.name = name.to_string();
        write_atomic_str(&path, &serde_json::to_string(&entry)?)?;
        Ok(())
    }

    /// Wipe every doc/notebook payload (`*.json` files in `files_dir`)
    /// plus the persisted `file_tree.json`. The on-disk `images/`
    /// subdirectory is left to `ImageManager::clear_all`. Used by the
    /// "Clear local versions" recovery in Settings → Sync.
    pub fn clear_all(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Ok(read_dir) = fs::read_dir(&self.files_dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path.extension().and_then(|e| e.to_str()) == Some("json")
                {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        let tree_path = self.tree_path();
        if tree_path.exists() {
            let _ = fs::remove_file(&tree_path);
        }
        Ok(())
    }
}

// ===== Tree helpers =====

fn insert_into_tree(tree: &mut Vec<TreeNode>, parent_id: Option<&str>, node: TreeNode) {
    match parent_id {
        None => insert_before_trash(tree, node),
        Some(pid) => {
            if !insert_into_children(tree, pid, node.clone()) {
                insert_before_trash(tree, node);
            }
        }
    }
}

/// Insert at root level but before the Images and Trash nodes so the
/// special tail (Images, Trash) stays in its reserved position.
fn insert_before_trash(tree: &mut Vec<TreeNode>, node: TreeNode) {
    // Prefer inserting before Images (which sits above Trash); fall back
    // to Trash for trees that haven't had Images created yet.
    if let Some(idx) = tree.iter().position(|n| n.id == "__images__") {
        tree.insert(idx, node);
        return;
    }
    if let Some(idx) = tree.iter().position(|n| n.id == "__trash__") {
        tree.insert(idx, node);
    } else {
        tree.push(node);
    }
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

fn derive_name(content: &str) -> String {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "Untitled".to_string();
    }
    let first_line = trimmed.lines().next().unwrap_or("Untitled");
    let clean = first_line.trim_start_matches('#').trim();
    if clean.len() <= 20 {
        clean.to_string()
    } else {
        format!("{}...", &clean[..20])
    }
}

fn looks_like_notebook_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    // Current envelope form (encodeNotebookContent in notebook-content.ts).
    if trimmed.starts_with("{\"format\":\"hushnote\"") {
        return true;
    }
    // Stack envelope — same principle: names derived from JSON are garbage.
    if trimmed.starts_with("{\"format\":\"hushstack\"") {
        return true;
    }
    // Legacy bare Shape[] form: empty notebook is "[]"; a populated one
    // begins with "[{". decodeNotebookContent still accepts both.
    trimmed == "[]" || trimmed.starts_with("[{")
}

