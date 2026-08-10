//! Desk-folder storage — every desk is a self-contained directory.
//!
//! Layout (see LOCAL-DESKS-PLANNING.md):
//!
//! ```text
//! {data_dir}/desks/
//! ├── order.json                  desk ordering + transient stragglers
//! ├── .staging/<fileId>           files created before they have a tree position
//! └── <deskId>/
//!     ├── .hushdesk               desk identity { id, name, createdAt }
//!     ├── .hush/
//!     │   ├── index.json          fileId ↔ relative path
//!     │   ├── tree.json           the desk's TreeNode (structure + decoration)
//!     │   └── orphans/            files whose tree node vanished without a delete
//!     ├── Inbox/…  Trash/…  Images/…
//!     ├── <Project>/<Doc>.md
//!     ├── <Doc>.md  <Notebook>.hushnote  <Stack>.hushstack
//! ```
//!
//! The tree (`tree.json`) is authoritative for structure and ordering in
//! this phase; the content files mirror it. `reconcile` runs on every
//! tree save: it computes each fileId's expected path from the tree,
//! compares against the index, and moves/creates/adopts files so the
//! folder always matches. Filesystem-wins reconciliation (for shared /
//! local desk folders) layers on top of this in a later phase.
//!
//! PDFs are intentionally absent: their registry is metadata-only and
//! binaries stay a per-device cache (`files/pdfs/`).

use crate::atomic::{write_atomic, write_atomic_str};
use crate::desk_identity::{undelivered_or, OrderFile};
use crate::desk_paths::{collect_expected, sanitize_segment};
use crate::hushnote;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

pub struct DeskStore {
    pub desks_dir: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct IndexFile {
    #[serde(default)]
    files: HashMap<String, String>, // fileId -> relative path
}

impl DeskStore {
    pub fn new(data_dir: &Path) -> Self {
        let desks_dir = data_dir.join("desks");
        fs::create_dir_all(&desks_dir).ok();
        Self { desks_dir }
    }

    // ===== Paths =====

    pub(crate) fn desk_dir(&self, desk_id: &str) -> PathBuf {
        // Local desks resolve through roots.json — the single seam that
        // makes an external folder behave exactly like an internal desk.
        if let Some(root) = crate::desk_roots::root_for(&self.desks_dir, desk_id) {
            return root;
        }
        self.desks_dir.join(desk_id)
    }
    pub(crate) fn index_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("index.json")
    }
    pub(crate) fn tree_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("tree.json")
    }
    pub(crate) fn order_path(&self) -> PathBuf {
        self.desks_dir.join("order.json")
    }
    pub(crate) fn staging_path(&self, id: &str) -> PathBuf {
        self.desks_dir.join(".staging").join(id)
    }

    pub(crate) fn abs_path(&self, desk_id: &str, rel: &str) -> PathBuf {
        self.desk_dir(desk_id).join(rel)
    }

    // ===== Index IO =====

    pub(crate) fn load_index(&self, desk_id: &str) -> HashMap<String, String> {
        fs::read_to_string(self.index_path(desk_id))
            .ok()
            .and_then(|s| serde_json::from_str::<IndexFile>(&s).ok())
            .map(|f| f.files)
            .unwrap_or_default()
    }

    /// Like `load_index`, but tells "this desk has no index yet" apart
    /// from "the index is right there and we can't read it".
    ///
    /// The lenient read answers both with an empty map, and the
    /// disk-wins reconciler took that at face value: every file in the
    /// folder looked new (a fresh fileId minted for a file that already
    /// had one) while every node the tree already carried became
    /// untraceable, to be dropped once its grace window expired. Inside
    /// a provider-synced folder an unreadable sidecar is routine — a
    /// half-written file, or an iCloud placeholder standing in for one
    /// that hasn't downloaded — so the reconciler must stand down
    /// instead of rebuilding the desk from a reading it can't trust.
    pub(crate) fn try_load_index(&self, desk_id: &str) -> Result<HashMap<String, String>, BoxError> {
        let path = self.index_path(desk_id);
        match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<IndexFile>(&s)
                .map(|f| f.files)
                .map_err(|e| format!("desk {}: index.json is unreadable ({})", desk_id, e).into()),
            Err(_) if crate::desk_identity::awaiting_download(&path) => {
                Err(format!("desk {}: index.json hasn't downloaded yet", desk_id).into())
            }
            Err(e) if path.exists() => {
                Err(format!("desk {}: index.json could not be read ({})", desk_id, e).into())
            }
            Err(_) => Ok(HashMap::new()),
        }
    }

    /// Write a desk's index as a **merge** with what the folder publishes
    /// now — see `desk_index::merge_published` for why replacing it whole
    /// loses the far device's ids.
    pub(crate) fn save_index_merged(&self, desk_id: &str, ours: &HashMap<String, String>) -> Result<(), BoxError> {
        let published = self.try_load_index(desk_id).unwrap_or_default();
        let merged = crate::desk_index::merge_published(ours, &published, |rel| {
            self.abs_path(desk_id, rel).exists()
        });
        self.save_index(desk_id, &merged)
    }

    pub(crate) fn save_index(&self, desk_id: &str, files: &HashMap<String, String>) -> Result<(), BoxError> {
        let path = self.index_path(desk_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let payload = serde_json::json!({
            "format": "hush-index", "version": 1, "files": files,
        });
        write_atomic_str(&path, &serde_json::to_string_pretty(&payload)?)?;
        Ok(())
    }

    /// fileId -> (deskId, relPath) across every desk.
    pub fn global_index(&self) -> HashMap<String, (String, String)> {
        let mut out = HashMap::new();
        for desk_id in self.desk_ids_on_disk() {
            for (id, rel) in self.load_index(&desk_id) {
                out.insert(id, (desk_id.clone(), rel));
            }
        }
        out
    }

    /// Ids currently parked in staging (created, not yet placed in a tree).
    pub fn staged_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(self.desks_dir.join(".staging")) {
            for entry in rd.flatten() {
                if entry.path().is_file() {
                    out.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        out
    }

    // ===== Forest (tree of desks) =====

    pub fn has_store(&self) -> bool {
        self.order_path().exists()
    }

    // `load_forest` / `load_desk_tree` / `desk_ids_on_disk` /
    // `append_to_order` live in desk_identity.rs — the load is where a
    // desk's registered id and the id its folder carries have to be
    // reconciled, and that repair belongs beside the rules it enforces.

    /// Persist the full forest: per-desk tree.json + .hushdesk + path
    /// reconciliation, order.json with stragglers, and retirement of desk
    /// folders whose desk node vanished (moved to `.deleted/`, never wiped).
    ///
    /// Returns `Some(repaired)` when the cross-desk repair rewrote the
    /// forest before writing — the caller should adopt it as its live
    /// tree. A window that kept its unrepaired copy re-saved the broken
    /// shape on its next write, flapping the on-disk forest between the
    /// two states indefinitely.
    pub fn save_forest(&self, tree: &[TreeNode]) -> Result<Option<Vec<TreeNode>>, BoxError> {
        let old_global = self.global_index();

        // A file may belong to exactly one desk. A forest that says
        // otherwise is corrupt (see `dedupe_cross_desk`), and writing it
        // verbatim splits the file's identity across two desks — the
        // failure that made a project show up in two desks at once and
        // then go unopenable when one of them was deleted. Repair the
        // forest before anything is written.
        let owned = crate::desk_dedupe::repair_forest(tree, &old_global);
        let tree: &[TreeNode] = owned.as_deref().unwrap_or(tree);

        let desks: Vec<&TreeNode> = tree.iter().filter(|n| n.node_type == "desk").collect();
        let stragglers: Vec<TreeNode> = tree
            .iter()
            .filter(|n| n.node_type != "desk")
            .cloned()
            .collect();

        let roots = crate::desk_roots::load_roots(&self.desks_dir);

        // Expected placement for every file-backed node, per desk.
        let mut new_indexes: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut expected_dirs: HashMap<String, HashSet<PathBuf>> = HashMap::new();
        for desk in &desks {
            let mut files = HashMap::new();
            let mut dirs = HashSet::new();
            collect_expected(&desk.children, &mut Vec::new(), &mut files, &mut dirs);
            new_indexes.insert(desk.id.clone(), files);
            expected_dirs.insert(desk.id.clone(), dirs);
        }

        // Documents adopted from a user's folder keep their own
        // extension — see desk_paths::preserve_doc_extensions.
        crate::desk_paths::preserve_doc_extensions(&mut new_indexes, &old_global);

        // A desk node with no folder of its own is one of two things, and
        // only one of them is real. A *new* desk's files come from
        // staging (or from another internal desk that handed them over)
        // and its folder is created below. Anything else is a stale or
        // foreign identity for a desk that already exists:
        //
        // - no resolvable files at all — a stale or foreign tree;
        //   materialising it fabricates a desk full of blank files;
        // - files that currently live in a **local** desk's folder — a
        //   second identity for that same folder (see desk_identity.rs).
        //   Placement would rename the user's own documents out of their
        //   iCloud/Dropbox folder into `{data_dir}/desks/<id>/`, one by
        //   one, and the far device would then watch the folder empty.
        //
        // Either way: skip the desk wholesale. It costs one order.json
        // slot and heals on the next load, when the registration repair
        // has re-keyed the folder.
        let staged: HashSet<String> = self.staged_ids().into_iter().collect();
        let mut fabricated: HashSet<String> = HashSet::new();
        for desk in &desks {
            let files = &new_indexes[&desk.id];
            if files.is_empty() {
                continue;
            }
            if self.tree_path(&desk.id).exists() {
                continue;
            }
            let any_known = files
                .keys()
                .any(|id| old_global.contains_key(id) || staged.contains(id));
            let poaches_local = files.keys().any(|id| {
                old_global
                    .get(id)
                    .map(|(home, _)| home != &desk.id && roots.contains_key(home))
                    .unwrap_or(false)
            });
            if !any_known || poaches_local {
                let why = if poaches_local {
                    "its files live in a local desk's folder"
                } else {
                    "no resolvable files"
                };
                eprintln!("save_forest: desk {} has no folder and {} — skipping", desk.id, why);
                crate::activity_log::note(
                    "desks",
                    "error",
                    format!("Skipped saving desk {} — it has no folder and {}", desk.id, why),
                );
                fabricated.insert(desk.id.clone());
            }
        }

        // Move / create / adopt every expected file. Errors are contained
        // per desk: one unreachable folder (a local desk on a provider
        // that hasn't mounted it yet — routinely ENOENT) must not abort
        // the desks after it in iteration order. A save that bailed
        // midway left the on-disk forest mixed-generation, and the next
        // load stitched the halves back together — which is how a node
        // moved between desks ended up recorded in both. A desk that
        // fails here is skipped wholesale below (its index and tree.json
        // keep their previous generation together) and the whole save
        // still reports the failure at the end.
        let mut desk_errors: Vec<String> = Vec::new();
        let mut failed: HashSet<String> = HashSet::new();
        for desk in &desks {
            if fabricated.contains(&desk.id) {
                continue;
            }
            let res = (|| -> Result<(), BoxError> {
                fs::create_dir_all(self.desk_dir(&desk.id).join(".hush"))?;
                for dir in expected_dirs.get(&desk.id).into_iter().flatten() {
                    fs::create_dir_all(self.desk_dir(&desk.id).join(dir))?;
                }
                let files = &new_indexes[&desk.id];
                for (id, rel) in files {
                    self.place_file(id, &desk.id, rel, &old_global)?;
                }
                Ok(())
            })();
            if let Err(e) = res {
                desk_errors.push(format!("desk {}: {}", desk.id, e));
                failed.insert(desk.id.clone());
            }
        }

        // Files referenced by straggler nodes (transient non-desk
        // top-level entries awaiting absorption) keep their current
        // placement — orphaning them would blank docs the tree still
        // shows. Their index entries carry over verbatim.
        let mut straggler_ids = Vec::new();
        collect_file_ids(&stragglers, &mut straggler_ids);
        for (id, _) in &straggler_ids {
            if let Some((desk_id, rel)) = old_global.get(id) {
                new_indexes
                    .entry(desk_id.clone())
                    .or_default()
                    .insert(id.clone(), rel.clone());
            }
        }

        // Orphans: indexed files whose node vanished without a delete.
        // Park them under .hush/orphans/ so nothing is silently lost and
        // the namespace stays clean for future same-name files. Local
        // desks are exempt: their folder belongs to the user and the
        // disk-wins reconciler owns its file lifecycle — a file the tree
        // doesn't mention is simply re-absorbed on the next reconcile,
        // whereas parking it would move the user's file into a hidden
        // directory (a stale tree save once emptied a freshly-adopted
        // folder exactly this way).
        let mut all_new: HashSet<&String> = HashSet::new();
        for files in new_indexes.values() {
            all_new.extend(files.keys());
        }
        let live_ids: HashSet<&str> = desks.iter().map(|d| d.id.as_str()).collect();
        for (id, (desk_id, rel)) in &old_global {
            if all_new.contains(id) {
                continue;
            }
            // The whole desk is vanishing — retirement owns its folder;
            // shuffling files into orphans first would rearrange a
            // user's directory.
            if !live_ids.contains(desk_id.as_str()) {
                continue;
            }
            if roots.contains_key(desk_id) {
                continue;
            }
            // A desk whose placement failed keeps its previous generation
            // untouched — don't park its files either.
            if failed.contains(desk_id) {
                continue;
            }
            let src = self.abs_path(desk_id, rel);
            if src.exists() {
                let orphan_dir = self.desk_dir(desk_id).join(".hush").join("orphans");
                if fs::create_dir_all(&orphan_dir).is_err() {
                    continue;
                }
                let base = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let mut dst = orphan_dir.join(&base);
                let mut i = 2;
                while dst.exists() {
                    dst = orphan_dir.join(format!("{} ({})", base, i));
                    i += 1;
                }
                let _ = fs::rename(&src, &dst);
            }
        }

        // Persist per-desk metadata + indexes. A desk that failed
        // placement above is skipped so its index and tree stay one
        // consistent (previous) generation; other desks' failures are
        // collected the same way instead of aborting the rest.
        for desk in &desks {
            if fabricated.contains(&desk.id) || failed.contains(&desk.id) {
                continue;
            }
            let res = (|| -> Result<(), BoxError> {
                self.save_index_merged(&desk.id, &new_indexes[&desk.id])?;
                let raw = serde_json::to_string_pretty(desk)?;
                write_atomic_str(&self.tree_path(&desk.id), &raw)?;
                // Our own write — so the next reconcile doesn't mistake
                // it for the far device restructuring the desk.
                crate::desk_identity::note_tree_seen(&self.desk_dir(&desk.id), &desk.id, &raw);
                let meta_path = self.desk_dir(&desk.id).join(".hushdesk");
                // Start from the existing file so createdAt and any fields
                // other writers own (the per-desk "meta" object — style,
                // last file, stickies) survive the rewrite.
                let mut meta: serde_json::Value = fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| serde_json::json!({}));
                meta["format"] = "hush-desk".into();
                meta["version"] = 1.into();
                meta["id"] = desk.id.clone().into();
                meta["name"] = desk.name.clone().into();
                if meta.get("createdAt").is_none() {
                    meta["createdAt"] = now_secs().into();
                }
                write_atomic_str(&meta_path, &serde_json::to_string_pretty(&meta)?)?;
                Ok(())
            })();
            if let Err(e) = res {
                desk_errors.push(format!("desk {}: {}", desk.id, e));
                failed.insert(desk.id.clone());
                continue;
            }
            // Inside a local desk only directories Hush itself emptied
            // (they used to hold indexed files) may be pruned — an empty
            // directory the user made in their own folder is theirs.
            let managed = roots.contains_key(&desk.id).then(|| {
                let mut dirs = HashSet::new();
                for (old_desk, rel) in old_global.values() {
                    if old_desk != &desk.id {
                        continue;
                    }
                    let mut p = Path::new(rel);
                    while let Some(parent) = p.parent() {
                        if parent.as_os_str().is_empty() {
                            break;
                        }
                        dirs.insert(parent.to_path_buf());
                        p = parent;
                    }
                }
                dirs
            });
            self.prune_empty_dirs(&desk.id, &expected_dirs[&desk.id], managed.as_ref());
        }

        // A desk folder is NEVER retired from a tree save. The reasoning
        // that already exempted local desks applies to internal ones just
        // as much: a desk node missing from one saved forest is
        // indistinguishable from a stale tree (a second window that never
        // saw the desk, an iPad scene resumed with a months-old snapshot,
        // a boot that read the tree before iOS re-granted folder access).
        // Retiring on that signal is how a whole desk's files could
        // disappear behind the user's back. Deletion is explicit now:
        // `deleteDesk` calls `desk_retire` (and `desk_unregister_root` for
        // local desks) *before* saving the tree. Until one of those runs,
        // `load_forest` keeps resurrecting the desk from its folder.

        let order = OrderFile {
            order: desks.iter().map(|d| d.id.clone()).collect(),
            stragglers,
        };
        write_atomic_str(&self.order_path(), &serde_json::to_string_pretty(&order)?)?;
        if !desk_errors.is_empty() {
            return Err(format!(
                "save_forest: {} desk(s) failed (others saved): {}",
                desk_errors.len(),
                desk_errors.join("; ")
            )
            .into());
        }
        Ok(owned)
    }

    // `place_file` and `prune_empty_dirs` live in desk_place.rs (split
    // for the line cap).

    // ===== Content by fileId =====

    pub fn locate(&self, id: &str) -> Option<(String, String)> {
        for desk_id in self.desk_ids_on_disk() {
            if let Some(rel) = self.load_index(&desk_id).remove(id) {
                return Some((desk_id, rel));
            }
        }
        None
    }

    pub fn stage_new(&self, id: &str) -> Result<(), BoxError> {
        let path = self.staging_path(id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic_str(&path, "")?;
        Ok(())
    }

    /// Read a file's content (unpacked to the internal string form), its
    /// mtime, and a display name derived from the filename — from a known
    /// desk id + relative path, skipping the id → location lookup.
    /// `list_files` already holds (desk, rel) from `list_ids`, so it
    /// reads directly instead of re-`locate`-ing every id — which
    /// re-parses each desk's full index once per file (O(N²) over the
    /// library, the cost that stalled autosave on large desks).
    pub fn read_at(&self, desk_id: &str, rel: &str) -> Result<(String, u64, String), BoxError> {
        let abs = self.abs_path(desk_id, rel);
        let content = read_content_at(&abs).map_err(|e| undelivered_or(e, &abs))?;
        let modified = mtime_secs(&abs);
        let name = Path::new(rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
        Ok((content, modified, name))
    }

    /// Same tuple as `read_at`, but locates the file by id first (for
    /// single-file reads where the caller doesn't already know the path).
    pub fn read_by_id(&self, id: &str) -> Result<(String, u64, String), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            return self.read_at(&desk_id, &rel);
        }
        let staged = self.staging_path(id);
        if staged.exists() {
            let content = fs::read_to_string(&staged)?;
            return Ok((content, mtime_secs(&staged), "Untitled".to_string()));
        }
        Err(format!("file not found: {}", id).into())
    }

    pub fn write_by_id(&self, id: &str, content: &str) -> Result<(), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            let hash = write_content_at(&abs, content)?;
            if !is_image_rel(&rel) {
                self.record_hash(&desk_id, id, &hash, crate::desk_hashes::mtime_ms(&abs));
            }
            crate::desk_recovery::note_desk_edit(&desk_id);
            return Ok(());
        }
        // Not placed yet — keep (or put) it in staging; the next tree save
        // moves it to its real path.
        let staged = self.staging_path(id);
        if let Some(parent) = staged.parent() {
            fs::create_dir_all(parent)?;
        }
        // `create_file` stages a new id before its first write, so an
        // existing staging file is the normal case. Nothing there means
        // this id *was* placed and has fallen out of its desk's index.
        // Staging catches the bytes but is per-device — the edit reaches
        // no other machine — and the symptom looks exactly like nothing
        // happening, so say so.
        if !staged.exists() {
            crate::activity_log::note(
                "desks",
                "error",
                format!("Wrote {} to staging — no desk index places it", id),
            );
        }
        write_atomic_str(&staged, content)?;
        Ok(())
    }

    pub fn delete_by_id(&self, id: &str) -> Result<(), BoxError> {
        if let Some((desk_id, rel)) = self.locate(id) {
            let abs = self.abs_path(&desk_id, &rel);
            if abs.exists() {
                fs::remove_file(&abs)?;
            }
            let mut index = self.load_index(&desk_id);
            index.remove(id);
            self.save_index(&desk_id, &index)?;
            crate::desk_recovery::note_desk_edit(&desk_id);
            return Ok(());
        }
        let staged = self.staging_path(id);
        if staged.exists() {
            fs::remove_file(&staged)?;
        }
        Ok(())
    }

    /// Rename the backing file in place (same directory, extension kept).
    /// Staged / unplaced ids are a no-op — the tree name wins at placement.
    pub fn rename_by_id(&self, id: &str, new_name: &str) -> Result<(), BoxError> {
        let Some((desk_id, rel)) = self.locate(id) else { return Ok(()) };
        let rel_path = Path::new(&rel);
        let ext = rel_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let dir = rel_path.parent().unwrap_or(Path::new(""));
        let mut base = sanitize_segment(new_name);
        if !ext.is_empty() {
            let suffix = format!(".{}", ext);
            if base.to_lowercase().ends_with(&suffix) {
                base.truncate(base.len() - suffix.len());
            }
        }
        let new_rel_path = if ext.is_empty() {
            dir.join(&base)
        } else {
            dir.join(format!("{}.{}", base, ext))
        };
        let new_rel = new_rel_path.to_string_lossy().replace('\\', "/");
        if new_rel == rel {
            return Ok(());
        }
        let src = self.abs_path(&desk_id, &rel);
        let dst = self.abs_path(&desk_id, &new_rel);
        if dst.exists() {
            return Ok(()); // collision — leave it; reconcile dedupes on the next tree save
        }
        if src.exists() {
            fs::rename(&src, &dst)?;
        }
        let mut index = self.load_index(&desk_id);
        index.insert(id.to_string(), new_rel);
        self.save_index(&desk_id, &index)?;
        crate::desk_recovery::note_desk_edit(&desk_id);
        Ok(())
    }

    /// All known file ids: indexed (with desk + rel) plus staged.
    pub fn list_ids(&self) -> (Vec<(String, String, String)>, Vec<String>) {
        let mut indexed = Vec::new();
        for desk_id in self.desk_ids_on_disk() {
            for (id, rel) in self.load_index(&desk_id) {
                indexed.push((id, desk_id.clone(), rel));
            }
        }
        (indexed, self.staged_ids())
    }
}

// ===== Content IO by extension =====

fn is_hushnote(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("hushnote")
}

fn is_image_rel(rel: &str) -> bool {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "heic" | "heif" | "avif"
            | "tif" | "tiff"
    )
}

pub fn read_content_at(path: &Path) -> Result<String, BoxError> {
    if is_hushnote(path) {
        let bytes = fs::read(path)?;
        return hushnote::unpack(&bytes);
    }
    Ok(fs::read_to_string(path)?)
}

/// Write content in its on-disk form; returns the FNV-1a hash of the
/// bytes actually written (which differ from `content` for hushnotes),
/// so callers can feed the rename-pairing cache without a re-read.
pub fn write_content_at(path: &Path, content: &str) -> Result<String, BoxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if is_hushnote(path) {
        let bytes = hushnote::pack(content)?;
        write_atomic(path, &bytes)?;
        return Ok(crate::desk_hashes::fnv1a_hex(&bytes));
    }
    write_atomic_str(path, content)?;
    Ok(crate::desk_hashes::fnv1a_hex(content.as_bytes()))
}

// ===== Small helpers =====

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn collect_file_ids(nodes: &[TreeNode], out: &mut Vec<(String, String)>) {
    for n in nodes {
        if let Some(ref fid) = n.file_id {
            out.push((fid.clone(), n.node_type.clone()));
        }
        collect_file_ids(&n.children, out);
    }
}

#[cfg(test)]
#[path = "desk_store_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "desk_soak_tests.rs"]
mod soak_tests;
