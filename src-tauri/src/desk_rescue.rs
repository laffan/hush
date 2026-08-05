//! Explicit desk retirement, and recovery of files a desk lost track of.
//!
//! Two halves of the same story.
//!
//! **Retirement.** `save_forest` used to retire any desk folder whose node
//! was missing from the tree it was handed. That inferred a deletion from
//! a signal that also means "this window's tree is stale", so one stale
//! save could sweep a live desk into `.deleted/`. Retirement is explicit
//! now: `deleteDesk` calls `desk_retire` and nothing else moves a desk
//! folder. The folder is *moved*, never wiped, so `recover_desk_files` can
//! still read what was in it.
//!
//! **Recovery.** A tree node whose fileId resolves nowhere renders in the
//! sidebar but can't be opened — the tail end of the cross-desk
//! contamination this release fixes, and of any interrupted move. The
//! bytes are usually still on disk in one of two places: a retired desk
//! folder under `desks/.deleted/`, or a desk's own `.hush/orphans/`.
//! `recover_desk_files` walks the live forest for unresolvable ids, hunts
//! for their content in both, and copies it back to where the tree says it
//! belongs — re-indexing as it goes. Nothing is deleted or overwritten:
//! recovery only ever fills a gap.

use crate::atomic::write_atomic_str;
use crate::desk_paths::collect_expected;
use crate::desk_store::DeskStore;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type BoxError = Box<dyn std::error::Error>;

#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    /// Nodes whose fileId resolved to no readable file.
    pub broken: usize,
    /// Of those, how many were restored from a retired or orphaned copy.
    pub restored: usize,
    /// Files found in a desk's folder that its index had lost.
    pub reindexed: usize,
    /// Human-readable detail lines, newest problem first.
    pub notes: Vec<String>,
}

impl DeskStore {
    /// Move a desk's folder aside. The only path that retires a desk.
    /// Local desks are left alone — their folder belongs to the user;
    /// `desk_unregister_root` disconnects those instead.
    pub fn retire_desk(&self, desk_id: &str) -> Result<Option<PathBuf>, BoxError> {
        if crate::desk_roots::root_for(&self.desks_dir, desk_id).is_some() {
            return Ok(None);
        }
        let src = self.desks_dir.join(desk_id);
        if !src.is_dir() {
            return Ok(None);
        }
        let trash = self.desks_dir.join(".deleted");
        fs::create_dir_all(&trash)?;
        let dst = trash.join(format!("{}-{}", desk_id, now_secs()));
        fs::rename(&src, &dst)?;
        Ok(Some(dst))
    }

    /// Retired desk folders, newest last: `(deskId, folder)`.
    fn retired_desks(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(self.desks_dir.join(".deleted")) else {
            return out;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // `<deskId>-<epochSecs>` — the id is everything before the
            // last dash, since desk ids may themselves contain dashes.
            let desk_id = name.rsplit_once('-').map(|(id, _)| id).unwrap_or(&name);
            out.push((desk_id.to_string(), path));
        }
        out.sort_by_key(|(_, p)| p.clone());
        out
    }

    /// The bytes of one lost file, if a retired desk folder still holds
    /// them. Cheap on a healthy install — `desks/.deleted` usually
    /// doesn't exist, so this is a single failed `read_dir`.
    pub(crate) fn find_rescue_copy(&self, file_id: &str) -> Option<PathBuf> {
        for (_, folder) in self.retired_desks() {
            let rel = retired_index(&folder).remove(file_id)?;
            let abs = folder.join(rel);
            if abs.is_file() {
                return Some(abs);
            }
        }
        None
    }

    /// Every place a lost file's bytes might still be: fileId → absolute
    /// path, gathered from retired desk folders (via the index each one
    /// carries) and from every live desk's `.hush/orphans/`.
    fn rescue_pool(&self) -> HashMap<String, PathBuf> {
        let mut pool: HashMap<String, PathBuf> = HashMap::new();
        for (_, folder) in self.retired_desks() {
            for (id, rel) in retired_index(&folder) {
                let abs = folder.join(&rel);
                if abs.is_file() {
                    pool.insert(id, abs);
                }
            }
        }
        pool
    }

    /// Find tree nodes whose content has gone missing and put it back.
    /// Safe to run at any time: it only ever adds files and index
    /// entries, so a healthy install reports zeroes and changes nothing.
    pub fn recover_desk_files(&self) -> Result<RepairReport, BoxError> {
        let mut report = RepairReport::default();
        let forest = self.load_forest()?;
        let pool = self.rescue_pool();

        for desk in forest.iter().filter(|n| n.node_type == "desk") {
            let mut index = self.load_index(&desk.id);
            let mut expected = HashMap::new();
            let mut dirs = HashSet::new();
            collect_expected(&desk.children, &mut Vec::new(), &mut expected, &mut dirs);

            let mut index_dirty = false;
            for (file_id, rel) in &expected {
                let indexed = index.get(file_id).cloned();
                let indexed_ok = indexed
                    .as_ref()
                    .map(|r| self.abs_path(&desk.id, r).is_file())
                    .unwrap_or(false);
                if indexed_ok {
                    continue;
                }
                // The tree's own path may already hold the file even
                // though the index lost it (an interrupted save) — that's
                // a re-index, not a restore.
                if self.abs_path(&desk.id, rel).is_file() {
                    index.insert(file_id.clone(), rel.clone());
                    index_dirty = true;
                    report.reindexed += 1;
                    continue;
                }
                report.broken += 1;
                let Some(source) = pool.get(file_id) else {
                    report
                        .notes
                        .push(format!("{} — no recoverable copy of {}", desk.name, rel));
                    continue;
                };
                let dst = self.abs_path(&desk.id, rel);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent)?;
                }
                match fs::copy(source, &dst) {
                    Ok(_) => {
                        index.insert(file_id.clone(), rel.clone());
                        index_dirty = true;
                        report.restored += 1;
                        report
                            .notes
                            .push(format!("{} — restored {}", desk.name, rel));
                    }
                    Err(e) => report
                        .notes
                        .push(format!("{} — could not restore {}: {}", desk.name, rel, e)),
                }
            }

            // Files sitting in the desk's own orphans bin whose id the
            // tree still references get folded back in the same way.
            let orphan_dir = self.desk_dir(&desk.id).join(".hush").join("orphans");
            if orphan_dir.is_dir() {
                report.notes.push(format!(
                    "{} — {} file(s) parked in .hush/orphans",
                    desk.name,
                    fs::read_dir(&orphan_dir).map(|r| r.count()).unwrap_or(0)
                ));
            }

            if index_dirty {
                self.save_index(&desk.id, &index)?;
            }
        }
        Ok(report)
    }

    /// A one-line-per-desk description of what the store believes it
    /// holds. Feeds the Debug tab so a corrupted install can be
    /// described without a Mac and a Finder window.
    pub fn store_diagnostics(&self) -> serde_json::Value {
        let roots = crate::desk_roots::load_roots(&self.desks_dir);
        let mut seen_ids: HashMap<String, Vec<String>> = HashMap::new();
        let desks: Vec<serde_json::Value> = self
            .desk_ids_on_disk()
            .into_iter()
            .map(|desk_id| {
                let index = self.load_index(&desk_id);
                for id in index.keys() {
                    seen_ids
                        .entry(id.clone())
                        .or_default()
                        .push(desk_id.clone());
                }
                let tree = self.load_desk_tree(&desk_id);
                serde_json::json!({
                    "id": desk_id,
                    "name": tree.as_ref().map(|t| t.name.clone()),
                    "local": roots.get(&desk_id),
                    "indexed": index.len(),
                    "missing": index
                        .iter()
                        .filter(|(_, rel)| !self.abs_path(&desk_id, rel).is_file())
                        .count(),
                })
            })
            .collect();
        let contested: Vec<String> = seen_ids
            .into_iter()
            .filter(|(_, owners)| owners.len() > 1)
            .map(|(id, owners)| format!("{} claimed by {}", id, owners.join(" + ")))
            .collect();
        serde_json::json!({
            "desksDir": self.desks_dir.to_string_lossy(),
            "desks": desks,
            "retired": self
                .retired_desks()
                .into_iter()
                .map(|(id, p)| format!("{} ({})", id, p.to_string_lossy()))
                .collect::<Vec<_>>(),
            "contestedFileIds": contested,
            "staged": self.staged_ids().len(),
        })
    }
}

/// Restore a whole retired desk folder back into `desks/` under its own
/// id. Used by the Debug tab's "undelete desk" affordance.
pub fn restore_retired_desk(desks_dir: &Path, folder_name: &str) -> Result<String, BoxError> {
    let src = desks_dir.join(".deleted").join(folder_name);
    if !src.is_dir() {
        return Err(format!("no retired desk folder named {}", folder_name).into());
    }
    let desk_id = fs::read_to_string(src.join(".hushdesk"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("id")?.as_str().map(str::to_string))
        .or_else(|| {
            folder_name
                .rsplit_once('-')
                .map(|(id, _)| id.to_string())
        })
        .ok_or("could not determine the retired desk's id")?;
    let dst = desks_dir.join(&desk_id);
    if dst.exists() {
        return Err(format!("desk {} is already present", desk_id).into());
    }
    fs::rename(&src, &dst)?;
    // Put it back in the ordering so `load_forest` lists it in place
    // rather than appending it as an adopted stray.
    let order_path = desks_dir.join("order.json");
    if let Ok(raw) = fs::read_to_string(&order_path) {
        if let Ok(mut order) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(list) = order.get_mut("order").and_then(|v| v.as_array_mut()) {
                if !list.iter().any(|v| v.as_str() == Some(desk_id.as_str())) {
                    list.push(serde_json::Value::String(desk_id.clone()));
                    let _ = write_atomic_str(&order_path, &serde_json::to_string_pretty(&order)?);
                }
            }
        }
    }
    Ok(desk_id)
}

/// Retired desk folders as `{ folder, deskId, name, files }` for the UI.
pub fn list_retired_desks(desks_dir: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(desks_dir.join(".deleted")) else {
        return out;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta: serde_json::Value = fs::read_to_string(path.join(".hushdesk"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let files = fs::read_to_string(path.join(".hush/index.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("files").map(|f| f.as_object().map(|o| o.len())))
            .flatten()
            .unwrap_or(0);
        out.push(serde_json::json!({
            "folder": entry.file_name().to_string_lossy(),
            "deskId": meta.get("id").and_then(|v| v.as_str()),
            "name": meta.get("name").and_then(|v| v.as_str()),
            "files": files,
        }));
    }
    out
}

/// fileId → relative path, read out of a retired desk folder's own index.
fn retired_index(folder: &Path) -> HashMap<String, String> {
    fs::read_to_string(folder.join(".hush").join("index.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| serde_json::from_value(v.get("files")?.clone()).ok())
        .unwrap_or_default()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
