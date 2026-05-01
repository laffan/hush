use crate::atomic::{write_atomic, write_atomic_str};
use std::fs;
use std::path::PathBuf;

pub struct ZoteroManager {
    data_dir: PathBuf,
}

impl ZoteroManager {
    pub fn new(data_dir: &PathBuf) -> Self {
        let pdfs = data_dir.join("zotero_pdfs");
        fs::create_dir_all(&pdfs).ok();
        Self {
            data_dir: data_dir.clone(),
        }
    }

    /// Save references JSON blob to disk
    pub fn save_references(&self, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.data_dir.join("zotero_references.json");
        write_atomic_str(&path, data)?;
        Ok(())
    }

    /// Load references JSON blob from disk
    pub fn load_references(&self) -> Result<String, Box<dyn std::error::Error>> {
        let path = self.data_dir.join("zotero_references.json");
        if path.exists() {
            Ok(fs::read_to_string(path)?)
        } else {
            Ok("[]".to_string())
        }
    }

    /// Save a downloaded PDF binary keyed by Zotero attachment key.
    /// Filenames are sanitised (alphanumeric + dash + underscore only) so
    /// callers can't escape the `zotero_pdfs/` directory.
    pub fn save_pdf(&self, item_key: &str, bytes: &[u8]) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let safe = sanitize_key(item_key);
        if safe.is_empty() {
            return Err("zotero pdf: empty key".into());
        }
        let dir = self.data_dir.join("zotero_pdfs");
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.pdf", safe));
        write_atomic(&path, bytes)?;
        Ok(path)
    }

    /// Read PDF bytes for a previously-saved attachment key. Returns an
    /// error if the file is missing.
    pub fn load_pdf(&self, item_key: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let safe = sanitize_key(item_key);
        let path = self.data_dir.join("zotero_pdfs").join(format!("{}.pdf", safe));
        Ok(fs::read(path)?)
    }

    /// True when a saved PDF exists for the key.
    pub fn pdf_exists(&self, item_key: &str) -> bool {
        let safe = sanitize_key(item_key);
        self.data_dir.join("zotero_pdfs").join(format!("{}.pdf", safe)).exists()
    }

    /// Save annotations JSON for a given Zotero attachment key. The JSON
    /// is whatever the caller produced (typically the normalised list
    /// shaped by `src/zotero-annotations.js`).
    pub fn save_annotations(&self, item_key: &str, data: &str) -> Result<(), Box<dyn std::error::Error>> {
        let safe = sanitize_key(item_key);
        if safe.is_empty() {
            return Err("zotero annotations: empty key".into());
        }
        let dir = self.data_dir.join("zotero_annotations");
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", safe));
        write_atomic_str(&path, data)?;
        Ok(())
    }

    /// Load annotations JSON for an attachment key. Returns `None` when
    /// no cache file exists yet.
    pub fn load_annotations(&self, item_key: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
        let safe = sanitize_key(item_key);
        let path = self.data_dir.join("zotero_annotations").join(format!("{}.json", safe));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read_to_string(path)?))
    }
}

fn sanitize_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}
