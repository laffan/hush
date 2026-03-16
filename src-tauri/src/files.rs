use crate::FileEntry;
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
        fs::write(&path, serde_json::to_string(&entry)?)?;
        Ok(entry)
    }

    pub fn save_file(&self, id: &str, content: &str) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.files_dir.join(format!("{}.json", id));
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let name = derive_name(content);
        let entry = FileEntry {
            id: id.to_string(),
            name,
            content: content.to_string(),
            modified: now,
        };
        fs::write(&path, serde_json::to_string(&entry)?)?;
        Ok(())
    }

    pub fn save_to_external(
        &self,
        id: &str,
        content: &str,
        folder: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let folder_path = PathBuf::from(folder);
        fs::create_dir_all(&folder_path)?;
        let name = derive_name(content);
        let filename = sanitize_filename(&name);
        let path = folder_path.join(format!("{}.md", filename));
        fs::write(&path, content)?;
        // Also save an ID mapping so we can track which file is which
        let meta_dir = folder_path.join(".hush");
        fs::create_dir_all(&meta_dir)?;
        fs::write(meta_dir.join(format!("{}.id", filename)), id)?;
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

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}
