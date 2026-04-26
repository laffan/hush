use crate::atomic::write_atomic_str;
use std::fs;
use std::path::PathBuf;

pub struct ZoteroManager {
    data_dir: PathBuf,
}

impl ZoteroManager {
    pub fn new(data_dir: &PathBuf) -> Self {
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
}
