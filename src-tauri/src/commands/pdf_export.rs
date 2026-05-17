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

use crate::typst_export::{render_pdf, styles, ExportRequest, ImageInput, ZoteroRef};
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportArgs {
    pub markdown: String,
    pub style_id: String,
    #[serde(default)]
    pub include_citations: bool,
    #[serde(default)]
    pub references: Vec<ZoteroRef>,
    /// Filenames of images referenced in the markdown. We load their
    /// bytes from the existing image store rather than ferrying base64
    /// through the IPC boundary.
    #[serde(default)]
    pub image_filenames: Vec<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub fn render_doc_pdf(state: State<'_, AppState>, args: PdfExportArgs) -> Result<Vec<u8>, String> {
    let images = collect_images(&state, &args.image_filenames);

    let req = ExportRequest {
        markdown: args.markdown,
        style_id: args.style_id,
        include_citations: args.include_citations,
        references: args.references,
        images,
        title: args.title,
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
