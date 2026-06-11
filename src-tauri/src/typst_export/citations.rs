/*
Citation handling for the Typst export pipeline.

The two Hush citation shapes —
    [@citekey]
    [@citekey](zotero://select/library/...)
— chain with semicolons (`[@a](url);@b;@c;[@d](url)`), where the chain
must start with a bracketed item and continuations may be bare `@key`.

Pulldown splits `[@key]` into three text events ('[' / '@key' / ']'),
so the bracket form can't be recognised during the event walk. Instead
`preprocess_cites` runs over the raw markdown first, collapsing every
citation chain into an inert sentinel (Unit-Separator brackets around
the `;`-joined keys) that survives both pulldown and the markup-escape
pass; `expand_cite_sentinels` expands them in a single pass after the
markdown has been converted.
*/

use std::collections::{HashMap, HashSet};

use super::markdown::escape_string;

#[derive(Clone, Debug)]
pub enum CitationMode {
    /// Replace citation-shaped links with Typst `@citekey` references.
    /// The supplied set lists the citekeys present in the bibliography
    /// — anything else renders as a visible "missing reference" marker
    /// so the export still succeeds.
    Resolve { known_keys: HashSet<String> },
    /// Render each citation as a pre-formatted inline label (e.g. the
    /// author-date `(Author Year)` built by `bibliography::inline_citation`)
    /// instead of a Typst `#cite`. Used when the user wants citations
    /// formatted in the prose but opted out of the bibliography section,
    /// so there's no `#bibliography` for `#cite` to resolve against. Keys
    /// missing from the map render as the same "missing reference" marker.
    Inline { formatted: HashMap<String, String> },
    /// Strip the brackets and the deep-link URL, leaving the bare key.
    Strip,
}

// Unit-Separator brackets a citekey through pulldown and the markup
// escape pass. The escape table excludes ASCII control characters, so
// these survive untouched.
const CITE_OPEN: char = '\x1F';
const CITE_CLOSE: char = '\x1E';

pub(super) fn preprocess_cites(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some((key, consumed)) = parse_bracket_cite(&s[i..]) {
                // Citations chain with semicolons:
                //     [@a](url);@b;@c;[@d](url)
                // Continuations may be bare `@key` or bracketed. Collect
                // the whole chain into one sentinel (keys joined by `;`)
                // so the expansion pass can emit a citation group.
                let mut keys = vec![key];
                let mut j = i + consumed;
                while bytes.get(j) == Some(&b';') {
                    if let Some((k, c)) = parse_bracket_cite(&s[j + 1..]) {
                        keys.push(k);
                        j += 1 + c;
                    } else if let Some((k, c)) = parse_bare_cite(&s[j + 1..]) {
                        keys.push(k);
                        j += 1 + c;
                    } else {
                        break;
                    }
                }
                out.push(CITE_OPEN);
                out.push_str(&keys.join(";"));
                out.push(CITE_CLOSE);
                i = j;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub(super) fn expand_cite_sentinels(s: &str, mode: &CitationMode) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != CITE_OPEN {
            out.push(c);
            continue;
        }
        let mut key = String::new();
        for k in chars.by_ref() {
            if k == CITE_CLOSE { break; }
            key.push(k);
        }
        // A sentinel may carry a semicolon-chained citation group
        // (`a;b;c`) collected by preprocess_cites.
        let keys: Vec<&str> = key.split(';').filter(|k| !k.is_empty()).collect();
        match mode {
            // Function form sidesteps the whitespace-sensitive `@key`
            // markup rules, so cites that sit flush against adjacent
            // text (`acts[@mandolessi2024]`) still resolve cleanly. If
            // the key isn't in the supplied bibliography we render a
            // visible "missing" marker instead of `#cite(...)` — the
            // latter would fail compilation and sink the whole export.
            // Chained keys emit adjacent #cite calls, which Typst
            // collapses into a single citation group.
            CitationMode::Resolve { known_keys } => {
                for k in &keys {
                    if known_keys.contains(*k) {
                        out.push_str("#cite(<");
                        out.push_str(k);
                        out.push_str(">)");
                    } else {
                        out.push_str(&missing_cite_marker(k));
                    }
                }
            }
            // Pre-formatted label (author-date etc.). Emit it as a
            // `#text("…")` code expression rather than bare markup: a
            // citation flush against a preceding code expression (e.g.
            // `*word*[@key]` → `#emph[word]…`) would otherwise let Typst
            // parse the label's `(…)` as a call on that expression and
            // fail with "expected comma". The leading `#` starts a fresh
            // expression, exactly like Resolve's `#cite(…)`. Unknown keys
            // fall back to the visible missing marker.
            CitationMode::Inline { formatted } => {
                for (n, k) in keys.iter().enumerate() {
                    if n > 0 {
                        out.push_str("; ");
                    }
                    match formatted.get(*k) {
                        Some(label) => {
                            out.push_str("#text(\"");
                            out.push_str(&escape_string(label));
                            out.push_str("\")");
                        }
                        None => out.push_str(&missing_cite_marker(k)),
                    }
                }
            }
            CitationMode::Strip => out.push_str(&keys.join("; ")),
        }
    }
    out
}

/// Inline marker for a citation key that's not in the bibliography.
/// Bold red `[@key]` so the gap is obvious on the printed page. The
/// `@` is escaped so Typst doesn't try to resolve it as a label, which
/// would re-trigger the very compile failure this marker exists to
/// prevent.
fn missing_cite_marker(key: &str) -> String {
    format!(
        "#text(fill: rgb(\"#c0392b\"), weight: \"bold\")[\\[\\@{}\\]]",
        key
    )
}

fn is_citekey_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '+')
}

/// Returns (citekey, bytes-consumed) if `s` starts with a `[@key]` or
/// `[@key](url)` citation pattern, else None.
fn parse_bracket_cite(s: &str) -> Option<(&str, usize)> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'[') || bytes.get(1) != Some(&b'@') {
        return None;
    }
    let end_bracket = bytes[2..].iter().position(|&b| b == b']' || b == b'\n')?;
    if bytes[2 + end_bracket] != b']' {
        return None;
    }
    let key = &s[2..2 + end_bracket];
    if key.is_empty() || !key.chars().all(is_citekey_char) {
        return None;
    }
    let mut consumed = 2 + end_bracket + 1; // past the `]`
    // Optionally swallow `(...)` so the deep link doesn't render.
    if bytes.get(consumed) == Some(&b'(') {
        if let Some(end_paren) = bytes[consumed + 1..].iter().position(|&b| b == b')' || b == b'\n')
        {
            if bytes[consumed + 1 + end_paren] == b')' {
                consumed += 1 + end_paren + 1;
            }
        }
    }
    Some((key, consumed))
}

/// Returns (citekey, bytes-consumed) if `s` starts with a bare `@key`
/// citation — the form used for continuations inside a semicolon chain
/// (`[@a](url);@b;@c`).
fn parse_bare_cite(s: &str) -> Option<(&str, usize)> {
    if s.as_bytes().first() != Some(&b'@') {
        return None;
    }
    let end = s[1..]
        .char_indices()
        .find(|(_, c)| !is_citekey_char(*c))
        .map(|(i, _)| i)
        .unwrap_or(s.len() - 1);
    if end == 0 {
        return None;
    }
    Some((&s[1..1 + end], 1 + end))
}
