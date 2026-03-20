use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // General
    #[serde(default = "default_visibility")]
    pub visibility: String,

    // Editor > Appearance
    #[serde(default = "default_appearance")]
    pub appearance: String,

    // Editor > Themes
    #[serde(default = "default_light_theme")]
    pub light_theme: String,
    #[serde(default = "default_dark_theme")]
    pub dark_theme: String,

    // Editor > Text
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default)]
    pub normalize_headers: bool,
    #[serde(default = "default_padding")]
    pub padding: u32,

    // File management
    pub autosave_folder: Option<String>,
    #[serde(default)]
    pub obsidian_integration: bool,

    // Window
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_column_width")]
    pub column_width: u32,

    // Shortcuts — General
    #[serde(default = "default_shortcut_open")]
    pub shortcut_open_editor: String,
    #[serde(default = "default_shortcut_fullscreen")]
    pub shortcut_open_fullscreen: String,
    #[serde(default = "default_shortcut_private")]
    pub shortcut_toggle_private: String,
    #[serde(default = "default_shortcut_toggle_sidebar")]
    pub shortcut_toggle_sidebar: String,
    #[serde(default = "default_shortcut_typewriter")]
    pub shortcut_typewriter: String,
    #[serde(default = "default_shortcut_new_file")]
    pub shortcut_new_file: String,
    #[serde(default = "default_shortcut_find")]
    pub shortcut_find: String,
    #[serde(default = "default_shortcut_find_all")]
    pub shortcut_find_all: String,

    // Shortcuts — Editing (sentence navigation)
    #[serde(default = "default_shortcut_select_sentence")]
    pub shortcut_select_sentence: String,
    #[serde(default = "default_shortcut_reduce_sentence")]
    pub shortcut_reduce_sentence: String,
    #[serde(default = "default_shortcut_select_next")]
    pub shortcut_select_next: String,
    #[serde(default = "default_shortcut_next_sentence")]
    pub shortcut_next_sentence: String,
    #[serde(default = "default_shortcut_prev_sentence")]
    pub shortcut_prev_sentence: String,
    #[serde(default = "default_shortcut_move_sentence_forward")]
    pub shortcut_move_sentence_forward: String,
    #[serde(default = "default_shortcut_move_sentence_back")]
    pub shortcut_move_sentence_back: String,
    #[serde(default = "default_shortcut_select_to_sentence_end")]
    pub shortcut_select_to_sentence_end: String,
    #[serde(default = "default_shortcut_select_to_sentence_start")]
    pub shortcut_select_to_sentence_start: String,
    #[serde(default = "default_shortcut_delete_to_sentence_end")]
    pub shortcut_delete_to_sentence_end: String,

    // Shortcuts — Formatting
    #[serde(default = "default_shortcut_bold")]
    pub shortcut_bold: String,
    #[serde(default = "default_shortcut_italic")]
    pub shortcut_italic: String,
    #[serde(default = "default_shortcut_highlight")]
    pub shortcut_highlight: String,
    #[serde(default = "default_shortcut_comment")]
    pub shortcut_comment: String,

    // Styles
    #[serde(default)]
    pub styles: Vec<Style>,
    #[serde(default)]
    pub active_style_id: Option<String>,

    #[serde(skip)]
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub theme_id: Option<String>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<u32>,
    #[serde(default)]
    pub line_height: Option<f64>,
    #[serde(default)]
    pub color_overrides: std::collections::HashMap<String, String>,
}

fn default_visibility() -> String { "menubar".to_string() }
fn default_appearance() -> String { "dark".to_string() }
fn default_light_theme() -> String { "ayuLight".to_string() }
fn default_dark_theme() -> String { "dracula".to_string() }
fn default_font_size() -> u32 { 20 }
fn default_line_height() -> f64 { 1.6 }
fn default_font_family() -> String { "EB Garamond".to_string() }
fn default_padding() -> u32 { 50 }
fn default_column_width() -> u32 { 600 }
fn default_shortcut_open() -> String { "CmdOrCtrl+Shift+H".to_string() }
fn default_shortcut_fullscreen() -> String { "CmdOrCtrl+Shift+F".to_string() }
fn default_shortcut_private() -> String { "CmdOrCtrl+Shift+P".to_string() }
fn default_shortcut_toggle_sidebar() -> String { "Mod+\\".to_string() }
fn default_shortcut_typewriter() -> String { "Mod+T".to_string() }
fn default_shortcut_new_file() -> String { "Mod+N".to_string() }
fn default_shortcut_find() -> String { "Mod+F".to_string() }
fn default_shortcut_find_all() -> String { "Mod+Shift+F".to_string() }
fn default_shortcut_select_sentence() -> String { "Mod+L".to_string() }
fn default_shortcut_reduce_sentence() -> String { "Mod+Shift+L".to_string() }
fn default_shortcut_select_next() -> String { "Mod+D".to_string() }
fn default_shortcut_next_sentence() -> String { "Mod+Shift+ArrowRight".to_string() }
fn default_shortcut_prev_sentence() -> String { "Mod+Shift+ArrowLeft".to_string() }
fn default_shortcut_move_sentence_forward() -> String { "Alt+Mod+ArrowRight".to_string() }
fn default_shortcut_move_sentence_back() -> String { "Alt+Mod+ArrowLeft".to_string() }
fn default_shortcut_select_to_sentence_end() -> String { "Alt+Shift+.".to_string() }
fn default_shortcut_select_to_sentence_start() -> String { "Alt+Shift+,".to_string() }
fn default_shortcut_delete_to_sentence_end() -> String { "Alt+Shift+Backspace".to_string() }
fn default_shortcut_bold() -> String { "Mod+B".to_string() }
fn default_shortcut_italic() -> String { "Mod+I".to_string() }
fn default_shortcut_highlight() -> String { "Mod+=".to_string() }
fn default_shortcut_comment() -> String { "Mod+/".to_string() }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            visibility: default_visibility(),
            appearance: default_appearance(),
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            font_family: default_font_family(),
            normalize_headers: false,
            padding: default_padding(),
            autosave_folder: None,
            obsidian_integration: false,
            always_on_top: false,
            column_width: default_column_width(),
            shortcut_open_editor: default_shortcut_open(),
            shortcut_open_fullscreen: default_shortcut_fullscreen(),
            shortcut_toggle_private: default_shortcut_private(),
            shortcut_toggle_sidebar: default_shortcut_toggle_sidebar(),
            shortcut_typewriter: default_shortcut_typewriter(),
            shortcut_new_file: default_shortcut_new_file(),
            shortcut_find: default_shortcut_find(),
            shortcut_find_all: default_shortcut_find_all(),
            shortcut_select_sentence: default_shortcut_select_sentence(),
            shortcut_reduce_sentence: default_shortcut_reduce_sentence(),
            shortcut_select_next: default_shortcut_select_next(),
            shortcut_next_sentence: default_shortcut_next_sentence(),
            shortcut_prev_sentence: default_shortcut_prev_sentence(),
            shortcut_move_sentence_forward: default_shortcut_move_sentence_forward(),
            shortcut_move_sentence_back: default_shortcut_move_sentence_back(),
            shortcut_select_to_sentence_end: default_shortcut_select_to_sentence_end(),
            shortcut_select_to_sentence_start: default_shortcut_select_to_sentence_start(),
            shortcut_delete_to_sentence_end: default_shortcut_delete_to_sentence_end(),
            shortcut_bold: default_shortcut_bold(),
            shortcut_italic: default_shortcut_italic(),
            shortcut_highlight: default_shortcut_highlight(),
            shortcut_comment: default_shortcut_comment(),
            styles: Vec::new(),
            active_style_id: None,
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
