//! The wire types the frontend sees.
//!
//! `TreeNode` is the sidebar's whole vocabulary — every optional field
//! on it is a feature's per-node metadata, and serde silently drops
//! anything not declared here on the `save_file_tree` / `get_file_tree`
//! round trip, so a field the JS side stamps without a Rust counterpart
//! resets to nothing every launch. Kept apart from `lib.rs` (app setup,
//! managed state, the command list) because these three are the
//! contract, not the wiring.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub content: String,
    pub modified: u64,
}

/// One row of the library listing (`list_files`).
///
/// Deliberately *not* `FileEntry`: the listing is the frontend's index of
/// every file in every desk, and it is read at boot, so it carries content
/// only for the kinds something actually asks the cache for — documents.
/// A notebook or stack row arrives with `content: null`, which is a
/// different thing from an empty file and has to stay distinguishable:
/// callers that need those bytes go through `load_file`. See
/// README-TECHNICAL, "Startup".
#[derive(Serialize, Deserialize, Clone)]
pub struct FileSummary {
    pub id: String,
    pub name: String,
    pub content: Option<String>,
    pub modified: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String, // "document" | "folder" | "project" | "notebook" | "pdf" | "stack"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>, // for documents and notebooks — points to files/{uuid}.json
    // Always serialized (even when empty) so the JS frontend always
    // receives a real array — skipping empty children broke sync-folder
    // reconciliation when inserting files into previously-empty folders.
    #[serde(default)]
    pub children: Vec<TreeNode>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flagged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_style_id: Option<String>,
    // Doc-only — when set on a doc inside a project, the doc rides as
    // a "note" alongside notebooks (50 % opacity, sorted under the
    // joined buffer) instead of feeding the joined editor stream.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub use_as_note: bool,
    // PDF-only — Zotero attachment key for PDFs imported from Zotero.
    // Enables annotation fetch + overlay via the Zotero API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zotero_att_key: Option<String>,
    // Sidebar background tint — one of the keys in ROW_COLORS
    // (files-panel-row-menu.js). Children inherit visually via CSS
    // cascade; absent on most nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_color: Option<String>,
    // Project-only — when true, the sidebar prefixes child rows with
    // outline numbers (decimals for nested projects).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub show_numbers: bool,
    // Notebook-only — when true (inside a project), this notebook is the
    // project's gutter: paired with the joined doc buffer and rendered as a
    // right-docked sidebar. The pairing is the project's own metadata, so it
    // must survive the save_file_tree / get_file_tree round trip.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gutter: bool,
    // Notebook-only — built from a PDF by Create Proofread Notebook. Only
    // the sidebar reads it (the proofread glyph); the notebook itself
    // carries the real metadata in its `proof` envelope field.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub proofread: bool,
    // PDF-only — this node is an alias into a project's own PDFs folder:
    // it shares the original's fileId (binary + registry metadata) but is
    // just a reference, so deleting it never touches the desk copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pdf_alias: bool,
    // Folder-only — a project's local "PDFs" folder holding pdf aliases.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pdf_folder: bool,
    // PDF-alias-only — epoch seconds when the alias was added to its
    // project (the alias's own metadata beyond what the registry holds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<u64>,
    // Doc-only — a word count cap for this document. Once the doc holds
    // this many words nothing that would add another lands, on any
    // surface showing it (see src/editor/word-limit.js). Absent on
    // every doc the user hasn't capped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_limit: Option<u32>,
    // PDF-only, legacy — the shelf's "flag to top" feature originally
    // shipped as `pinned`; it now rides the shared `flagged` field. Kept
    // so existing trees deserialize and the JS side can migrate the
    // marker (enforceFlaggedPdfOrder folds it into `flagged` and clears
    // it, after which skip_serializing_if drops the key from disk).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}
