// Grammar checking via the `harper-core` crate.
//
// Exposes two Tauri commands:
//   - `check_grammar(text, disabled_rules)` lints a markdown buffer and
//     returns a list of issues with UTF-16 spans + replacement
//     suggestions. The frontend forwards the user's
//     `proofreadDisabledRules` setting so a rule like `LongSentences`
//     can be silenced without rebuilding the linter.
//   - `list_grammar_rules()` returns the curated rule names harper
//     ships with so the Proofread settings tab can render a checkbox
//     per rule without hard-coding a list.

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

/// Curated list of well-known harper rules surfaced in the Proofread
/// settings tab. We intentionally don't expose the full ~250-rule set —
/// most of them target very specific phrasings (a/an, vice versa, day in
/// age, etc.) and the resulting wall of checkboxes is more confusing
/// than helpful. The names below match the struct identifiers harper
/// uses internally; `LintGroup::config.set_rule_enabled` keys off the
/// same strings.
const CURATED_RULES: &[&str] = &[
    "SpellCheck",
    "LongSentences",
    "RepeatedWords",
    "SentenceCapitalization",
    "OxfordComma",
    "NoOxfordComma",
    "ThatWhich",
    "ThenThan",
    "ToTwoToo",
    "TheyreConfusions",
    "ItsContraction",
    "ItsPossessive",
    "BoringWords",
    "FillerWords",
    "Hedging",
    "MoreBetter",
    "LessWorse",
    "VeryUnique",
    "AnA",
    "WhomSubjectOfVerb",
    "CompoundNouns",
    "PronounContraction",
    "PossessiveYour",
    "WereWhere",
    "Spaces",
    "Dashes",
    "EllipsisLength",
    "QuoteSpacing",
    "UnclosedQuotes",
    "CommaFixes",
];

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
pub async fn check_grammar(
    text: String,
    disabled_rules: Option<Vec<String>>,
) -> Result<Vec<GrammarIssue>, String> {
    // Synchronous Tauri commands run on the WebView's main thread, so
    // pinning harper's multi-second cold-start dictionary build there
    // would freeze the JS side (beach ball cursor, no paint of the
    // "Proofreading…" modal). Hop to the blocking thread pool so the
    // UI stays responsive across the run.
    tauri::async_runtime::spawn_blocking(move || {
        let dict = FstDictionary::curated();
        let mut linter = LintGroup::new_curated(dict, Dialect::American);
        if let Some(rules) = disabled_rules {
            for rule in rules {
                // `set_rule_enabled` is a no-op for unknown keys, so we
                // don't need to guard against rules that no longer exist
                // after a harper upgrade.
                linter.config.set_rule_enabled(rule, false);
            }
        }
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
        out
    })
    .await
    .map_err(|e| format!("grammar check task failed: {e}"))
}

/// Return the curated rule names so the Proofread settings tab can
/// render one checkbox per rule. The list is sorted to match the
/// human-friendly settings UI ordering.
#[tauri::command]
pub fn list_grammar_rules() -> Vec<String> {
    let mut v: Vec<String> = CURATED_RULES.iter().map(|s| (*s).to_string()).collect();
    v.sort();
    v
}
