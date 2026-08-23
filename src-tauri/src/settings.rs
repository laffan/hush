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

    // Persistent sync-adjacent activity log (Settings > Sync > Log) —
    // Local Folder / desk reconcile activity and background-task errors.
    #[serde(default)]
    pub sync_log: Vec<String>,

    // Google Docs (OAuth PKCE) — per-document link, no auto-sync. Tokens
    // and per-doc links (`google_doc_links`) live here, as do the client
    // credentials (entered in Settings > Sync > Google Sync) so each user
    // supplies their own OAuth client rather than embedding one at build.
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

    // Local Sync (desktop-only) — mounted folders reflected live in the
    // sidebar. Writes go straight to disk; unsyncing is non-destructive.
    #[serde(default)]
    pub local_sync_folders: Vec<crate::local_sync::LocalSyncFolder>,

    // Sidebar folder collapse state. `collapsed_folder_ids` is Option so
    // the frontend tells "never set" (first-run defaults) from "set empty".
    #[serde(default)]
    pub collapsed_folder_ids: Option<Vec<String>>,
    #[serde(default)]
    pub local_sync_expanded: Vec<String>,

    // Window
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_column_width")]
    pub column_width: u32,
    #[serde(default)]
    pub zen_column_width: Option<u32>,
    #[serde(default = "default_sidebar_panel_width")]
    pub sidebar_panel_width: u32,
    // The document's right-hand bars — the outline and the Google-Docs
    // comments list — each drag-resizable from its inboard edge.
    #[serde(default = "default_outline_panel_width")]
    pub outline_panel_width: u32,
    #[serde(default = "default_comments_panel_width")]
    pub comments_panel_width: u32,
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
    #[serde(default = "default_shortcut_open")] pub shortcut_open_editor: String,
    #[serde(default = "default_shortcut_fullscreen")] pub shortcut_open_fullscreen: String,
    #[serde(default = "default_shortcut_private")] pub shortcut_toggle_private: String,
    #[serde(default = "default_shortcut_toggle_sidebar")] pub shortcut_toggle_sidebar: String,
    #[serde(default = "default_shortcut_toggle_outline")] pub shortcut_toggle_outline: String,
    #[serde(default = "default_shortcut_typewriter")] pub shortcut_typewriter: String,
    #[serde(default = "default_shortcut_new_file")] pub shortcut_new_file: String,
    #[serde(default = "default_shortcut_new_file_pane")] pub shortcut_new_file_pane: String,
    #[serde(default = "default_shortcut_new_notebook")] pub shortcut_new_notebook: String,
    #[serde(default = "default_shortcut_new_notebook_pane")] pub shortcut_new_notebook_pane: String,
    #[serde(default = "default_shortcut_shuffle_sentences")] pub shortcut_shuffle_sentences: String,
    #[serde(default = "default_shortcut_toggle_dry")]
    pub shortcut_toggle_dry: String,
    #[serde(default = "default_shortcut_toggle_focus")]
    pub shortcut_toggle_focus: String,
    #[serde(default = "default_shortcut_toggle_word_count")]
    pub shortcut_toggle_word_count: String,
    #[serde(default = "default_shortcut_toggle_properties")]
    pub shortcut_toggle_properties: String,
    #[serde(default = "default_shortcut_zen_focus")]
    pub shortcut_zen_focus: String,
    #[serde(default = "default_zen_focus_font_size")]
    pub zen_focus_font_size: u32,
    #[serde(default = "default_selection_focus_font_multiplier")]
    pub selection_focus_font_multiplier: f32,
    #[serde(default)]
    pub word_count_visible: bool,
    #[serde(default = "default_shortcut_find")]
    pub shortcut_find: String,
    #[serde(default = "default_shortcut_quick_find")] pub shortcut_quick_find: String,
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
    // tooltips show on sidebar, pane header, and notebook toolbar buttons.
    #[serde(default)]
    pub show_tooltips: bool,
    #[serde(default)]
    pub sticky_headers: bool,
    #[serde(default)]
    pub show_recent_files: bool,
    #[serde(default = "default_recent_files_panel_height")]
    pub recent_files_panel_height: u32,
    /// Sidebar file browser: list every doc's markdown headings as
    /// indented child rows (command palette: Show / Hide Project Headings).
    #[serde(default)]
    pub show_project_headings: bool,
    /// Legacy flat MRU. Superseded by `recent_file_ids_by_desk`; kept so
    /// installs written by older builds still parse, and so the per-desk
    /// map can seed itself from it the first time a desk is read.
    #[serde(default)]
    pub recent_file_ids: Vec<String>,
    /// Per-desk MRU of recently-opened fileIds, keyed by desk id. Opaque
    /// JSON owned by the JS side (`{ [deskId]: [fileId, …] }`).
    #[serde(default)]
    pub recent_file_ids_by_desk: serde_json::Value,

    // Styles
    #[serde(default)] pub styles: Vec<Style>,
    #[serde(default)] pub active_style_id: Option<String>,
    #[serde(default)] pub global_style_id: Option<String>,
    // Filenames of bundled style presets already seeded into `styles`.
    #[serde(default)] pub seeded_preset_files: Vec<String>,

    // Retired single-overlay post processing for the Default style.
    // Kept so an older install still derives its post layers on read.
    #[serde(default)]
    pub shader_layer: Option<ShaderLayer>,

    // Post-processing layers attached to the Default style (user styles
    // carry their own postLayers field). Opaque JSON — JS owns the shape.
    #[serde(default)]
    pub post_layers: Option<serde_json::Value>,
    // Section-level on/off for the Default style's post stack. `None`
    // reads as enabled.
    #[serde(default)]
    pub post_processing_enabled: Option<bool>,

    // Background layers attached to the Default style (user styles carry
    // their own backgroundLayers field). Opaque JSON — JS owns the shape.
    #[serde(default)]
    pub background_layers: Option<serde_json::Value>,
    // Section-level on/off for the Default style's layer stack. `None`
    // reads as enabled.
    #[serde(default)]
    pub background_layers_enabled: Option<bool>,

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
    pub longview_body_font_size: f64,
    #[serde(default = "default_longview_heading_font_size")]
    pub longview_heading_font_size: u32,
    #[serde(default = "default_longview_flag_font_size")]
    pub longview_flag_font_size: u32,
    #[serde(default = "default_longview_line_gap")]
    pub longview_line_gap: f64,
    #[serde(default = "default_longview_current_position_color")]
    pub longview_current_position_color: String,

    // Flags (custom flag types and colors)
    #[serde(default = "default_flag_colors")]
    pub flag_colors: std::collections::HashMap<String, String>,
    #[serde(default = "default_custom_flags")]
    pub custom_flags: Vec<CustomFlag>,

    // Zotero integration
    #[serde(default)] pub zotero_api_key: Option<String>,
    #[serde(default)] pub zotero_user_id: Option<String>,
    #[serde(default)] pub zotero_last_update: Option<String>,
    #[serde(default)] pub zotero_reference_count: u32,
    #[serde(default)] pub zotero_file_size: Option<String>,
    #[serde(default = "default_shortcut_zotero")] pub shortcut_zotero: String,
    #[serde(default = "default_shortcut_switch_desks")] pub shortcut_switch_desks: String,
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

    // Block cursor + cursor mode (system / block / underline).
    // `cursor_mode` is the primary signal; `block_cursor` stays in
    // lockstep for backwards-compat with older clients on the same JSON.
    #[serde(default)] pub block_cursor: bool,
    #[serde(default)] pub block_cursor_color: Option<String>,
    #[serde(default)] pub cursor_mode: Option<String>,

    // Default style's active-line indicator. Per-style overrides live
    // on `Style.line_indicator`. The indicator colour rides per
    // appearance on `default_light_colors` / `default_dark_colors`
    // under the `lineIndicator` key — no dedicated AppSettings field.
    #[serde(default)] pub line_indicator: Option<String>,

    // Extra shortcuts
    #[serde(default = "default_shortcut_strikethrough")]
    pub shortcut_strikethrough: String,
    #[serde(default = "default_shortcut_select_paragraph")]
    pub shortcut_select_paragraph: String,
    #[serde(default = "default_shortcut_select_paragraph_up")] pub shortcut_select_paragraph_up: String,
    #[serde(default = "default_shortcut_select_paragraph_down")] pub shortcut_select_paragraph_down: String,
    #[serde(default = "default_shortcut_save")]
    pub shortcut_save: String,
    #[serde(default = "default_shortcut_find_next")]
    pub shortcut_find_next: String,
    #[serde(default = "default_shortcut_find_prev")]
    pub shortcut_find_prev: String,
    #[serde(default = "default_shortcut_join_lines")]
    pub shortcut_join_lines: String,
    #[serde(default = "default_shortcut_join_lines_up")]
    pub shortcut_join_lines_up: String,
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
    #[serde(default = "default_notebook_proof_rail_width")]
    pub notebook_proof_rail_width: u32,
    /// Is the proofread notebook's page rail on screen? App-wide rather
    /// than per-notebook: it's a reading preference, like the shelf's
    /// width, not something a proof carries with it.
    #[serde(default = "default_true")]
    pub notebook_proof_rail_visible: bool,
    /// Where the proofread scroll wheel was last parked, as an offset
    /// from the top-left of whichever box hosts the canvas. `None` means
    /// "never moved" — the wheel takes its default corner. Absolute px
    /// rather than a fraction because the wheel is a fixed-size control:
    /// the JS side clamps it back inside a host that has since shrunk.
    #[serde(default)]
    pub notebook_proof_wheel_x: Option<f64>,
    #[serde(default)]
    pub notebook_proof_wheel_y: Option<f64>,
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
    /// Legacy single-slot "desktop" pin (replaced by per-row pane
    /// indicators driven by `panes_hidden_by_context`). Retained only so
    /// existing settings.json files keep parsing; always null, ignored
    /// by the JS side.
    #[serde(default, alias = "deskFileId")]
    pub desktop_file_id: Option<String>,
    /// Notebook-only floating minimap widget. Off by default; toggled
    /// via the command palette. Persisted so the user's choice rides
    /// across restarts.
    #[serde(default)]
    pub minimap_visible: bool,
    /// Metadata frontmatter ("Properties") visibility. Hidden by
    /// default; Cmd+; / the command palette toggles the editing UI at
    /// the top of docs that carry a frontmatter block. Persisted so the
    /// choice rides across restarts.
    #[serde(default)]
    pub properties_visible: bool,
    /// Settings > Debug — notebook performance HUD overlay. Off by
    /// default; when on, opening a notebook mounts the on-canvas
    /// frame/stall diagnostics overlay (src/notebook/perf-hud.ts).
    #[serde(default)]
    pub debug_perf_hud: bool,
    /// Settings > Debug > Startup Time — "Track Startup processes". Off by
    /// default; when on, the editor window persists each launch's phase
    /// breakdown into `startup_timings` so the (separate) settings webview
    /// can render it.
    #[serde(default)]
    pub track_startup_timing: bool,
    /// The most recent recorded launch. Opaque JSON owned by the JS side
    /// (`src/startup-trace.js`) — Rust never reads into it, so the shape
    /// can grow phases without a schema change here.
    #[serde(default)]
    pub startup_timings: serde_json::Value,
    /// "Desks" — top-level containers above all other tree nodes.
    /// Always-on; kept as a deprecated boolean so older settings.json
    /// files still parse. The JS side treats desks as structural.
    #[serde(default = "default_true")]
    pub use_desks: bool,
    /// Desk list. Each entry is opaque JSON `{ id, name, createdAt }`.
    #[serde(default)]
    pub desks: Vec<serde_json::Value>,
    /// Per-desk synced metadata, keyed by desk id. Opaque JSON owned by
    /// the JS side (active style, last opened file, persisted panes).
    #[serde(default)]
    pub desks_meta: serde_json::Value,
    /// Active desk id for this device. Null when desks are off.
    #[serde(default)]
    pub active_desk_id: Option<String>,
    /// Files-panel desk view: "single" (active desk only) or "all".
    #[serde(default = "default_desk_display_mode")]
    pub desk_display_mode: String,
    /// Last-opened Local Folder file for this window. Opaque JSON.
    #[serde(default)]
    pub last_local_sync: serde_json::Value,
    /// Per-desk last-opened Local Folder file, keyed by desk id. Opaque.
    #[serde(default)]
    pub desk_last_local_sync: serde_json::Value,

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
    #[serde(default = "default_nb_reset_zoom")]
    pub shortcut_nb_reset_zoom: String,
    #[serde(default = "default_nb_split")]
    pub shortcut_nb_split: String,
    #[serde(default = "default_nb_grab")]
    pub shortcut_nb_grab: String,

    // Persisted panes — restored on app open. Shape is opaque to Rust;
    // JS serializes/deserializes the list of pane objects.
    #[serde(default)]
    pub persisted_panes: Vec<serde_json::Value>,

    // Sticky notes — floating temporary reminders. Shape is opaque to
    // Rust; JS serializes/deserializes the list of note objects.
    #[serde(default)]
    pub sticky_notes: Vec<serde_json::Value>,

    // YOU ARE HERE marker registry — `{ deskId: { fileId, fileType,
    // shapeId?, offset? } }`, one marker per desk. Opaque to Rust; JS
    // owns detection and the one-per-desk enforcement.
    #[serde(default)]
    pub you_are_here: serde_json::Value,

    /// Per-context "panes are hidden" flags, keyed by `pane.ownerContext`
    /// (`doc:<id>` / `nb:<id>` / `pj:<id>`); a truthy entry puts that file
    /// in "file" mode (panes off-screen until **Show panes** clears it).
    /// Rides cross-device via the JS layer's `hiddenOwners` list in
    /// `.hush/panes.json`; Local-Sync / project contexts stay per-device.
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

    // Proofread mode — harper-core. The mode flag isn't persisted (each
    // session starts off so the cold-start dictionary build doesn't gate
    // startup); only the per-rule disable list round-trips.
    // `proofread_disabled_rules` carries the harper rule names the user
    // switched off; the JS frontend forwards it on every `check_grammar`.
    #[serde(default = "default_proofread_disabled_rules")]
    pub proofread_disabled_rules: Vec<String>,
    #[serde(default)] // Spellcheck (spellbook) — persisted; ~10 ms load.
    pub spellcheck_mode: bool,
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
            sync_log: Vec::new(),
            google_client_id: None,
            google_client_secret: None,
            google_access_token: None,
            google_refresh_token: None,
            google_token_expires_at: None,
            google_account_email: None,
            google_doc_links: std::collections::HashMap::new(),
            google_sync_log: Vec::new(),
            sync_folders: Vec::new(),
            local_sync_folders: Vec::new(),
            collapsed_folder_ids: None,
            local_sync_expanded: Vec::new(),
            always_on_top: false,
            column_width: default_column_width(),
            zen_column_width: None,
            sidebar_panel_width: default_sidebar_panel_width(),
            outline_panel_width: default_outline_panel_width(),
            comments_panel_width: default_comments_panel_width(),
            sidebar_open_panel: None,
            sidebar_pinned: false,
            shortcut_open_editor: default_shortcut_open(),
            shortcut_open_fullscreen: default_shortcut_fullscreen(),
            shortcut_toggle_private: default_shortcut_private(),
            shortcut_toggle_sidebar: default_shortcut_toggle_sidebar(),
            shortcut_toggle_outline: default_shortcut_toggle_outline(),
            shortcut_typewriter: default_shortcut_typewriter(),
            shortcut_new_file: default_shortcut_new_file(),
            shortcut_new_file_pane: default_shortcut_new_file_pane(),
            shortcut_new_notebook: default_shortcut_new_notebook(),
            shortcut_new_notebook_pane: default_shortcut_new_notebook_pane(),
            shortcut_shuffle_sentences: default_shortcut_shuffle_sentences(),
            shortcut_toggle_dry: default_shortcut_toggle_dry(),
            shortcut_toggle_focus: default_shortcut_toggle_focus(),
            shortcut_toggle_word_count: default_shortcut_toggle_word_count(),
            shortcut_toggle_properties: default_shortcut_toggle_properties(),
            shortcut_zen_focus: default_shortcut_zen_focus(),
            zen_focus_font_size: default_zen_focus_font_size(),
            selection_focus_font_multiplier: default_selection_focus_font_multiplier(),
            word_count_visible: false,
            shortcut_find: default_shortcut_find(),
            shortcut_quick_find: default_shortcut_quick_find(),
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
            show_recent_files: false,
            recent_files_panel_height: default_recent_files_panel_height(),
            show_project_headings: false,
            recent_file_ids: Vec::new(),
            recent_file_ids_by_desk: serde_json::json!({}),
            styles: Vec::new(),
            active_style_id: None,
            global_style_id: None,
            seeded_preset_files: Vec::new(),
            shader_layer: None,
            post_layers: None,
            post_processing_enabled: None,
            background_layers: None,
            background_layers_enabled: None,
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
            shortcut_switch_desks: default_shortcut_switch_desks(),
            zotero_snapshot_render_height: default_zotero_snapshot_render_height(),
            zotero_snapshot_display_height: default_zotero_snapshot_display_height(),
            zotero_snapshot_quality: default_zotero_snapshot_quality(),
            shortcut_strikethrough: default_shortcut_strikethrough(),
            shortcut_select_paragraph: default_shortcut_select_paragraph(),
            shortcut_select_paragraph_up: default_shortcut_select_paragraph_up(),
            shortcut_select_paragraph_down: default_shortcut_select_paragraph_down(),
            shortcut_save: default_shortcut_save(),
            shortcut_find_next: default_shortcut_find_next(),
            shortcut_find_prev: default_shortcut_find_prev(),
            shortcut_join_lines: default_shortcut_join_lines(),
            shortcut_join_lines_up: default_shortcut_join_lines_up(),
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
            cursor_mode: None,
            line_indicator: None,
            ratchet_encourage_typing: false,
            persisted_panes: Vec::new(),
            sticky_notes: Vec::new(),
            you_are_here: serde_json::json!({}),
            panes_hidden_by_context: serde_json::json!({}),
            window_width: None, window_height: None, window_x: None, window_y: None,
            last_file_id: None, last_project_id: None, last_stack_id: None,
            typewriter_mode: false,
            dry_mode: false,
            scroll_position: None,
            proofread_disabled_rules: default_proofread_disabled_rules(),
            spellcheck_mode: false,
            notebook_appearance_mode: default_notebook_appearance(),
            notebook_theme_id: default_notebook_theme(),
            notebook_background_pattern: default_notebook_bg_pattern(),
            notebook_grid_spacing: default_notebook_grid_spacing(),
            notebook_grid_opacity: default_notebook_grid_opacity(),
            notebook_font_family: default_notebook_font_family(),
            notebook_font_size: default_notebook_font_size(),
            notebook_text_max_width: default_notebook_text_max_width(),
            notebook_shelf_width: default_notebook_shelf_width(),
            notebook_proof_rail_width: default_notebook_proof_rail_width(),
            notebook_proof_rail_visible: true,
            notebook_proof_wheel_x: None,
            notebook_proof_wheel_y: None,
            flow_connect_mode: default_flow_connect_mode(),
            notebook_text_styles: Vec::new(),
            last_notebook_id: None,
            desktop_file_id: None,
            minimap_visible: false,
            properties_visible: false,
            debug_perf_hud: false,
            track_startup_timing: false,
            startup_timings: serde_json::Value::Null,
            use_desks: true,
            desks: Vec::new(),
            desks_meta: serde_json::json!({}),
            active_desk_id: None,
            desk_display_mode: default_desk_display_mode(),
            last_local_sync: serde_json::Value::Null,
            desk_last_local_sync: serde_json::json!({}),
            shortcut_nb_select: default_nb_select(),
            shortcut_nb_text: default_nb_text(),
            shortcut_nb_drag_area: default_nb_drag_area(),
            shortcut_nb_brainstorm: default_nb_brainstorm(),
            shortcut_nb_delete: default_nb_delete(),
            shortcut_nb_undo: default_nb_undo(),
            shortcut_nb_redo: default_nb_redo(),
            shortcut_nb_group: default_nb_group(),
            shortcut_nb_ungroup: default_nb_ungroup(),
            shortcut_nb_reset_zoom: default_nb_reset_zoom(),
            shortcut_nb_split: default_nb_split(),
            shortcut_nb_grab: default_nb_grab(),
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
