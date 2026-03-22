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
    #[serde(default = "default_shortcut_toggle_dry")]
    pub shortcut_toggle_dry: String,
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
    #[serde(default = "default_shortcut_jump_next_sentence")]
    pub shortcut_jump_next_sentence: String,
    #[serde(default = "default_shortcut_jump_prev_sentence")]
    pub shortcut_jump_prev_sentence: String,
    #[serde(default = "default_shortcut_next_sentence")]
    pub shortcut_next_sentence: String,
    #[serde(default = "default_shortcut_prev_sentence")]
    pub shortcut_prev_sentence: String,
    #[serde(default = "default_shortcut_move_sentence_forward")]
    pub shortcut_move_sentence_forward: String,
    #[serde(default = "default_shortcut_move_sentence_back")]
    pub shortcut_move_sentence_back: String,
    #[serde(default = "default_shortcut_select_previous")]
    pub shortcut_select_previous: String,
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
    #[serde(default = "default_shortcut_insert_footnote")]
    pub shortcut_insert_footnote: String,

    // D.R.Y. highlighting
    #[serde(default = "default_dry_range")]
    pub dry_range: String,
    #[serde(default = "default_dry_stopwords")]
    pub dry_stopwords: Vec<String>,
    #[serde(default)]
    pub dry_ignore_proper_nouns: bool,
    #[serde(default)]
    pub dry_include_base_words: bool,

    // Footnotes
    #[serde(default = "default_footnote_font_size")]
    pub footnote_font_size: u32,
    #[serde(default = "default_footnote_font_family")]
    pub footnote_font_family: String,
    #[serde(default = "default_footnote_use_colors")]
    pub footnote_use_colors: bool,
    #[serde(default = "default_footnote_both_margins")]
    pub footnote_both_margins: bool,

    // Styles
    #[serde(default)]
    pub styles: Vec<Style>,
    #[serde(default)]
    pub active_style_id: Option<String>,

    // Session state (persisted across restarts)
    #[serde(default)]
    pub window_width: Option<f64>,
    #[serde(default)]
    pub window_height: Option<f64>,
    #[serde(default)]
    pub window_x: Option<f64>,
    #[serde(default)]
    pub window_y: Option<f64>,
    #[serde(default)]
    pub last_file_id: Option<String>,
    #[serde(default)]
    pub last_project_id: Option<String>,
    #[serde(default)]
    pub typewriter_mode: bool,
    #[serde(default)]
    pub dry_mode: bool,
    #[serde(default)]
    pub scroll_position: Option<f64>,

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

fn default_footnote_font_size() -> u32 { 100 }
fn default_footnote_font_family() -> String { "sans-serif".to_string() }
fn default_footnote_use_colors() -> bool { true }
fn default_footnote_both_margins() -> bool { true }
fn default_dry_range() -> String { "paragraph".to_string() }
fn default_dry_stopwords() -> Vec<String> {
    vec![
        "a","an","the","in","on","at","to","for","of","with","from","by","about","as",
        "into","through","during","before","after","above","below","between","under","over",
        "against","among","upon","without","within","and","or","but","nor","yet","so","if",
        "because","while","although","though","unless","until","when","where","whether",
        "i","you","he","she","it","we","they","me","him","her","us","them","my","your",
        "his","its","our","their","mine","yours","hers","ours","theirs","this","that",
        "these","those","who","whom","whose","which","what","whoever","whatever","whichever",
        "is","are","was","were","be","been","being","have","has","had","do","does","did",
        "will","would","should","could","may","might","must","can","shall",
        "not","no","yes","all","any","some","more","most","much","many","such","very",
        "too","also","just","only","even","still","again","here","there","now","then",
        "than","how","why","well","up","down","out","off","own","same","other","another",
        "each","every","both","few","several","either","neither",
    ].into_iter().map(String::from).collect()
}
fn default_visibility() -> String { "menubar".to_string() }
fn default_appearance() -> String { "dark".to_string() }
fn default_light_theme() -> String { "ayuLight".to_string() }
fn default_dark_theme() -> String { "dracula".to_string() }
fn default_font_size() -> u32 { 20 }
fn default_line_height() -> f64 { 1.6 }
fn default_font_family() -> String { "Helvetica".to_string() }
fn default_padding() -> u32 { 50 }
fn default_column_width() -> u32 { 600 }
fn default_shortcut_open() -> String { "CmdOrCtrl+Shift+H".to_string() }
fn default_shortcut_fullscreen() -> String { "CmdOrCtrl+Shift+F".to_string() }
fn default_shortcut_private() -> String { "CmdOrCtrl+Shift+P".to_string() }
fn default_shortcut_toggle_sidebar() -> String { "Mod+\\".to_string() }
fn default_shortcut_typewriter() -> String { "Mod+T".to_string() }
fn default_shortcut_new_file() -> String { "Mod+N".to_string() }
fn default_shortcut_toggle_dry() -> String { "Mod+Shift+R".to_string() }
fn default_shortcut_find() -> String { "Mod+F".to_string() }
fn default_shortcut_find_all() -> String { "Mod+Shift+F".to_string() }
fn default_shortcut_select_sentence() -> String { "Mod+L".to_string() }
fn default_shortcut_reduce_sentence() -> String { "Mod+Shift+L".to_string() }
fn default_shortcut_select_next() -> String { "Mod+D".to_string() }
fn default_shortcut_jump_next_sentence() -> String { "Mod+ArrowRight".to_string() }
fn default_shortcut_jump_prev_sentence() -> String { "Mod+ArrowLeft".to_string() }
fn default_shortcut_next_sentence() -> String { "Mod+Shift+ArrowRight".to_string() }
fn default_shortcut_prev_sentence() -> String { "Mod+Shift+ArrowLeft".to_string() }
fn default_shortcut_move_sentence_forward() -> String { "Alt+Mod+ArrowRight".to_string() }
fn default_shortcut_move_sentence_back() -> String { "Alt+Mod+ArrowLeft".to_string() }
fn default_shortcut_select_previous() -> String { "Mod+Shift+D".to_string() }
fn default_shortcut_delete_to_sentence_end() -> String { "Alt+Shift+Backspace".to_string() }
fn default_shortcut_bold() -> String { "Mod+B".to_string() }
fn default_shortcut_italic() -> String { "Mod+I".to_string() }
fn default_shortcut_highlight() -> String { "Mod+=".to_string() }
fn default_shortcut_comment() -> String { "Mod+/".to_string() }
fn default_shortcut_insert_footnote() -> String { "Mod+Shift+M".to_string() }

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
            shortcut_toggle_dry: default_shortcut_toggle_dry(),
            shortcut_find: default_shortcut_find(),
            shortcut_find_all: default_shortcut_find_all(),
            shortcut_select_sentence: default_shortcut_select_sentence(),
            shortcut_reduce_sentence: default_shortcut_reduce_sentence(),
            shortcut_select_next: default_shortcut_select_next(),
            shortcut_jump_next_sentence: default_shortcut_jump_next_sentence(),
            shortcut_jump_prev_sentence: default_shortcut_jump_prev_sentence(),
            shortcut_next_sentence: default_shortcut_next_sentence(),
            shortcut_prev_sentence: default_shortcut_prev_sentence(),
            shortcut_move_sentence_forward: default_shortcut_move_sentence_forward(),
            shortcut_move_sentence_back: default_shortcut_move_sentence_back(),
            shortcut_select_previous: default_shortcut_select_previous(),
            shortcut_delete_to_sentence_end: default_shortcut_delete_to_sentence_end(),
            shortcut_bold: default_shortcut_bold(),
            shortcut_italic: default_shortcut_italic(),
            shortcut_highlight: default_shortcut_highlight(),
            shortcut_comment: default_shortcut_comment(),
            shortcut_insert_footnote: default_shortcut_insert_footnote(),
            dry_range: default_dry_range(),
            dry_stopwords: default_dry_stopwords(),
            dry_ignore_proper_nouns: false,
            dry_include_base_words: false,
            footnote_font_size: default_footnote_font_size(),
            footnote_font_family: default_footnote_font_family(),
            footnote_use_colors: default_footnote_use_colors(),
            footnote_both_margins: default_footnote_both_margins(),
            styles: Vec::new(),
            active_style_id: None,
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            last_file_id: None,
            last_project_id: None,
            typewriter_mode: false,
            dry_mode: false,
            scroll_position: None,
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
