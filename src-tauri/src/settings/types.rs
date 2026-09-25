// Sub-structs referenced by `AppSettings`. Extracted from settings.rs to
// keep the main file under the 700-line cap. Kept under `mod types` so
// the existing `crate::settings::Style` (etc.) import path still works
// via re-exports.

use serde::{Deserialize, Serialize};

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
    /// Cursor mode override ("system" | "block" | "underline" |
    /// "thick"). When present this wins over `block_cursor`; the boolean
    /// is still written in lockstep for older clients reading the same
    /// JSON.
    #[serde(default)]
    pub cursor_mode: Option<String>,
    /// Halo behind the caret. Only a custom `cursor_mode` wears one —
    /// the system caret is the platform's to draw. Its colour is the
    /// per-appearance `cursorGlow` override in `light_colors` /
    /// `dark_colors`, falling back to the caret's own.
    #[serde(default)]
    pub cursor_glow: Option<bool>,
    /// Per-appearance glow switches. Either one set wins over
    /// `cursor_glow` for its appearance; a style saved before the split
    /// has only `cursor_glow`, which then stands for both.
    #[serde(default)]
    pub cursor_glow_light: Option<bool>,
    #[serde(default)]
    pub cursor_glow_dark: Option<bool>,
    /// Scale on the glow's two shadows (1 = 3px core + 10px bloom).
    #[serde(default)]
    pub cursor_glow_intensity: Option<f64>,
    /// Retired steady-caret switch: `Some(false)` held a custom caret
    /// still. Superseded by `cursor_idle_animation`, and still written
    /// in lockstep (false only for "none") for older clients.
    #[serde(default)]
    pub cursor_blink: Option<bool>,
    /// What a custom caret does at rest: "blink" | "pulse" | "none".
    /// Absent falls back to `cursor_blink`, then to blinking.
    #[serde(default)]
    pub cursor_idle_animation: Option<String>,
    #[serde(default)]
    pub suppress_header_size: Option<bool>,
    #[serde(default)]
    pub suppress_header_color: Option<bool>,
    #[serde(default)]
    pub underline_headers: Option<bool>,
    #[serde(default)]
    pub header_scale: Option<f64>,
    /// "Highlight current line" affordance — one of "none", "left-arrow",
    /// "double-arrow", "left-border", "border", "underline", "highlight".
    /// Unset / "none" disables the indicator. Indicator colour rides per-appearance on
    /// `light_colors` / `dark_colors` under the `lineIndicator` key.
    #[serde(default)]
    pub line_indicator: Option<String>,
    /// Retired single-overlay post processing. Kept so styles written by
    /// an older build still round-trip and can derive their post layers
    /// on read; nothing writes it any more.
    #[serde(default)]
    pub shader_layer: Option<ShaderLayer>,
    /// Post-processing layers (vignette / glow / scan lines / opacity /
    /// tint / grayscale / sepia, each with its knobs and blend mode).
    /// Opaque JSON — the JS side owns the shape.
    #[serde(default)]
    pub post_layers: Option<serde_json::Value>,
    /// Section-level on/off for the whole post stack. `None` reads as
    /// enabled.
    #[serde(default)]
    pub post_processing_enabled: Option<bool>,
    /// Optional decorative background image config (src data-URL, fit,
    /// repeat, blend mode, opacity). Stored opaquely as JSON so the shape
    /// can evolve without a Rust schema change. Legacy — superseded by
    /// `background_layers`; kept so un-migrated styles round-trip.
    #[serde(default)]
    pub background_image: Option<serde_json::Value>,
    /// Composite background layers (image / gradient / webgl / caret
    /// entries, each with blend mode + per-type options). Stored
    /// opaquely as JSON — the JS side owns the shape.
    #[serde(default)]
    pub background_layers: Option<serde_json::Value>,
    /// Section-level on/off for the whole layer stack. `None` reads as
    /// enabled, so styles saved before the switch existed keep theirs.
    #[serde(default)]
    pub background_layers_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderLayer {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub layer_id: Option<String>,
    #[serde(default)]
    pub intensity: Option<f64>,
    /// Per-layer knob values keyed by the layer's settings-schema id
    /// (e.g. `glow`, `scanlineColor`). Serde silently drops fields
    /// that aren't on the struct, so without this slot the modal's
    /// slider/color pickers were round-tripping back to the layer
    /// defaults on every save/load cycle.
    #[serde(default)]
    pub options: std::collections::HashMap<String, serde_json::Value>,
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
    pub sync_type: String, // legacy synced-folder kind
    pub name: String,
}

// Per-Hush-document link to a Google Doc. Keyed by Hush fileId in the
// `google_doc_links` map on `AppSettings`. There's intentionally no
// `last_synced_*` here — push/pull are user-driven whole-doc replaces,
// so no automatic conflict-detection state is needed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDocLink {
    pub doc_id: String,        // Google Drive file id
    pub title: String,         // last-known GDoc title (for the link bar chip)
    pub linked_at: i64,        // unix seconds — for the log
}
