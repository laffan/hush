//! Desk identity — which desk a folder *is*, and keeping this device's
//! registration in step with it. Also owns forest loading, since that is
//! where the two meet.
//!
//! A desk's id travels **inside** the folder (`.hushdesk`, and the desk
//! node in `.hush/tree.json`); the id → folder map (`roots.json`) is
//! per-device bookkeeping. `DeskStore::desk_dir` resolves every read and
//! write through that map, so the two disagreeing is not cosmetic: a
//! forest loaded under key `A` but carrying id `B` resolves `B` to
//! `{data_dir}/desks/B` — a folder that doesn't exist — and the next
//! `save_forest` dutifully *renames the user's files out of their synced
//! folder* into it, one by one. Both devices then watch the folder empty
//! itself.
//!
//! That is the shape behind the two-device report: a second install
//! minted a fresh id for a folder that was already a desk, both installs
//! kept stamping their own id into the shared sidecars, and the id
//! flipped underneath each of them. Three rules close it:
//!
//! 1. **The folder's own id wins.** It is the portable identity; the
//!    registration is per-device and is re-keyed to match
//!    (`reconcile_desk_registrations` — pure bookkeeping, no file moves).
//! 2. **One folder is one desk.** Two registrations for one path make
//!    `load_forest` yield the same desk twice; that duplicate persists
//!    into order.json and multiplies from there (the "Letters, Letters,
//!    Letters" forests). The load dedupes by node id as a backstop.
//! 3. **A folder whose desk sidecars exist but can't be read is a desk
//!    we haven't been given yet** — never a blank folder to initialise a
//!    *new* desk into. On iOS an evicted file is a `.<name>.icloud`
//!    placeholder, so "missing" is the normal state of a desk folder the
//!    provider hasn't delivered; see `inspect_folder`.

use crate::desk_roots::{load_entries, save_entries, RootEntry};
use crate::desk_store::DeskStore;
use crate::TreeNode;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

type BoxError = Box<dyn std::error::Error>;

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub(crate) struct OrderFile {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub stragglers: Vec<TreeNode>,
}

/// What a folder is, as far as desks go.
#[derive(Debug, PartialEq)]
pub enum FolderDesk {
    /// Nothing desk-shaped here — safe to initialise a desk in place.
    Plain,
    /// Already a desk, carrying this id.
    Desk(String),
    /// Desk sidecars are present but their identity can't be read: an
    /// iCloud folder the provider hasn't delivered, a half-written
    /// sidecar, a folder someone edited by hand. The string is the
    /// user-facing reason.
    Pending(String),
}

/// The `.<name>.icloud` placeholder iOS leaves where an evicted file
/// belongs. Its presence means "this file exists, it just isn't local".
pub(crate) fn placeholder_for(path: &Path) -> Option<std::path::PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.parent()?.join(format!(".{}.icloud", name)))
}

/// True when the file itself is absent but iCloud is holding a
/// placeholder for it.
pub(crate) fn awaiting_download(path: &Path) -> bool {
    !path.exists() && placeholder_for(path).map(|p| p.exists()).unwrap_or(false)
}

/// The `id` field of a small JSON sidecar, when it reads cleanly.
fn read_desk_id(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let id = v.get("id")?.as_str()?;
    (!id.is_empty()).then(|| id.to_string())
}

/// Decide what a folder is before writing anything into it.
///
/// The identity is read from `.hushdesk` first (the identity file), then
/// from the desk node in `.hush/tree.json` — either one answering is
/// enough, because a desk folder that is *partly* delivered is still
/// that desk and must keep its id. Only a folder with no trace of a desk
/// at all is `Plain`.
pub fn inspect_folder(path: &Path) -> FolderDesk {
    let meta = path.join(".hushdesk");
    let tree = path.join(".hush").join("tree.json");
    if let Some(id) = read_desk_id(&meta).or_else(|| read_desk_id(&tree)) {
        return FolderDesk::Desk(id);
    }
    let pending = awaiting_download(&meta) || awaiting_download(&tree);
    let marked = pending || meta.exists() || tree.exists() || path.join(".hush").is_dir();
    if !marked {
        return FolderDesk::Plain;
    }
    if pending {
        // The one case that must never fall through to "initialise": the
        // folder *is* a desk and we simply haven't been handed it yet.
        return FolderDesk::Pending(
            "that folder is a Hush desk, but its data hasn't finished downloading yet — \
             open it again in a moment"
                .into(),
        );
    }
    FolderDesk::Pending("that folder holds a damaged desk (.hushdesk / .hush mismatch)".into())
}

impl DeskStore {
    /// Make `roots.json` agree with the folders themselves: one
    /// registration per folder, keyed by the id that folder carries.
    ///
    /// Runs before every forest load. Pure bookkeeping — nothing on disk
    /// moves, and a folder we can't currently read (unmounted provider,
    /// undelivered sidecars, revoked iOS bookmark) is left exactly as
    /// registered rather than guessed at.
    pub(crate) fn reconcile_desk_registrations(&self) {
        let entries = load_entries(&self.desks_dir);
        if entries.is_empty() {
            return;
        }
        // Registered id → the id its folder actually carries, when we
        // can read one.
        let mut folder_ids: HashMap<String, String> = HashMap::new();
        for (id, entry) in &entries {
            if let FolderDesk::Desk(fid) = inspect_folder(Path::new(entry.path())) {
                folder_ids.insert(id.clone(), fid);
            }
        }

        let mut next: HashMap<String, RootEntry> = HashMap::new();
        let mut claimed_paths: HashSet<String> = HashSet::new();
        let mut rekeys: Vec<(String, String)> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        // Entries whose folder answered come first: they own their path,
        // so a second registration for the same folder loses.
        let mut ids: Vec<&String> = entries.keys().collect();
        ids.sort_by_key(|id| (!folder_ids.contains_key(*id), (*id).clone()));
        for id in ids {
            let entry = &entries[id];
            let target = folder_ids.get(id).cloned().unwrap_or_else(|| id.clone());
            let path_taken = !claimed_paths.insert(entry.path().to_string());
            if path_taken || next.contains_key(&target) {
                // Another registration already speaks for this folder (or
                // for this identity) — drop this one rather than keep a
                // second door into the same desk.
                if target == *id {
                    dropped.push(id.clone());
                } else {
                    rekeys.push((id.clone(), target));
                }
                continue;
            }
            if target != *id {
                rekeys.push((id.clone(), target.clone()));
            }
            next.insert(target, entry.clone());
        }
        if rekeys.is_empty() && dropped.is_empty() {
            return;
        }
        for (from, to) in &rekeys {
            crate::activity_log::note(
                "desks",
                "warn",
                format!("Local desk folder re-keyed to the id it carries: {} → {}", from, to),
            );
        }
        for id in &dropped {
            crate::activity_log::note(
                "desks",
                "warn",
                format!("Dropped a duplicate registration for desk {}'s folder", id),
            );
        }
        if save_entries(&self.desks_dir, &next).is_ok() {
            self.apply_desk_rekeys(&rekeys, &dropped);
        }
    }

    /// Carry a registration re-key into order.json so the desk keeps its
    /// position instead of reappearing at the end, and so a stale id
    /// can't linger as a phantom slot.
    fn apply_desk_rekeys(&self, rekeys: &[(String, String)], dropped: &[String]) {
        let map: HashMap<&str, &str> = rekeys
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        let gone: HashSet<&str> = dropped.iter().map(String::as_str).collect();
        let mut order = self.load_order();
        let mut seen = HashSet::new();
        let rewritten: Vec<String> = order
            .order
            .iter()
            .filter(|id| !gone.contains(id.as_str()))
            .map(|id| map.get(id.as_str()).map(|s| (*s).to_string()).unwrap_or_else(|| id.clone()))
            .filter(|id| seen.insert(id.clone()))
            .collect();
        if rewritten == order.order {
            return;
        }
        order.order = rewritten;
        let _ = self.save_order(&order);
    }

    pub(crate) fn load_order(&self) -> OrderFile {
        fs::read_to_string(self.order_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub(crate) fn save_order(&self, order: &OrderFile) -> Result<(), BoxError> {
        crate::atomic::write_atomic_str(
            &self.order_path(),
            &serde_json::to_string_pretty(order)?,
        )?;
        Ok(())
    }

    /// Every desk id with a resolvable folder: internal subdirectories
    /// plus registered local roots (both validated by their tree.json).
    pub(crate) fn desk_ids_on_disk(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.desks_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || !entry.path().is_dir() {
                    continue;
                }
                if entry.path().join(".hush").join("tree.json").exists() {
                    out.push(name);
                }
            }
        }
        for (desk_id, root) in crate::desk_roots::load_roots(&self.desks_dir) {
            if out.contains(&desk_id) {
                continue;
            }
            if Path::new(&root).join(".hush").join("tree.json").exists() {
                out.push(desk_id);
            }
        }
        out
    }

    /// Append a desk id to order.json (used by the adopt flow so a newly
    /// registered desk lands at a stable position instead of re-sorting
    /// on every load).
    pub(crate) fn append_to_order(&self, desk_id: &str) -> Result<(), BoxError> {
        let mut order = self.load_order();
        if !order.order.iter().any(|d| d == desk_id) {
            order.order.push(desk_id.to_string());
            self.save_order(&order)?;
        }
        Ok(())
    }

    pub fn load_forest(&self) -> Result<Vec<TreeNode>, BoxError> {
        self.reconcile_desk_registrations();
        let order = self.load_order();

        // Two guards, and they are not the same one. `keys` stops the
        // on-disk sweep from re-reading a desk order.json already named;
        // `ids` stops one folder from entering the forest twice however
        // it was reached — the duplicate desk nodes that then persist
        // into order.json and breed on every save.
        let mut keys = HashSet::new();
        let mut ids = HashSet::new();
        let mut forest = Vec::new();
        for desk_id in &order.order {
            if !keys.insert(desk_id.clone()) {
                continue;
            }
            if let Some(node) = self.load_desk_tree(desk_id) {
                if ids.insert(node.id.clone()) {
                    forest.push(node);
                }
            }
        }
        // Desk folders present on disk but missing from order.json (e.g. a
        // folder dropped in by hand) append at the end — the adopt seam.
        for desk_id in self.desk_ids_on_disk() {
            if keys.contains(&desk_id) {
                continue;
            }
            if let Some(node) = self.load_desk_tree(&desk_id) {
                if ids.insert(node.id.clone()) {
                    forest.push(node);
                }
            }
        }
        forest.extend(order.stragglers);
        Ok(forest)
    }

    pub(crate) fn load_desk_tree(&self, desk_id: &str) -> Option<TreeNode> {
        let s = fs::read_to_string(self.tree_path(desk_id)).ok()?;
        serde_json::from_str::<TreeNode>(&s).ok()
    }
}
