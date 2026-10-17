//! FileManager — the app-facing storage API, now backed by the
//! desk-folder store (`desk_store.rs`). The command surface is unchanged
//! from the flat-store era (`load_file` / `save_file` / tree ops keyed by
//! fileId), so the frontend is agnostic to the layout underneath: ids
//! resolve to real paths through each desk's `.hush/index.json`, and
//! every tree save reconciles the folder to match the tree.

use crate::desk_store::DeskStore;
use crate::{FileEntry, FileSummary, TreeNode};
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
            hash: crate::desk_write::content_hash(""),
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

    /// `save_file` for an editor that knows which content it was based
    /// on — see `desk_write::write_checked`.
    pub fn save_file_checked(
        &self,
        id: &str,
        content: &str,
        base_hash: Option<&str>,
    ) -> Result<crate::desk_write::SaveReport, Box<dyn std::error::Error>> {
        self.store.write_checked(id, content, base_hash)
    }

    pub fn load_file(&self, id: &str) -> Result<FileEntry, Box<dyn std::error::Error>> {
        let (content, modified, name) = self.store.read_by_id(id)?;
        Ok(FileEntry {
            id: id.to_string(),
            name,
            hash: crate::desk_write::content_hash(&content),
            content,
            modified,
        })
    }

    /// The library listing: one row per file in every desk, with every
    /// document's body. See `listing`.
    pub fn list_files(&self) -> Result<Vec<FileSummary>, Box<dyn std::error::Error>> {
        self.listing(true)
    }

    /// The boot listing: the same rows, but documents arrive with
    /// `content: None` too — a `stat` each, not a read — except a doc
    /// still named Untitled, whose body the empty-Untitled sweep needs
    /// before the last file is restored. The frontend fills the rest in
    /// after the first surface is up (`read_document_bodies`).
    ///
    /// On an iPhone with a 19-document local desk in a synced folder,
    /// reading the bodies was 2.5 s of a 4.4 s launch, while finding the
    /// desk and parsing its index took 2 ms — the cost is the first read
    /// of each file's bytes, not the walk. See README-TECHNICAL, "Startup".
    pub fn list_files_for_boot(&self) -> Result<Vec<FileSummary>, Box<dyn std::error::Error>> {
        self.listing(false)
    }

    /// **Content is read for documents only** (and, with `bodies` off,
    /// for placeholder-named documents only). This runs on boot, and it
    /// used to read every file in the library byte for byte — inflating
    /// each `.hushnote` zip and base64-ing every image inside it back
    /// into a data URL, then shipping the lot across IPC. On an iPad with
    /// a couple of proofread notebooks that was seconds of black screen
    /// before anything could paint. Nothing in the frontend reads a
    /// notebook or a stack out of that cache; the surfaces that mount one
    /// call `load_file`. Those kinds get a `stat` instead, and images —
    /// which have always been dropped from this list, because
    /// `read_to_string` rejects their bytes — are never opened at all.
    ///
    /// See README-TECHNICAL, "Startup".
    fn listing(&self, bodies: bool) -> Result<Vec<FileSummary>, Box<dyn std::error::Error>> {
        static TRACE_IDS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
        static TRACE_SLOWEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
        let (indexed, staged) = crate::startup_trace::record_first(
            &TRACE_IDS,
            "list_files · find desks + parse their indexes",
            || self.store.list_ids(),
        );
        let count = indexed.len();
        let mut slowest: Option<(f64, String)> = None;
        let mut entries = Vec::new();
        for (id, desk_id, rel) in indexed {
            let started = std::time::Instant::now();
            // Read straight from the (desk, rel) list_ids already
            // resolved. Calling load_file(&id) here would re-`locate`
            // each id, re-parsing every desk index once per file —
            // O(N²) over the library.
            match crate::desk_scan::kind_for_rel(&rel).as_deref() {
                Some("image") => continue,
                Some("notebook") | Some("stack") => {
                    if let Some((modified, name)) = self.stat_at(&desk_id, &rel) {
                        entries.push(FileSummary { id, name, content: None, modified });
                    }
                }
                // Documents, and any extension the kind table doesn't
                // know — reading an unrecognised one is what this did
                // before, and the scanner doesn't index them anyway.
                _ if bodies || is_placeholder_rel(&rel) => {
                    if let Ok((content, modified, name)) = self.store.read_at(&desk_id, &rel) {
                        entries.push(FileSummary { id, name, content: Some(content), modified });
                    }
                }
                _ => {
                    if let Some((modified, name)) = self.stat_at(&desk_id, &rel) {
                        entries.push(FileSummary { id, name, content: None, modified });
                    }
                }
            }
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if slowest.as_ref().map_or(true, |(m, _)| ms > *m) {
                slowest = Some((ms, rel));
            }
        }
        if let Some((ms, rel)) = slowest {
            crate::startup_trace::note_first(
                &TRACE_SLOWEST,
                &format!("list_files · slowest of {} entries: {}", count, rel),
                ms,
            );
        }
        // Staged ids are freshly-created files that no tree save has
        // placed yet — always tiny, and always a doc in practice.
        for id in staged {
            if let Ok(entry) = self.load_file(&id) {
                entries.push(FileSummary {
                    id: entry.id,
                    name: entry.name,
                    content: Some(entry.content),
                    modified: entry.modified,
                });
            }
        }
        entries.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(entries)
    }

    /// mtime + display name without opening the file.
    ///
    /// `None` when the path isn't there — which is also how a file the
    /// provider hasn't delivered presents (iCloud parks the bytes under a
    /// `.name.icloud` sibling until it materialises them), so the row
    /// disappears in exactly the case the old read-and-drop did. A file
    /// that stats but can't be read now keeps its row rather than
    /// vanishing from the cache; the sidebar row came from the tree
    /// either way, and `state/open-file-wait.js` is what waits for bytes.
    fn stat_at(&self, desk_id: &str, rel: &str) -> Option<(u64, String)> {
        let abs = self.store.abs_path(desk_id, rel);
        let modified = std::fs::metadata(&abs)
            .and_then(|m| m.modified())
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs();
        let name = Path::new(rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        Some((modified, name))
    }

    pub fn delete_file(&self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.store.delete_by_id(id)
    }

    pub fn rename_file(&self, id: &str, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.store.rename_by_id(id, name)
    }
}

/// A document still carrying the placeholder name — the only kind the
/// boot listing reads, because the empty-Untitled sweep decides on its
/// body (`state/empty-untitled.js#isEmptyUntitled`: the name is
/// "Untitled" or empty).
fn is_placeholder_rel(rel: &str) -> bool {
    matches!(Path::new(rel).file_stem().and_then(|s| s.to_str()), None | Some("") | Some("Untitled"))
}

/// Every document's body, by fileId — the half of the listing the boot
/// call leaves out, read after the first surface is on screen.
///
/// Takes a store of its own rather than the `FileManager` behind the
/// mutex: on a synced folder this is the multi-second part, and holding
/// the lock for it would queue the user's first open or save behind it.
/// It only reads, and every write is tmp + rename, so a concurrent save
/// is seen whole or not at all; a file a concurrent tree save moved is
/// simply missing from the map, which leaves its row without a body
/// exactly as the boot listing had it.
pub fn read_document_bodies(store: &DeskStore) -> std::collections::HashMap<String, String> {
    let (indexed, _staged) = store.list_ids();
    let mut out = std::collections::HashMap::new();
    for (id, desk_id, rel) in indexed {
        if matches!(
            crate::desk_scan::kind_for_rel(&rel).as_deref(),
            Some("image") | Some("notebook") | Some("stack")
        ) {
            continue;
        }
        if let Ok((content, _, _)) = store.read_at(&desk_id, &rel) {
            out.insert(id, content);
        }
    }
    out
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
        proofread: false,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hushnote;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    fn tree_node(node_type: &str, name: &str, file_id: &str) -> TreeNode {
        new_node(node_type, name, Some(file_id))
    }

    fn desk(children: Vec<TreeNode>) -> TreeNode {
        let mut kids = vec![new_node("project", "Inbox", None)];
        kids[0].id = "__inbox__:d1".into();
        kids.extend(children);
        let mut d = new_node("desk", "Personal", None);
        d.id = "d1".into();
        d.children = kids;
        d
    }

    /// The boot listing must read documents and nothing else. A notebook
    /// row carries `content: None` (not an empty string — an empty body
    /// would read as a deletable placeholder downstream), an image never
    /// appears at all, and neither one's bytes are opened.
    #[test]
    fn listing_reads_documents_and_only_stats_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let fm = FileManager::new(dir.path());

        // A proofread-shaped notebook: an image big enough that
        // re-inlining it would be obvious in the payload.
        let png = B64.encode(vec![7u8; 4096]);
        let envelope = format!(
            r#"{{"format":"hushnote","version":1,"shapes":[{{"id":"i","type":"image","dataUrl":"data:image/png;base64,{png}"}}]}}"#
        );

        for (id, body) in [("f-doc", "# Hello\n\nbody"), ("f-nb", envelope.as_str())] {
            fm.store.stage_new(id).unwrap();
            fm.store.write_by_id(id, body).unwrap();
        }
        fm.store.stage_new("f-img").unwrap();
        fm.store.write_by_id("f-img", "not really a png").unwrap();

        let tree = vec![desk(vec![
            tree_node("document", "Hello", "f-doc"),
            tree_node("notebook", "Sketch", "f-nb"),
            tree_node("image", "shot.png", "f-img"),
        ])];
        fm.save_file_tree(&tree).unwrap();

        let listing = fm.list_files().unwrap();
        let by_id = |id: &str| listing.iter().find(|e| e.id == id);

        let doc = by_id("f-doc").expect("document missing from listing");
        assert_eq!(doc.name, "Hello");
        assert_eq!(doc.content.as_deref(), Some("# Hello\n\nbody"));

        let nb = by_id("f-nb").expect("notebook missing from listing");
        assert_eq!(nb.name, "Sketch");
        assert!(nb.content.is_none(), "notebook body was read into the listing");
        assert!(nb.modified > 0, "notebook row lost its mtime");

        assert!(by_id("f-img").is_none(), "image reached the listing");

        // And the notebook itself is still whole — the listing only
        // declined to read it.
        let full = fm.load_file("f-nb").unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&hushnote::read_data_json(&std::fs::read(
                dir.path().join("desks/d1/Sketch.hushnote"),
            ).unwrap()).unwrap()).unwrap();
        assert_eq!(back["shapes"][0]["dataUrl"], "images/img_1.png");
        assert!(full.content.contains("base64"), "load_file must still re-inline");
    }

    /// The boot listing leaves every document's body out — except a doc
    /// still called Untitled, which the empty-Untitled sweep has to judge
    /// before the last file is restored — and `read_document_bodies`
    /// hands back exactly the bodies it left out.
    #[test]
    fn boot_listing_defers_document_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let fm = FileManager::new(dir.path());
        for (id, body) in [
            ("f-doc", "# Hello\n\nbody"),
            ("f-untitled", ""),
            ("f-nb", r#"{"format":"hushnote","version":1,"shapes":[]}"#),
        ] {
            fm.store.stage_new(id).unwrap();
            fm.store.write_by_id(id, body).unwrap();
        }
        let tree = vec![desk(vec![
            tree_node("document", "Hello", "f-doc"),
            tree_node("document", "Untitled", "f-untitled"),
            tree_node("notebook", "Sketch", "f-nb"),
        ])];
        fm.save_file_tree(&tree).unwrap();

        let listing = fm.list_files_for_boot().unwrap();
        let by_id = |id: &str| listing.iter().find(|e| e.id == id).unwrap();
        let doc = by_id("f-doc");
        assert_eq!(doc.name, "Hello");
        assert!(doc.content.is_none(), "boot listing read a document body");
        assert!(doc.modified > 0, "document row lost its mtime");
        assert_eq!(by_id("f-untitled").content.as_deref(), Some(""), "the sweep needs Untitled's body");
        assert!(by_id("f-nb").content.is_none());

        let bodies = read_document_bodies(&fm.store);
        assert_eq!(bodies.get("f-doc").map(String::as_str), Some("# Hello\n\nbody"));
        assert_eq!(bodies.get("f-untitled").map(String::as_str), Some(""));
        assert!(!bodies.contains_key("f-nb"), "a notebook is not a document body");

        // The full listing is unchanged for every other caller.
        let full = fm.list_files().unwrap();
        let doc = full.iter().find(|e| e.id == "f-doc").unwrap();
        assert_eq!(doc.content.as_deref(), Some("# Hello\n\nbody"));
    }

    /// A stat, not a read — but still a stat. A notebook whose bytes
    /// aren't on the device drops out of the listing exactly as it did
    /// when the listing read it, because that is what the missing path
    /// looks like.
    #[test]
    fn a_notebook_with_no_bytes_on_disk_drops_out() {
        let dir = tempfile::tempdir().unwrap();
        let fm = FileManager::new(dir.path());
        fm.store.stage_new("f-nb").unwrap();
        fm.store.write_by_id("f-nb", r#"{"format":"hushnote","version":1,"shapes":[]}"#).unwrap();
        let tree = vec![desk(vec![tree_node("notebook", "Sketch", "f-nb")])];
        fm.save_file_tree(&tree).unwrap();

        assert!(fm.list_files().unwrap().iter().any(|e| e.id == "f-nb"));
        std::fs::remove_file(dir.path().join("desks/d1/Sketch.hushnote")).unwrap();
        // Gone entirely (not a placeholder) — no row.
        assert!(!fm.list_files().unwrap().iter().any(|e| e.id == "f-nb"));
    }
}
