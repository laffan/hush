use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::atomic::write_atomic_str;

mod defaults;
mod types;
use defaults::*;
pub use types::{Style, ShaderLayer, CustomFlag, SyncFolder, GoogleDocLink};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    // General
    #[serde(default = "default_visibility")]
    pub visibility: String,

    // Editor > Appearance
    #[serde(default = "default_appearance")]
    pub appearance: String,

    // iOS-only on-screen touch buttons (Cmd + command-palette)
    #[serde(default)]
    pub touch_mode: bool,

    // iPad-only — hide the system top status bar (time/battery/wifi) and
    // the Stage-Manager corner resize handle. Defaults to true. The
    // toggle only surfaces in the iPad settings UI.
    #[serde(default = "default_true")]
    pub hide_system_chrome: bool,

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
    #[serde(default)]
    pub underline_headers: bool,
    #[serde(default = "default_header_scale")]
    pub header_scale: f64,
    // Default-style color overrides (bg/fg/header/cursor/selection) per appearance
    #[serde(default)]
    pub default_light_colors: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub default_dark_colors: std::collections::HashMap<String, String>,
    #[serde(default = "default_true")]
    pub make_space_for_panes: bool,
    #[serde(default = "default_make_space_direction")]
    pub make_space_direction: String,
    #[serde(default)]
    pub make_space_column_offset: f64,
    #[serde(default = "default_typewriter_line_opacity")]
    pub typewriter_line_opacity: f64,
    #[serde(default = "default_comment_opacity")]
    pub comment_opacity: f64,
    #[serde(default = "default_focus_mode_opacity")]
    pub focus_mode_opacity: f64,
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

    // Google Docs (OAuth PKCE) — per-document link, no auto-sync.
    // The user explicitly drives push/pull from a link bar; tokens live
    // here, per-doc links live in a sibling map (`google_doc_links`).
    // Client credentials live here too (entered in Settings > Sync >
    // Google Sync) so each user supplies their own OAuth client rather
    // than embedding one at build time.
    #[serde(default)]
    pub google_client_id: Option<String>,
    #[serde(default)]
    pub google_client_secret: Option<String>,
    #[serde(default)]
    pub google_access_token: Option<String>,
    #[serde(default)]
    pub google_refresh_token: Option<String>,
    #[serde(default)]
    pub google_token_expires_at: Option<i64>, // unix seconds
    #[serde(default)]
    pub google_account_email: Option<String>,
    #[serde(default)]
    pub google_doc_links: std::collections::HashMap<String, GoogleDocLink>,
    #[serde(default)]
    pub google_sync_log: Vec<String>,

    // Legacy fields — kept for serde backward-compat (ignored)
    #[serde(default)]
    pub sync_folders: Vec<SyncFolder>,
    #[serde(default)]
    pub dropbox_token: Option<String>,

    // Local Sync (desktop-only) — mounted folders reflected live in the
    // sidebar. Writes go straight to disk; unsyncing is non-destructive.
    #[serde(default)]
    pub local_sync_folders: Vec<crate::local_sync::LocalSyncFolder>,

    // Window
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_column_width")]
    pub column_width: u32,
    #[serde(default)]
    pub zen_column_width: Option<u32>,
    #[serde(default = "default_sidebar_panel_width")]
    pub sidebar_panel_width: u32,
    // Sidebar session state — which panel was open ("files" / "styles"
    // / "versions") and whether it was pinned when the app last quit.
    // Per-window in the JS sense, but the Tauri side stores them
    // alongside the rest of the settings JSON; the multi-window code
    // already overlays per-window keys back from disk on shared writes.
    #[serde(default)]
    pub sidebar_open_panel: Option<String>,
    #[serde(default)]
    pub sidebar_pinned: bool,

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
    #[serde(default = "default_shortcut_toggle_word_count")]
    pub shortcut_toggle_word_count: String,
    #[serde(default = "default_shortcut_zen_focus")]
    pub shortcut_zen_focus: String,
    #[serde(default = "default_zen_focus_font_size")]
    pub zen_focus_font_size: u32,
    #[serde(default)]
    pub word_count_visible: bool,
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

    // Sidebar / global tooltips. Default off — when on, native browser
    // tooltips are shown on sidebar, pane header, and notebook toolbar
    // buttons. Renamed from `hide_sidebar_tooltips` (an inverted flag);
    // serde alias preserves any legacy persisted value as a true→false
    // conversion would be incorrect anyway, so we just drop the old key.
    #[serde(default)]
    pub show_tooltips: bool,
    #[serde(default)]
    pub sticky_headers: bool,

    // Styles
    #[serde(default)]
    pub styles: Vec<Style>,
    #[serde(default)]
    pub active_style_id: Option<String>,
    #[serde(default)]
    pub global_style_id: Option<String>,

    // Shader layer attached to the Default style. User styles carry
    // their own shaderLayer field on the Style struct itself.
    #[serde(default)]
    pub shader_layer: Option<ShaderLayer>,

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
    #[serde(default = "default_zotero_snapshot_render_height")]
    pub zotero_snapshot_render_height: u32,
    #[serde(default = "default_zotero_snapshot_display_height")]
    pub zotero_snapshot_display_height: u32,
    #[serde(default = "default_zotero_snapshot_quality")]
    pub zotero_snapshot_quality: u32,

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
    /// Max width for text shapes on the notebook canvas (px). Drives
    /// both the inline editor's wrap width and brainstorm-mode card
    /// sizing — every newly-created text shape clamps to this value.
    #[serde(default = "default_notebook_text_max_width")]
    pub notebook_text_max_width: u32,
    #[serde(default = "default_notebook_shelf_width")]
    pub notebook_shelf_width: u32,
    /// Routing mode for flowchart arrows on the notebook canvas. Either
    /// "closest" (pick the nearest pair of cardinal edges) or "horizontal"
    /// (always exit the parent's right side and enter the child's left).
    #[serde(default = "default_flow_connect_mode")]
    pub flow_connect_mode: String,
    /// User-saved text-style presets for notebook text shapes. Each entry
    /// is `{ id, color, backgroundColor, fontSize }`. Stored as opaque JSON
    /// so the JS side owns the shape.
    #[serde(default)]
    pub notebook_text_styles: Vec<serde_json::Value>,
    #[serde(default)]
    pub last_notebook_id: Option<String>,
    /// Legacy single-slot "desktop" pin (a thumbnail at the bottom of
    /// the files panel). The feature is gone — replaced by per-row
    /// pane indicators driven by `panes_hidden_by_context` — but the
    /// field stays in the struct so existing settings.json files keep
    /// parsing on first launch. Always serialized as null; the JS side
    /// ignores it.
    #[serde(default, alias = "deskFileId")]
    pub desktop_file_id: Option<String>,
    /// Notebook-only floating minimap widget. Off by default; toggled
    /// via the command palette. Persisted so the user's choice rides
    /// across restarts.
    #[serde(default)]
    pub minimap_visible: bool,
    /// "Desks" — top-level containers above all other tree nodes.
    /// Always-on; the field is retained as a deprecated boolean so
    /// settings.json files written by older builds still parse, but
    /// the JS side ignores its value and treats desks as structural.
    #[serde(default = "default_true")]
    pub use_desks: bool,
    /// Desk list. Each entry is opaque JSON `{ id, name, createdAt }`.
    /// Always carries at least one entry once the boot migration runs;
    /// fresh installs see the JS layer seed a default "Personal" desk
    /// before any file operations land.
    #[serde(default)]
    pub desks: Vec<serde_json::Value>,
    /// Per-desk synced metadata, keyed by desk id. Opaque JSON so the
    /// JS side owns the shape — typical fields: active style, last
    /// opened file, persisted panes.
    #[serde(default)]
    pub desks_meta: serde_json::Value,
    /// Active desk id for this device. Null when desks are off.
    #[serde(default)]
    pub active_desk_id: Option<String>,

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

    // Persisted panes — restored on app open. Shape is opaque to Rust;
    // JS serializes/deserializes the list of pane objects.
    #[serde(default)]
    pub persisted_panes: Vec<serde_json::Value>,

    /// Per-context "panes are hidden" flags, keyed by `pane.ownerContext`
    /// (`doc:<id>` / `nb:<id>` / `pj:<id>`). Each truthy entry means the
    /// corresponding doc/notebook is in "file" mode — panes that would
    /// normally participate in that context stay off-screen until the
    /// flag is cleared via the command palette's **Show panes** entry.
    /// Rides cross-device alongside the panes themselves (see
    /// `serializePanesForSync` / `applyRemotePanes`): the JS layer
    /// translates each local-id key to its Dropbox `remoteId` and
    /// embeds a `hiddenOwners` list in `.hush/panes.json`. Local-Sync /
    /// project contexts have no cross-device identity so their entries
    /// stay per-device.
    #[serde(default)]
    pub panes_hidden_by_context: serde_json::Value,

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
    pub last_stack_id: Option<String>,
    #[serde(default)]
    pub typewriter_mode: bool,
    #[serde(default)]
    pub dry_mode: bool,
    #[serde(default)]
    pub scroll_position: Option<f64>,

    // Proofread mode — harper-core toggle. The mode flag itself is
    // *not* persisted (each session starts with proofread off, so the
    // cold-start dictionary build doesn't gate startup); only the
    // per-rule disable list round-trips. `proofread_disabled_rules`
    // carries the harper rule names (e.g. "LongSentences") that the
    // user has switched off in the Proofread settings tab; the JS
    // frontend forwards it on every `check_grammar` call.
    #[serde(default = "default_proofread_disabled_rules")]
    pub proofread_disabled_rules: Vec<String>,

    #[serde(skip)]
    pub data_dir: PathBuf,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            visibility: default_visibility(),
            appearance: default_appearance(),
            touch_mode: false,
            hide_system_chrome: true,
            light_theme: default_light_theme(),
            dark_theme: default_dark_theme(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            font_family: default_font_family(),
            normalize_headers: false,
            normalize_header_color: false,
            underline_headers: false,
            header_scale: default_header_scale(),
            default_light_colors: std::collections::HashMap::new(),
            default_dark_colors: std::collections::HashMap::new(),
            make_space_for_panes: true,
            make_space_direction: default_make_space_direction(),
            make_space_column_offset: 0.0,
            typewriter_line_opacity: default_typewriter_line_opacity(),
            comment_opacity: default_comment_opacity(),
            focus_mode_opacity: default_focus_mode_opacity(),
            padding: default_padding(),
            dropbox_access_token: None,
            dropbox_refresh_token: None,
            dropbox_sync_path: None,
            dropbox_enabled: false,
            dropbox_sync_log: Vec::new(),
            google_client_id: None,
            google_client_secret: None,
            google_access_token: None,
            google_refresh_token: None,
            google_token_expires_at: None,
            google_account_email: None,
            google_doc_links: std::collections::HashMap::new(),
            google_sync_log: Vec::new(),
            sync_folders: Vec::new(),
            dropbox_token: None,
            local_sync_folders: Vec::new(),
            always_on_top: false,
            column_width: default_column_width(),
            zen_column_width: None,
            sidebar_panel_width: default_sidebar_panel_width(),
            sidebar_open_panel: None,
            sidebar_pinned: false,
            shortcut_open_editor: default_shortcut_open(),
            shortcut_open_fullscreen: default_shortcut_fullscreen(),
            shortcut_toggle_private: default_shortcut_private(),
            shortcut_toggle_sidebar: default_shortcut_toggle_sidebar(),
            shortcut_toggle_outline: default_shortcut_toggle_outline(),
            shortcut_typewriter: default_shortcut_typewriter(),
            shortcut_new_file: default_shortcut_new_file(),
            shortcut_toggle_dry: default_shortcut_toggle_dry(),
            shortcut_toggle_focus: default_shortcut_toggle_focus(),
            shortcut_toggle_word_count: default_shortcut_toggle_word_count(),
            shortcut_zen_focus: default_shortcut_zen_focus(),
            zen_focus_font_size: default_zen_focus_font_size(),
            word_count_visible: false,
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
            show_tooltips: false,
            sticky_headers: false,
            styles: Vec::new(),
            active_style_id: None,
            global_style_id: None,
            shader_layer: None,
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
            zotero_snapshot_render_height: default_zotero_snapshot_render_height(),
            zotero_snapshot_display_height: default_zotero_snapshot_display_height(),
            zotero_snapshot_quality: default_zotero_snapshot_quality(),
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
            persisted_panes: Vec::new(),
            panes_hidden_by_context: serde_json::json!({}),
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            last_file_id: None,
            last_project_id: None,
            last_stack_id: None,
            typewriter_mode: false,
            dry_mode: false,
            scroll_position: None,
            proofread_disabled_rules: default_proofread_disabled_rules(),
            notebook_appearance_mode: default_notebook_appearance(),
            notebook_theme_id: default_notebook_theme(),
            notebook_background_pattern: default_notebook_bg_pattern(),
            notebook_grid_spacing: default_notebook_grid_spacing(),
            notebook_grid_opacity: default_notebook_grid_opacity(),
            notebook_font_family: default_notebook_font_family(),
            notebook_font_size: default_notebook_font_size(),
            notebook_text_max_width: default_notebook_text_max_width(),
            notebook_shelf_width: default_notebook_shelf_width(),
            flow_connect_mode: default_flow_connect_mode(),
            notebook_text_styles: Vec::new(),
            last_notebook_id: None,
            desktop_file_id: None,
            minimap_visible: false,
            use_desks: true,
            desks: Vec::new(),
            desks_meta: serde_json::json!({}),
            active_desk_id: None,
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
        write_atomic_str(&path, &content)?;
        Ok(())
    }
}
