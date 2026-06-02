// Lightweight spellcheck via the `spellbook` crate (pure-Rust,
// Hunspell-format, used by Helix). The en_US dictionary is bundled at
// compile time and loaded into a process-wide `OnceLock` on first call,
// so cold start is a single sub-second hit instead of harper's
// multi-second curated-dictionary build.
//
// Exposes two commands:
//   - `check_spelling(text)` tokenizes the buffer, runs each word
//     through the dictionary, and returns the UTF-16 spans of
//     misspellings — frontend addresses CodeMirror in JS string units.
//   - `spelling_suggestions(word)` returns up to N replacement
//     suggestions for a single word (used by the click-to-fix popover
//     so we don't pay suggestion cost for every word in the doc).

use serde::Serialize;
use spellbook::Dictionary;
use std::sync::OnceLock;

const AFF: &str = include_str!("../../dictionaries/en_US.aff");
const DIC: &str = include_str!("../../dictionaries/en_US.dic");

fn dict() -> &'static Dictionary {
    static DICT: OnceLock<Dictionary> = OnceLock::new();
    DICT.get_or_init(|| {
        Dictionary::new(AFF, DIC).expect("bundled en_US dictionary failed to parse")
    })
}

#[derive(Serialize, Clone)]
pub struct SpellingIssue {
    pub from: usize,
    pub to: usize,
    pub word: String,
}

/// Walk `text` and yield `(char_start, char_end, word)` triples for
/// every run of word-characters. A "word character" is any Unicode
/// alphabetic, plus inline apostrophes (so "don't" tokenizes as one
/// word instead of two). Numbers and stand-alone punctuation are
/// skipped; the dictionary doesn't have them and surfacing every digit
/// run as a misspelling would be hostile.
fn tokenize(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    let mut char_idx = 0usize;
    let mut word_start_char: Option<usize> = None;
    let mut word_start_byte: usize = 0;
    let mut last_byte: usize = 0;
    let mut last_was_word_char = false;

    fn is_word_char(c: char) -> bool {
        c.is_alphabetic()
    }

    while let Some((byte_idx, c)) = chars.next() {
        last_byte = byte_idx + c.len_utf8();
        let next_char = chars.peek().map(|(_, nc)| *nc);
        let is_apos_inside_word = (c == '\'' || c == '\u{2019}')
            && last_was_word_char
            && next_char.map(is_word_char).unwrap_or(false);
        let is_word = is_word_char(c) || is_apos_inside_word;

        if is_word {
            if word_start_char.is_none() {
                word_start_char = Some(char_idx);
                word_start_byte = byte_idx;
            }
            last_was_word_char = is_word_char(c) || last_was_word_char;
        } else if let Some(start_char) = word_start_char.take() {
            let word = text[word_start_byte..byte_idx].to_string();
            if !word.is_empty() {
                out.push((start_char, char_idx, word));
            }
            last_was_word_char = false;
        } else {
            last_was_word_char = false;
        }

        char_idx += 1;
    }

    if let Some(start_char) = word_start_char {
        let word = text[word_start_byte..last_byte].to_string();
        if !word.is_empty() {
            out.push((start_char, char_idx, word));
        }
    }

    out
}

/// Convert a (start, end) range expressed in Unicode-scalar offsets
/// into UTF-16 code-unit offsets. Matches the helper in
/// `commands::grammar` — CodeMirror addresses positions in JS string
/// units, so we do the conversion once on the way out.
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

#[tauri::command]
pub async fn check_spelling(text: String) -> Result<Vec<SpellingIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = dict();
        let tokens = tokenize(&text);
        let mut out = Vec::new();
        for (cs, ce, word) in tokens {
            if d.check(&word) {
                continue;
            }
            let (from, to) = char_to_utf16_range(&text, cs, ce);
            out.push(SpellingIssue { from, to, word });
        }
        out
    })
    .await
    .map_err(|e| format!("spell check task failed: {e}"))
}

#[tauri::command]
pub async fn spelling_suggestions(word: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = dict();
        let mut suggestions: Vec<String> = Vec::new();
        d.suggest(&word, &mut suggestions);
        suggestions.truncate(8);
        suggestions
    })
    .await
    .map_err(|e| format!("spell suggest task failed: {e}"))
}
