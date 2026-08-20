use super::CustomFlag;

pub fn default_flag_colors() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    m.insert("TODO".to_string(), "#ffd700".to_string());
    m.insert("MISSING".to_string(), "#ff4444".to_string());
    m.insert("COMMENT".to_string(), "#888888".to_string());
    m.insert("REWRITE".to_string(), "#ff66aa".to_string());
    m.insert("RESEARCH".to_string(), "#66aaff".to_string());
    m
}

pub fn default_custom_flags() -> Vec<CustomFlag> {
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

pub fn default_footnote_font_size() -> u32 {
    100
}
pub fn default_footnote_font_family() -> String {
    "sans-serif".to_string()
}
pub fn default_footnote_use_colors() -> bool {
    true
}
pub fn default_footnote_both_margins() -> bool {
    true
}
pub fn default_footnote_margin_side() -> String {
    "closest".to_string()
}
pub fn default_dry_range() -> String {
    "paragraph".to_string()
}
pub fn default_dry_stopwords() -> Vec<String> {
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
pub fn default_true() -> bool {
    true
}
pub fn default_make_space_direction() -> String {
    "right".to_string()
}
// Half-steps: the outline's Paragraph size and Line gap sliders both
// move in 0.5 px increments, so these round-trip as floats. Typed as
// u32 they rejected any half value outright — serde failed the whole
// AppSettings deserialize, and the save that carried it was lost.
pub fn default_longview_body_font_size() -> f64 {
    3.0
}
pub fn default_longview_heading_font_size() -> u32 {
    12
}
pub fn default_longview_flag_font_size() -> u32 {
    12
}
pub fn default_longview_line_gap() -> f64 {
    2.0
}
pub fn default_longview_current_position_color() -> String {
    "#ff0000".to_string()
}
pub fn default_visibility() -> String {
    "both".to_string()
}
pub fn default_desk_display_mode() -> String {
    "single".to_string()
}
pub fn default_appearance() -> String {
    "auto".to_string()
}
pub fn default_light_theme() -> String {
    "smoothy".to_string()
}
pub fn default_dark_theme() -> String {
    "dracula".to_string()
}
pub fn default_font_size() -> u32 {
    16
}
pub fn default_line_height() -> f64 {
    1.5
}
pub fn default_header_scale() -> f64 {
    1.0
}
pub fn default_font_family() -> String {
    "Source Sans Pro".to_string()
}
pub fn default_padding() -> u32 {
    50
}
pub fn default_column_width() -> u32 {
    800
}
pub fn default_sidebar_panel_width() -> u32 {
    300
}
pub fn default_outline_panel_width() -> u32 {
    200
}
pub fn default_comments_panel_width() -> u32 {
    240
}
pub fn default_recent_files_panel_height() -> u32 {
    150
}
pub fn default_shortcut_open() -> String {
    "CmdOrCtrl+Shift+H".to_string()
}
pub fn default_shortcut_fullscreen() -> String {
    "CmdOrCtrl+Alt+F".to_string()
}
pub fn default_shortcut_private() -> String {
    "CmdOrCtrl+Shift+P".to_string()
}
pub fn default_shortcut_toggle_sidebar() -> String {
    "CmdOrCtrl+\\".to_string()
}
pub fn default_shortcut_toggle_outline() -> String {
    "CmdOrCtrl+Shift+\\".to_string()
}
pub fn default_shortcut_typewriter() -> String {
    "Mod+Shift+T".to_string()
}
// Create shortcuts pair strict modifiers: Cmd makes Docs, Ctrl makes
// Notebooks, Shift makes either an "as pane" create.
pub fn default_shortcut_new_file() -> String {
    "Cmd+N".to_string()
}
pub fn default_shortcut_new_file_pane() -> String {
    "Cmd+Shift+N".to_string()
}
pub fn default_shortcut_new_notebook() -> String {
    "Ctrl+N".to_string()
}
pub fn default_shortcut_new_notebook_pane() -> String {
    "Ctrl+Shift+N".to_string()
}
pub fn default_shortcut_shuffle_sentences() -> String {
    "Mod+Shift+E".to_string()
}
pub fn default_shortcut_toggle_dry() -> String {
    "Mod+Shift+R".to_string()
}
pub fn default_shortcut_toggle_focus() -> String {
    "Mod+S".to_string()
}
pub fn default_shortcut_toggle_word_count() -> String {
    "Mod+Shift+W".to_string()
}
pub fn default_shortcut_toggle_properties() -> String {
    "Mod+;".to_string()
}
pub fn default_shortcut_zen_focus() -> String {
    "Mod+Shift+S".to_string()
}
pub fn default_zen_focus_font_size() -> u32 {
    30
}
pub fn default_selection_focus_font_multiplier() -> f32 {
    1.2
}
pub fn default_shortcut_find() -> String {
    // Cross-file Find panel moved to Cmd+Shift+F; Cmd+F now drives the
    // minimal current-document quick find (default_shortcut_quick_find).
    "Mod+Shift+F".to_string()
}
pub fn default_shortcut_quick_find() -> String {
    "Mod+F".to_string()
}
pub fn default_shortcut_find_all() -> String {
    // Alt+Shift+F to avoid clashing with Cmd+Shift+F (fullscreen).
    "Alt+Shift+F".to_string()
}
pub fn default_shortcut_select_sentence() -> String {
    "Mod+L".to_string()
}
pub fn default_shortcut_reduce_sentence() -> String {
    "Mod+Shift+L".to_string()
}
pub fn default_shortcut_select_next() -> String {
    "Mod+D".to_string()
}
pub fn default_shortcut_jump_next_sentence() -> String {
    "Mod+ArrowRight".to_string()
}
pub fn default_shortcut_jump_prev_sentence() -> String {
    "Mod+ArrowLeft".to_string()
}
pub fn default_shortcut_next_sentence() -> String {
    "Mod+Shift+ArrowRight".to_string()
}
pub fn default_shortcut_prev_sentence() -> String {
    "Mod+Shift+ArrowLeft".to_string()
}
pub fn default_shortcut_move_sentence_forward() -> String {
    "Alt+Mod+ArrowRight".to_string()
}
pub fn default_shortcut_move_sentence_back() -> String {
    "Alt+Mod+ArrowLeft".to_string()
}
pub fn default_shortcut_select_previous() -> String {
    "Mod+Shift+D".to_string()
}
pub fn default_shortcut_delete_to_sentence_end() -> String {
    "Alt+Shift+Backspace".to_string()
}
pub fn default_shortcut_bold() -> String {
    "Mod+B".to_string()
}
pub fn default_shortcut_italic() -> String {
    "Mod+I".to_string()
}
pub fn default_shortcut_highlight() -> String {
    "Mod+=".to_string()
}
pub fn default_shortcut_comment() -> String {
    "Mod+/".to_string()
}
pub fn default_shortcut_insert_footnote() -> String {
    "Mod+Shift+M".to_string()
}
pub fn default_focus_mode_opacity() -> f64 {
    0.5
}
pub fn default_typewriter_line_opacity() -> f64 {
    0.08
}
pub fn default_comment_opacity() -> f64 {
    0.5
}
pub fn default_shortcut_zotero() -> String {
    "Mod+Shift+I".to_string()
}
pub fn default_shortcut_switch_desks() -> String {
    // Literal Ctrl so it doesn't clash with Mod+Shift+D on macOS.
    "Ctrl+Shift+D".to_string()
}
pub fn default_zotero_snapshot_render_height() -> u32 {
    1500
}
pub fn default_zotero_snapshot_display_height() -> u32 {
    300
}
pub fn default_zotero_snapshot_quality() -> u32 {
    90
}
pub fn default_shortcut_strikethrough() -> String {
    "Mod+`".to_string()
}
pub fn default_shortcut_select_paragraph() -> String {
    "Alt+Shift+L".to_string()
}
pub fn default_shortcut_select_paragraph_up() -> String {
    "Mod+Shift+ArrowUp".to_string()
}
pub fn default_shortcut_select_paragraph_down() -> String {
    "Mod+Shift+ArrowDown".to_string()
}
pub fn default_shortcut_save() -> String {
    // Unbound by default — autosave handles persistence and Focus mode
    // now owns Mod+S. Users can rebind from Settings > Shortcuts.
    "".to_string()
}
pub fn default_shortcut_find_next() -> String {
    // Cmd+G / Cmd+Shift+G step through quick-find matches in a document
    // (and the Find panel when it's open). The notebook canvas keeps its
    // own Group / Ungroup handlers — those contexts don't overlap with a
    // focused text editor.
    "Mod+G".to_string()
}
pub fn default_shortcut_find_prev() -> String {
    "Mod+Shift+G".to_string()
}
pub fn default_shortcut_join_lines() -> String {
    "Mod+J".to_string()
}
pub fn default_shortcut_join_lines_up() -> String {
    "Mod+Shift+J".to_string()
}
pub fn default_shortcut_jump_next_paragraph() -> String {
    "Mod+ArrowDown".to_string()
}
pub fn default_shortcut_jump_prev_paragraph() -> String {
    "Mod+ArrowUp".to_string()
}
pub fn default_shortcut_style_default() -> String {
    "Mod+1".to_string()
}
pub fn default_shortcut_style_1() -> String {
    "Mod+2".to_string()
}
pub fn default_shortcut_style_2() -> String {
    "Mod+3".to_string()
}
pub fn default_shortcut_style_3() -> String {
    "Mod+4".to_string()
}
pub fn default_shortcut_style_4() -> String {
    "Mod+5".to_string()
}
pub fn default_privacy_mode() -> String {
    "blackout".to_string()
}
pub fn default_notebook_appearance() -> String {
    "light".to_string()
}
pub fn default_notebook_theme() -> String {
    "default".to_string()
}
pub fn default_notebook_bg_pattern() -> String {
    "dot-grid".to_string()
}
pub fn default_notebook_grid_spacing() -> u32 {
    25
}
pub fn default_notebook_shelf_width() -> u32 {
    280
}
pub fn default_notebook_proof_rail_width() -> u32 {
    92
}
pub fn default_notebook_grid_opacity() -> f64 {
    0.20
}
pub fn default_notebook_font_family() -> String {
    "Inter".to_string()
}
pub fn default_notebook_font_size() -> u32 {
    18
}
pub fn default_notebook_text_max_width() -> u32 {
    350
}
pub fn default_flow_connect_mode() -> String {
    "closest".to_string()
}
pub fn default_nb_select() -> String { "1".to_string() }
pub fn default_nb_text() -> String { "T".to_string() }
pub fn default_nb_drag_area() -> String { "A".to_string() }
pub fn default_nb_brainstorm() -> String { "B".to_string() }
pub fn default_nb_delete() -> String { "Backspace".to_string() }
pub fn default_nb_undo() -> String { "Mod+Z".to_string() }
pub fn default_nb_redo() -> String { "Mod+Shift+Z".to_string() }
pub fn default_nb_group() -> String { "Mod+G".to_string() }
pub fn default_nb_ungroup() -> String { "Mod+Shift+G".to_string() }
pub fn default_nb_reset_zoom() -> String { "Mod+0".to_string() }
pub fn default_nb_split() -> String { "S".to_string() }
pub fn default_nb_grab() -> String { "G".to_string() }

pub fn default_proofread_disabled_rules() -> Vec<String> {
    // LongSentences — verbosity warnings tend to be aesthetic noise for
    // longform writing. Every other curated rule starts on; the user can
    // flip individual ones from the Proofread settings tab.
    vec!["LongSentences".to_string()]
}
