// Grammar checking via the `harper-core` crate.
//
// Exposes a single `check_grammar` Tauri command that takes the raw markdown
// text from the editor and returns a list of issues. Spans use UTF-16 code
// unit offsets so they line up with CodeMirror's positions in the JS frontend
// without further conversion (harper itself returns Unicode scalar offsets).

use harper_core::{
    linting::{LintGroup, Linter, Suggestion},
    spell::FstDictionary,
    Dialect, Document,
};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct GrammarIssue {
    pub from: usize,
    pub to: usize,
    pub message: String,
    pub suggestions: Vec<String>,
}

/// Convert a (start, end) pair expressed in Unicode-scalar offsets into the
/// equivalent UTF-16 code-unit offsets for the same source text. CodeMirror
/// addresses positions in JS string units (UTF-16), so we do the conversion
/// once on the way out instead of asking the frontend to walk every
/// character of the document for every issue.
fn char_to_utf16_range(text: &str, char_start: usize, char_end: usize) -> (usize, usize) {
    let mut chars_seen = 0usize;
    let mut utf16_seen = 0usize;
    let mut start = None;
    let mut end = None;
    for c in text.chars() {
        if start.is_none() && chars_seen == char_start {
            start = Some(utf16_seen);
        }
        if end.is_none() && chars_seen == char_end {
            end = Some(utf16_seen);
        }
        if start.is_some() && end.is_some() {
            break;
        }
        utf16_seen += c.len_utf16();
        chars_seen += 1;
    }
    if start.is_none() && chars_seen == char_start {
        start = Some(utf16_seen);
    }
    if end.is_none() && chars_seen == char_end {
        end = Some(utf16_seen);
    }
    (start.unwrap_or(char_start), end.unwrap_or(char_end))
}

fn suggestion_to_string(s: &Suggestion) -> Option<String> {
    match s {
        Suggestion::ReplaceWith(chars) => Some(chars.iter().collect()),
        Suggestion::InsertAfter(chars) => Some(chars.iter().collect()),
        Suggestion::Remove => None,
    }
}

#[tauri::command]
pub fn check_grammar(text: String) -> Result<Vec<GrammarIssue>, String> {
    let dict = FstDictionary::curated();
    let mut linter = LintGroup::new_curated(dict, Dialect::American);
    let document = Document::new_markdown_default_curated(&text);
    let lints = linter.lint(&document);

    let mut out = Vec::with_capacity(lints.len());
    for lint in lints {
        let (from, to) = char_to_utf16_range(&text, lint.span.start, lint.span.end);
        let suggestions = lint
            .suggestions
            .iter()
            .filter_map(suggestion_to_string)
            .collect();
        out.push(GrammarIssue {
            from,
            to,
            message: lint.message,
            suggestions,
        });
    }
    Ok(out)
}
