use crate::atomic::{write_atomic, write_atomic_str};
use std::fs;
use std::path::PathBuf;

pub struct PdfManager {
    pdfs_dir: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PdfMeta {
    pub file_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_item_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_attachment_key: Option<String>,
}

impl PdfManager {
    pub fn new(data_dir: &PathBuf) -> Self {
        let pdfs_dir = data_dir.join("files").join("pdfs");
        fs::create_dir_all(&pdfs_dir).ok();
        Self { pdfs_dir }
    }

    pub fn save(&self, file_id: &str, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        let safe = sanitize_id(file_id);
        if safe.is_empty() {
            return Err("pdf: empty file id".into());
        }
        let path = self.pdfs_dir.join(format!("{}.pdf", safe));
        write_atomic(&path, bytes)?;
        Ok(())
    }

    pub fn load(&self, file_id: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let safe = sanitize_id(file_id);
        let path = self.pdfs_dir.join(format!("{}.pdf", safe));
        Ok(fs::read(path)?)
    }

    pub fn delete(&self, file_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let safe = sanitize_id(file_id);
        let path = self.pdfs_dir.join(format!("{}.pdf", safe));
        if path.exists() {
            fs::remove_file(&path)?;
        }
        let meta_path = self.pdfs_dir.join(format!("{}.meta.json", safe));
        if meta_path.exists() {
            fs::remove_file(&meta_path)?;
        }
        Ok(())
    }

    pub fn exists(&self, file_id: &str) -> bool {
        let safe = sanitize_id(file_id);
        self.pdfs_dir.join(format!("{}.pdf", safe)).exists()
    }

    pub fn save_meta(&self, file_id: &str, meta: &PdfMeta) -> Result<(), Box<dyn std::error::Error>> {
        let safe = sanitize_id(file_id);
        if safe.is_empty() {
            return Err("pdf meta: empty file id".into());
        }
        let path = self.pdfs_dir.join(format!("{}.meta.json", safe));
        let json = serde_json::to_string(meta)?;
        write_atomic_str(&path, &json)?;
        Ok(())
    }

    pub fn load_meta(&self, file_id: &str) -> Result<Option<PdfMeta>, Box<dyn std::error::Error>> {
        let safe = sanitize_id(file_id);
        let path = self.pdfs_dir.join(format!("{}.meta.json", safe));
        if !path.exists() {
            return Ok(None);
        }
        let json = fs::read_to_string(path)?;
        Ok(Some(serde_json::from_str(&json)?))
    }

    pub fn clear_all(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Ok(rd) = fs::read_dir(&self.pdfs_dir) {
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}
