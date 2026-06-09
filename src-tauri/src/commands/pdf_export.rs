/*!
Tauri command surface for the Typst-backed PDF export.

The frontend hands us a markdown body, a style id, optional citation
data, and a list of image filenames that appear in the doc. We resolve
each filename to bytes via the existing ImageManager (so the renderer
never needs network or filesystem access of its own) and call into
`typst_export::render_pdf`.

Returning `Vec<u8>` so the JS side can pipe it through the same Tauri
binary-file writer that the notebook export uses.
*/

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::typst_export::{csl, render_pdf, styles, ExportRequest, ImageInput, ZoteroRef};
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportArgs {
    pub markdown: String,
    pub style_id: String,
    #[serde(default)]
    pub include_citations: bool,
    #[serde(default = "default_cite_style")]
    pub citation_style: String,
    #[serde(default = "true_default")]
    pub strip_comments: bool,
    #[serde(default = "true_default")]
    pub strip_flags: bool,
    #[serde(default)]
    pub number_headings: bool,
    #[serde(default = "true_default")]
    pub page_numbers: bool,
    #[serde(default = "true_default")]
    pub include_tabs: bool,
    #[serde(default = "default_line_spacing")]
    pub line_spacing: f32,
    #[serde(default = "default_header_scale")]
    pub header_scale: f32,
    #[serde(default)]
    pub references: Vec<ZoteroRef>,
    /// Filenames of images referenced in the markdown. We load their
    /// bytes from the existing image store rather than ferrying base64
    /// through the IPC boundary.
    #[serde(default)]
    pub image_filenames: Vec<String>,
}

fn true_default() -> bool { true }
fn default_cite_style() -> String { csl::default_id().to_string() }
fn default_line_spacing() -> f32 { 1.5 }
fn default_header_scale() -> f32 { 1.0 }

#[tauri::command]
pub fn render_doc_pdf(state: State<'_, AppState>, args: PdfExportArgs) -> Result<Vec<u8>, String> {
    let images = collect_images(&state, &args.image_filenames);

    let req = ExportRequest {
        markdown: args.markdown,
        style_id: args.style_id,
        include_citations: args.include_citations,
        citation_style: args.citation_style,
        strip_comments: args.strip_comments,
        strip_flags: args.strip_flags,
        number_headings: args.number_headings,
        page_numbers: args.page_numbers,
        include_tabs: args.include_tabs,
        line_spacing: args.line_spacing,
        header_scale: args.header_scale,
        references: args.references,
        images,
    };

    render_pdf(&req)
}

#[derive(Serialize)]
pub struct DocStyleSummary {
    pub id: &'static str,
    pub name: &'static str,
}

#[tauri::command]
pub fn list_doc_styles() -> Vec<DocStyleSummary> {
    styles::list()
        .iter()
        .map(|s| DocStyleSummary { id: s.id, name: s.name })
        .collect()
}

#[derive(Serialize)]
pub struct CitationStyleSummary {
    pub id: &'static str,
    pub name: &'static str,
}

#[tauri::command]
pub fn list_citation_styles() -> Vec<CitationStyleSummary> {
    csl::list()
        .iter()
        .map(|(id, name)| CitationStyleSummary { id, name })
        .collect()
}

fn collect_images(state: &AppState, names: &[String]) -> Vec<ImageInput> {
    let manager = state.image_manager.lock().unwrap();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        // Silently skip missing images — the markdown converter will
        // still emit an `#image(...)` and Typst will surface a clear
        // diagnostic. Crashing here would block the whole export over
        // a single stale ref.
        if let Ok((bytes, _mime)) = manager.load_bytes(name) {
            out.push(ImageInput { filename: name.clone(), bytes });
        }
    }
    out
}
