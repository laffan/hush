use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u32,
    pub font_family: String,
    pub padding: u32,
    pub autosave_folder: Option<String>,
    pub obsidian_integration: bool,
    pub always_on_top: bool,
    pub show_in_dock: bool,
    pub shortcut_open_editor: String,
    pub shortcut_toggle_private: String,
    pub column_width: u32,
    #[serde(skip)]
    pub data_dir: PathBuf,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            font_size: 20,
            font_family: "EB Garamond".to_string(),
            padding: 50,
            autosave_folder: None,
            obsidian_integration: false,
            always_on_top: false,
            show_in_dock: false,
            shortcut_open_editor: "CmdOrCtrl+Shift+H".to_string(),
            shortcut_toggle_private: "CmdOrCtrl+Shift+P".to_string(),
            column_width: 700,
            data_dir: PathBuf::new(),
        }
    }
}

impl AppSettings {
    pub fn load(data_dir: &PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let path = data_dir.join("settings.json");
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let mut settings: AppSettings = serde_json::from_str(&content)?;
            settings.data_dir = data_dir.clone();
            Ok(settings)
        } else {
            let mut settings = AppSettings::default();
            settings.data_dir = data_dir.clone();
            Ok(settings)
        }
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = self.data_dir.join("settings.json");
        let content = serde_json::to_string_pretty(self)?;
        fs::write(path, content)?;
        Ok(())
    }
}
