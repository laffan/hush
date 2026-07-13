//! Per-desk metadata that travels with the desk.
//!
//! Two sidecars, both "small JSONs applied field-by-field" in the sense
//! of the Local Desks design rules (a lost write race in a synced folder
//! costs a preference, never content):
//!
//! - **`.hushdesk` `meta` object** — the desk-scoped preferences that
//!   used to live in app-wide `settings.desksMeta` plus desk-scoped
//!   sticky notes: `{ styleId, lastFileId, lastFileType, stickies }`.
//!   The JS side write-throughs on change and pulls (disk wins) at boot
//!   and after every reconcile, so handing a desk to another install
//!   carries its style choice, last-open file, and stickies along.
//! - **`.hush/gdoc-links.json`** — the per-document Google Doc link map
//!   for files living in this desk, keyed by fileId. The app-wide
//!   `settings.google_doc_links` remains as the merged read cache (and
//!   the home for links whose file isn't placed in any desk yet); an
//!   install without Google credentials still shows the links, just
//!   with the link bar in its disabled "connect Google" state.

use crate::desk_store::DeskStore;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

type BoxError = Box<dyn std::error::Error>;

impl DeskStore {
    // ===== .hushdesk "meta" =====

    /// The desk's `meta` object (style, last file, stickies), or `{}`.
    pub fn load_desk_meta(&self, desk_id: &str) -> Value {
        fs::read_to_string(self.desk_dir(desk_id).join(".hushdesk"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("meta").cloned())
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// Field-merge `patch` into the desk's `meta` object. Values are
    /// stored verbatim — `null` included, since "no last file" and "the
    /// Default style" are explicit choices, not absences. The rest of
    /// `.hushdesk` is left untouched.
    pub fn merge_desk_meta(&self, desk_id: &str, patch: &Value) -> Result<(), BoxError> {
        let path = self.desk_dir(desk_id).join(".hushdesk");
        let mut doc: Value = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .ok_or_else(|| format!("no .hushdesk for desk {}", desk_id))?;
        let meta = doc
            .as_object_mut()
            .ok_or("malformed .hushdesk")?
            .entry("meta")
            .or_insert_with(|| serde_json::json!({}));
        let Some(meta_obj) = meta.as_object_mut() else {
            return Err("malformed .hushdesk meta".into());
        };
        let Some(patch_obj) = patch.as_object() else {
            return Err("meta patch must be an object".into());
        };
        let mut changed = false;
        for (k, v) in patch_obj {
            if meta_obj.get(k) != Some(v) {
                meta_obj.insert(k.clone(), v.clone());
                changed = true;
            }
        }
        if changed {
            crate::atomic::write_atomic_str(&path, &serde_json::to_string_pretty(&doc)?)?;
        }
        Ok(())
    }

    // ===== .hush/gdoc-links.json =====

    fn gdoc_links_path(&self, desk_id: &str) -> PathBuf {
        self.desk_dir(desk_id).join(".hush").join("gdoc-links.json")
    }

    /// One desk's fileId → link map.
    pub fn load_desk_gdoc_links(&self, desk_id: &str) -> HashMap<String, Value> {
        fs::read_to_string(self.gdoc_links_path(desk_id))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| {
                v.get("links")
                    .and_then(|l| serde_json::from_value(l.clone()).ok())
            })
            .unwrap_or_default()
    }

    fn save_desk_gdoc_links(
        &self,
        desk_id: &str,
        links: &HashMap<String, Value>,
    ) -> Result<(), BoxError> {
        let path = self.gdoc_links_path(desk_id);
        if links.is_empty() {
            if path.exists() {
                fs::remove_file(&path)?;
            }
            return Ok(());
        }
        let doc = serde_json::json!({ "format": "hush-gdoc-links", "version": 1, "links": links });
        crate::atomic::write_atomic_str(&path, &serde_json::to_string_pretty(&doc)?)?;
        Ok(())
    }

    /// Record `file_id`'s link in its desk's sidecar. Returns false when
    /// the file isn't placed in any desk (staged) — the caller keeps the
    /// link in app settings until placement.
    pub fn set_desk_gdoc_link(&self, file_id: &str, link: &Value) -> Result<bool, BoxError> {
        let Some((desk_id, _)) = self.locate(file_id) else {
            return Ok(false);
        };
        let mut links = self.load_desk_gdoc_links(&desk_id);
        if links.get(file_id) != Some(link) {
            links.insert(file_id.to_string(), link.clone());
            self.save_desk_gdoc_links(&desk_id, &links)?;
        }
        Ok(true)
    }

    /// Drop `file_id`'s link from whichever desk sidecar holds it.
    pub fn clear_desk_gdoc_link(&self, file_id: &str) -> Result<(), BoxError> {
        for desk_id in self.desk_ids_on_disk() {
            let mut links = self.load_desk_gdoc_links(&desk_id);
            if links.remove(file_id).is_some() {
                self.save_desk_gdoc_links(&desk_id, &links)?;
            }
        }
        Ok(())
    }

    /// The union of every desk's link map (desk entries win over
    /// duplicates by insertion order — duplicates shouldn't exist).
    pub fn all_desk_gdoc_links(&self) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        for desk_id in self.desk_ids_on_disk() {
            out.extend(self.load_desk_gdoc_links(&desk_id));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use crate::desk_store::DeskStore;
    use crate::TreeNode;
    use serde_json::json;

    fn seeded_store() -> (tempfile::TempDir, DeskStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = DeskStore::new(dir.path());
        store.stage_new("f1").unwrap();
        store.write_by_id("f1", "body").unwrap();
        let doc = TreeNode {
            id: "n1".into(),
            name: "Doc".into(),
            node_type: "document".into(),
            file_id: Some("f1".into()),
            children: Vec::new(),
            flagged: false,
            sync_folder_id: None,
            locked_style_id: None,
            use_as_note: false,
            zotero_att_key: None,
            bg_color: None,
            show_numbers: false,
            gutter: false,
        };
        let desk = TreeNode { id: "d1".into(), name: "Personal".into(), node_type: "desk".into(), children: vec![doc], ..doc_defaults() };
        store.save_forest(&[desk]).unwrap();
        (dir, store)
    }

    fn doc_defaults() -> TreeNode {
        TreeNode {
            id: String::new(),
            name: String::new(),
            node_type: String::new(),
            file_id: None,
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

    #[test]
    fn desk_meta_merges_and_survives_forest_saves() {
        let (_dir, store) = seeded_store();
        store
            .merge_desk_meta("d1", &json!({ "styleId": "s9", "lastFileId": "f1" }))
            .unwrap();
        store.merge_desk_meta("d1", &json!({ "lastFileId": null })).unwrap();

        // A tree save rewrites .hushdesk — meta must ride through.
        let forest = store.load_forest().unwrap();
        store.save_forest(&forest).unwrap();

        let meta = store.load_desk_meta("d1");
        assert_eq!(meta.get("styleId"), Some(&json!("s9")));
        assert_eq!(meta.get("lastFileId"), Some(&json!(null)));
    }

    #[test]
    fn gdoc_links_live_in_the_files_desk() {
        let (_dir, store) = seeded_store();
        let link = json!({ "docId": "g123", "title": "My Doc", "linkedAt": 1 });
        assert!(store.set_desk_gdoc_link("f1", &link).unwrap());
        assert_eq!(store.all_desk_gdoc_links().get("f1"), Some(&link));
        // Unplaced files report false so the caller keeps the settings copy.
        assert!(!store.set_desk_gdoc_link("nope", &link).unwrap());

        store.clear_desk_gdoc_link("f1").unwrap();
        assert!(store.all_desk_gdoc_links().is_empty());
    }
}
