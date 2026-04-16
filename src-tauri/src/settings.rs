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
    #[serde(default)]
    pub normalize_header_color: bool,
    #[serde(default = "default_true")]
    pub make_space_for_panes: bool,
    #[serde(default = "default_typewriter_line_opacity")]
    pub typewriter_line_opacity: f64,
    #[serde(default = "default_padding")]
    pub padding: u32,

    // Dropbox sync (OAuth PKCE)
    #[serde(default)]
    pub dropbox_access_token: Option<String>,
    #[serde(default)]
    pub dropbox_refresh_token: Option<String>,
    #[serde(default)]
    pub dropbox_sync_path: Option<String>, // Dropbox folder path to sync to
    #[serde(default)]
    pub dropbox_enabled: bool,
    #[serde(default)]
    pub dropbox_sync_log: Vec<String>, // Recent sync events for display

    // Legacy fields — kept for serde backward-compat (ignored)
    #[serde(default)]
    pub sync_folders: Vec<SyncFolder>,
    #[serde(default)]
    pub dropbox_token: Option<String>,

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
    #[serde(default = "default_shortcut_toggle_outline")]
    pub shortcut_toggle_outline: String,
    #[serde(default = "default_shortcut_typewriter")]
    pub shortcut_typewriter: String,
    #[serde(default = "default_shortcut_new_file")]
    pub shortcut_new_file: String,
    #[serde(default = "default_shortcut_toggle_dry")]
    pub shortcut_toggle_dry: String,
    #[serde(default = "default_shortcut_toggle_focus")]
    pub shortcut_toggle_focus: String,
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
    #[serde(default = "default_footnote_margin_side")]
    pub footnote_margin_side: String,

    // Sidebar
    #[serde(default)]
    pub hide_sidebar_tooltips: bool,
    #[serde(default)]
    pub sticky_headers: bool,

    // Styles
    #[serde(default)]
    pub styles: Vec<Style>,
    #[serde(default)]
    pub active_style_id: Option<String>,
    #[serde(default)]
    pub global_style_id: Option<String>,

    // Outline View (right sidebar)
    #[serde(default = "default_true")]
    pub longview_show_paragraphs: bool,
    #[serde(default = "default_true")]
    pub longview_show_numbers: bool,
    #[serde(default)]
    pub longview_show_comments: bool,
    #[serde(default = "default_true")]
    pub longview_show_flags: bool,
    #[serde(default)]
    pub longview_show_flag_types: bool,
    #[serde(default = "default_true")]
    pub longview_wrap_flag_text: bool,
    #[serde(default = "default_longview_body_font_size")]
    pub longview_body_font_size: u32,
    #[serde(default = "default_longview_heading_font_size")]
    pub longview_heading_font_size: u32,
    #[serde(default = "default_longview_flag_font_size")]
    pub longview_flag_font_size: u32,
    #[serde(default = "default_longview_line_gap")]
    pub longview_line_gap: u32,
    #[serde(default = "default_longview_current_position_color")]
    pub longview_current_position_color: String,

    // Flags (custom flag types and colors)
    #[serde(default = "default_flag_colors")]
    pub flag_colors: std::collections::HashMap<String, String>,
    #[serde(default = "default_custom_flags")]
    pub custom_flags: Vec<CustomFlag>,

    // Zotero integration
    #[serde(default)]
    pub zotero_api_key: Option<String>,
    #[serde(default)]
    pub zotero_user_id: Option<String>,
    #[serde(default)]
    pub zotero_last_update: Option<String>,
    #[serde(default)]
    pub zotero_reference_count: u32,
    #[serde(default)]
    pub zotero_file_size: Option<String>,
    #[serde(default = "default_shortcut_zotero")]
    pub shortcut_zotero: String,

    // Privacy mode
    #[serde(default = "default_privacy_mode")]
    pub privacy_mode: String,
    #[serde(default)]
    pub dummy_text: String,

    // Block cursor
    #[serde(default)]
    pub block_cursor: bool,
    #[serde(default)]
    pub block_cursor_color: Option<String>,

    // Extra shortcuts
    #[serde(default = "default_shortcut_strikethrough")]
    pub shortcut_strikethrough: String,
    #[serde(default = "default_shortcut_select_paragraph")]
    pub shortcut_select_paragraph: String,
    #[serde(default = "default_shortcut_save")]
    pub shortcut_save: String,
    #[serde(default = "default_shortcut_find_next")]
    pub shortcut_find_next: String,
    #[serde(default = "default_shortcut_find_prev")]
    pub shortcut_find_prev: String,
    #[serde(default = "default_shortcut_join_lines")]
    pub shortcut_join_lines: String,
    #[serde(default = "default_shortcut_jump_next_paragraph")]
    pub shortcut_jump_next_paragraph: String,
    #[serde(default = "default_shortcut_jump_prev_paragraph")]
    pub shortcut_jump_prev_paragraph: String,

    // Style shortcuts (Cmd+1 = Default, Cmd+2..5 = first 4 user styles)
    #[serde(default = "default_shortcut_style_default")]
    pub shortcut_style_default: String,
    #[serde(default = "default_shortcut_style_1")]
    pub shortcut_style1: String,
    #[serde(default = "default_shortcut_style_2")]
    pub shortcut_style2: String,
    #[serde(default = "default_shortcut_style_3")]
    pub shortcut_style3: String,
    #[serde(default = "default_shortcut_style_4")]
    pub shortcut_style4: String,

    // Ratchet mode
    #[serde(default)]
    pub ratchet_encourage_typing: bool,

    // Notebook settings
    #[serde(default = "default_notebook_appearance")]
    pub notebook_appearance_mode: String,
    #[serde(default = "default_notebook_theme")]
    pub notebook_theme_id: String,
    #[serde(default = "default_notebook_bg_pattern")]
    pub notebook_background_pattern: String,
    #[serde(default = "default_notebook_grid_spacing")]
    pub notebook_grid_spacing: u32,
    #[serde(default = "default_notebook_grid_opacity")]
    pub notebook_grid_opacity: f64,
    #[serde(default = "default_notebook_font_family")]
    pub notebook_font_family: String,
    #[serde(default = "default_notebook_font_size")]
    pub notebook_font_size: u32,
    #[serde(default)]
    pub last_notebook_id: Option<String>,

    // Notebook shortcuts
    #[serde(default = "default_nb_select")]
    pub shortcut_nb_select: String,
    #[serde(default = "default_nb_text")]
    pub shortcut_nb_text: String,
    #[serde(default = "default_nb_drag_area")]
    pub shortcut_nb_drag_area: String,
    #[serde(default = "default_nb_brainstorm")]
    pub shortcut_nb_brainstorm: String,
    #[serde(default = "default_nb_delete")]
    pub shortcut_nb_delete: String,
    #[serde(default = "default_nb_undo")]
    pub shortcut_nb_undo: String,
    #[serde(default = "default_nb_redo")]
    pub shortcut_nb_redo: String,
    #[serde(default = "default_nb_group")]
    pub shortcut_nb_group: String,
    #[serde(default = "default_nb_ungroup")]
    pub shortcut_nb_ungroup: String,

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
    #[serde(default)]
    pub light_theme_id: Option<String>,
    #[serde(default)]
    pub dark_theme_id: Option<String>,
    #[serde(default)]
    pub light_colors: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub dark_colors: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub block_cursor: Option<bool>,
    #[serde(default)]
    pub block_cursor_color: Option<String>,
    #[serde(default)]
    pub suppress_header_size: Option<bool>,
    #[serde(default)]
    pub suppress_header_color: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFlag {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolder {
    pub id: String,
    pub path: String,
    pub sync_type: String, // "local" or "dropbox"
    pub name: String,
}

fn default_flag_colors() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert("TODO".to_string(), "#ffd700".to_string());
    m.insert("MISSING".to_string(), "#ff4444".to_string());
    m.insert("COMMENT".to_string(), "#888888".to_string());
    m.insert("REWRITE".to_string(), "#ff66aa".to_string());
    m.insert("RESEARCH".to_string(), "#66aaff".to_string());
    m
}

fn default_custom_flags() -> Vec<CustomFlag> {
    vec![
        CustomFlag {
            name: "REWRITE".to_string(),
            color: "#ff66aa".to_string(),
        },
        CustomFlag {
            name: "RESEARCH".to_string(),
            color: "#66aaff".to_string(),
        },
    ]
}

fn default_footnote_font_size() -> u32 {
    100
}
fn default_footnote_font_family() -> String {
    "sans-serif".to_string()
}
fn default_footnote_use_colors() -> bool {
    true
}
fn default_footnote_both_margins() -> bool {
    true
}
fn default_footnote_margin_side() -> String {
    "closest".to_string()
}
fn default_dry_range() -> String {
    "paragraph".to_string()
}
fn default_dry_stopwords() -> Vec<String> {
    "a an the in on at to for of with from by about as into through during before after \
     above below between under over against among upon without within and or but nor yet \
     so if because while although though unless until when where whether i you he she it \
     we they me him her us them my your his its our their mine yours hers ours theirs \
     this that these those who whom whose which what whoever whatever whichever is are \
     was were be been being have has had do does did will would should could may might \
     must can shall not no yes all any some more most much many such very too also just \
     only even still again here there now then than how why well up down out off own \
     same other another each every both few several either neither"
        .split_whitespace()
        .map(String::from)
        .collect()
}
fn default_true() -> bool {
    true
}
fn default_longview_body_font_size() -> u32 {
    3
}
fn default_longview_heading_font_size() -> u32 {
    12
}
fn default_longview_flag_font_size() -> u32 {
    12
}
fn default_longview_line_gap() -> u32 {
    2
}
fn default_longview_current_position_color() -> String {
    "#ff0000".to_string()
}
fn default_visibility() -> String {
    "menubar".to_string()
}
fn default_appearance() -> String {
    "dark".to_string()
}
fn default_light_theme() -> String {
    "ayuLight".to_string()
}
fn default_dark_theme() -> String {
    "dracula".to_string()
}
fn default_font_size() -> u32 {
    20
}
fn default_line_height() -> f64 {
    1.6
}
fn default_font_family() -> String {
    "Source Sans Pro".to_string()
}
fn default_padding() -> u32 {
    50
}
fn default_column_width() -> u32 {
    600
}
fn default_shortcut_open() -> String {
    "CmdOrCtrl+Shift+H".to_string()
}
fn default_shortcut_fullscreen() -> String {
    "CmdOrCtrl+Shift+F".to_string()
}
fn default_shortcut_private() -> String {
    "CmdOrCtrl+Shift+P".to_string()
}
fn default_shortcut_toggle_sidebar() -> String {
    "CmdOrCtrl+\\".to_string()
}
fn default_shortcut_toggle_outline() -> String {
    "CmdOrCtrl+Shift+\\".to_string()
}
fn default_shortcut_typewriter() -> String {
    "Mod+Shift+T".to_string()
}
fn default_shortcut_new_file() -> String {
    "Mod+N".to_string()
}
fn default_shortcut_toggle_dry() -> String {
    "Mod+Shift+R".to_string()
}
fn default_shortcut_toggle_focus() -> String {
    "Mod+Shift+Y".to_string()
}
fn default_shortcut_find() -> String {
    "Mod+F".to_string()
}
fn default_shortcut_find_all() -> String {
    "Mod+Shift+F".to_string()
}
fn default_shortcut_select_sentence() -> String {
    "Mod+L".to_string()
}
fn default_shortcut_reduce_sentence() -> String {
    "Alt+Shift+L".to_string()
}
fn default_shortcut_select_next() -> String {
    "Mod+D".to_string()
}
fn default_shortcut_jump_next_sentence() -> String {
    "Mod+ArrowRight".to_string()
}
fn default_shortcut_jump_prev_sentence() -> String {
    "Mod+ArrowLeft".to_string()
}
fn default_shortcut_next_sentence() -> String {
    "Mod+Shift+ArrowRight".to_string()
}
fn default_shortcut_prev_sentence() -> String {
    "Mod+Shift+ArrowLeft".to_string()
}
fn default_shortcut_move_sentence_forward() -> String {
    "Alt+Mod+ArrowRight".to_string()
}
fn default_shortcut_move_sentence_back() -> String {
    "Alt+Mod+ArrowLeft".to_string()
}
fn default_shortcut_select_previous() -> String {
    "Mod+Shift+D".to_string()
}
fn default_shortcut_delete_to_sentence_end() -> String {
    "Alt+Shift+Backspace".to_string()
}
fn default_shortcut_bold() -> String {
    "Mod+B".to_string()
}
fn default_shortcut_italic() -> String {
    "Mod+I".to_string()
}
fn default_shortcut_highlight() -> String {
    "Mod+=".to_string()
}
fn default_shortcut_comment() -> String {
    "Mod+/".to_string()
}
fn default_shortcut_insert_footnote() -> String {
    "Mod+Shift+M".to_string()
}
fn default_typewriter_line_opacity() -> f64 {
    0.08
}
fn default_shortcut_zotero() -> String {
    "Mod+Shift+I".to_string()
}
fn default_shortcut_strikethrough() -> String {
    "Mod+`".to_string()
}
fn default_shortcut_select_paragraph() -> String {
    "Mod+Shift+L".to_string()
}
fn default_shortcut_save() -> String {
    "Mod+S".to_string()
}
fn default_shortcut_find_next() -> String {
    "Mod+G".to_string()
}
fn default_shortcut_find_prev() -> String {
    "Mod+Shift+G".to_string()
}
fn default_shortcut_join_lines() -> String {
    "Mod+J".to_string()
}
fn default_shortcut_jump_next_paragraph() -> String {
    "Mod+ArrowDown".to_string()
}
fn default_shortcut_jump_prev_paragraph() -> String {
    "Mod+ArrowUp".to_string()
}
fn default_shortcut_style_default() -> String {
    "Mod+1".to_string()
}
fn default_shortcut_style_1() -> String {
    "Mod+2".to_string()
}
fn default_shortcut_style_2() -> String {
    "Mod+3".to_string()
}
fn default_shortcut_style_3() -> String {
    "Mod+4".to_string()
}
fn default_shortcut_style_4() -> String {
    "Mod+5".to_string()
}
fn default_privacy_mode() -> String {
    "blackout".to_string()
}
fn default_notebook_appearance() -> String {
    "light".to_string()
}
fn default_notebook_theme() -> String {
    "default".to_string()
}
fn default_notebook_bg_pattern() -> String {
    "dot-grid".to_string()
}
fn default_notebook_grid_spacing() -> u32 {
    25
}
fn default_notebook_grid_opacity() -> f64 {
    0.15
}
fn default_notebook_font_family() -> String {
    "Inter".to_string()
}
fn default_notebook_font_size() -> u32 {
    18
}
fn default_nb_select() -> String { "1".to_string() }
fn default_nb_text() -> String { "T".to_string() }
fn default_nb_drag_area() -> String { "A".to_string() }
fn default_nb_brainstorm() -> String { "B".to_string() }
fn default_nb_delete() -> String { "Backspace".to_string() }
fn default_nb_undo() -> String { "Mod+Z".to_string() }
fn default_nb_redo() -> String { "Mod+Shift+Z".to_string() }
fn default_nb_group() -> String { "Mod+G".to_string() }
fn default_nb_ungroup() -> String { "Mod+Shift+G".to_string() }

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
            normalize_header_color: false,
            make_space_for_panes: true,
            typewriter_line_opacity: default_typewriter_line_opacity(),
            padding: default_padding(),
            dropbox_access_token: None,
            dropbox_refresh_token: None,
            dropbox_sync_path: None,
            dropbox_enabled: false,
            dropbox_sync_log: Vec::new(),
            sync_folders: Vec::new(),
            dropbox_token: None,
            always_on_top: false,
            column_width: default_column_width(),
            shortcut_open_editor: default_shortcut_open(),
            shortcut_open_fullscreen: default_shortcut_fullscreen(),
            shortcut_toggle_private: default_shortcut_private(),
            shortcut_toggle_sidebar: default_shortcut_toggle_sidebar(),
            shortcut_toggle_outline: default_shortcut_toggle_outline(),
            shortcut_typewriter: default_shortcut_typewriter(),
            shortcut_new_file: default_shortcut_new_file(),
            shortcut_toggle_dry: default_shortcut_toggle_dry(),
            shortcut_toggle_focus: default_shortcut_toggle_focus(),
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
            footnote_margin_side: default_footnote_margin_side(),
            hide_sidebar_tooltips: false,
            sticky_headers: false,
            styles: Vec::new(),
            active_style_id: None,
            global_style_id: None,
            longview_show_paragraphs: true,
            longview_show_numbers: true,
            longview_show_comments: false,
            longview_show_flags: true,
            longview_show_flag_types: false,
            longview_wrap_flag_text: true,
            longview_body_font_size: default_longview_body_font_size(),
            longview_heading_font_size: default_longview_heading_font_size(),
            longview_flag_font_size: default_longview_flag_font_size(),
            longview_line_gap: default_longview_line_gap(),
            longview_current_position_color: default_longview_current_position_color(),
            flag_colors: default_flag_colors(),
            custom_flags: default_custom_flags(),
            zotero_api_key: None,
            zotero_user_id: None,
            zotero_last_update: None,
            zotero_reference_count: 0,
            zotero_file_size: None,
            shortcut_zotero: default_shortcut_zotero(),
            shortcut_strikethrough: default_shortcut_strikethrough(),
            shortcut_select_paragraph: default_shortcut_select_paragraph(),
            shortcut_save: default_shortcut_save(),
            shortcut_find_next: default_shortcut_find_next(),
            shortcut_find_prev: default_shortcut_find_prev(),
            shortcut_join_lines: default_shortcut_join_lines(),
            shortcut_jump_next_paragraph: default_shortcut_jump_next_paragraph(),
            shortcut_jump_prev_paragraph: default_shortcut_jump_prev_paragraph(),
            shortcut_style_default: default_shortcut_style_default(),
            shortcut_style1: default_shortcut_style_1(),
            shortcut_style2: default_shortcut_style_2(),
            shortcut_style3: default_shortcut_style_3(),
            shortcut_style4: default_shortcut_style_4(),
            privacy_mode: default_privacy_mode(),
            dummy_text: String::new(),
            block_cursor: false,
            block_cursor_color: None,
            ratchet_encourage_typing: false,
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            last_file_id: None,
            last_project_id: None,
            typewriter_mode: false,
            dry_mode: false,
            scroll_position: None,
            notebook_appearance_mode: default_notebook_appearance(),
            notebook_theme_id: default_notebook_theme(),
            notebook_background_pattern: default_notebook_bg_pattern(),
            notebook_grid_spacing: default_notebook_grid_spacing(),
            notebook_grid_opacity: default_notebook_grid_opacity(),
            notebook_font_family: default_notebook_font_family(),
            notebook_font_size: default_notebook_font_size(),
            last_notebook_id: None,
            shortcut_nb_select: default_nb_select(),
            shortcut_nb_text: default_nb_text(),
            shortcut_nb_drag_area: default_nb_drag_area(),
            shortcut_nb_brainstorm: default_nb_brainstorm(),
            shortcut_nb_delete: default_nb_delete(),
            shortcut_nb_undo: default_nb_undo(),
            shortcut_nb_redo: default_nb_redo(),
            shortcut_nb_group: default_nb_group(),
            shortcut_nb_ungroup: default_nb_ungroup(),
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
