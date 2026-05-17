/*!
Build a [Hayagriva] YAML bibliography from the Zotero references we
already loaded into the app.

We emit a deliberately minimal YAML — `title`, `author`, `date`, and a
type slug — because:

  - Hayagriva's full schema is much richer than what Zotero's
    flattened reference rows give us. Filling out only what we have
    keeps the YAML valid and lets Hayagriva's defaults handle the
    rest.
  - Anything we can't determine (publisher, page range, etc.) would
    be a guess. Leaving it out is honest and the bibliography still
    renders.

The chicago-author-date CSL that styles.rs selects renders these as
inline `(Author Year)` and a bibliography section ordered by author
surname — both line up with the spec.

[Hayagriva]: https://github.com/typst/hayagriva
*/

use super::ZoteroRef;

pub fn to_hayagriva_yaml(refs: &[ZoteroRef]) -> String {
    let mut out = String::with_capacity(refs.len() * 96);
    let mut seen = std::collections::HashSet::new();
    for r in refs {
        if r.citekey.is_empty() {
            continue;
        }
        // Better BibTeX usually guarantees unique keys, but a duplicate
        // would collide on the YAML top-level map — last write wins in
        // YAML so we explicitly skip dupes.
        if !seen.insert(r.citekey.clone()) {
            continue;
        }
        emit_entry(&mut out, r);
    }
    out
}

fn emit_entry(out: &mut String, r: &ZoteroRef) {
    out.push_str(&r.citekey);
    out.push_str(":\n");
    out.push_str(&format!("  type: {}\n", map_item_type(&r.item_type)));
    if !r.title.is_empty() {
        out.push_str(&format!("  title: {}\n", quote_yaml(&r.title)));
    }
    let authors = split_authors(&r.authors);
    if !authors.is_empty() {
        out.push_str("  author:\n");
        for a in &authors {
            out.push_str(&format!("    - {}\n", quote_yaml(a)));
        }
    }
    if !r.year.is_empty() {
        // Hayagriva accepts a bare year as `date: YYYY`.
        out.push_str(&format!("  date: {}\n", r.year));
    }
    out.push('\n');
}

/// Zotero's stored `authors` string in our refs is a `;`-joined list
/// like "Halbwachs, M; Coser, L". Hayagriva's author list takes
/// "Last, First" or "Full Name" — passing the segments verbatim works
/// for both Zotero shapes.
fn split_authors(s: &str) -> Vec<String> {
    s.split(';')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Map Zotero item types → Hayagriva entry types. The Hayagriva
/// vocabulary covers most academic forms; unknown types fall back to
/// `misc` so the YAML stays valid.
fn map_item_type(zotero: &str) -> &'static str {
    match zotero {
        "journalArticle" | "magazineArticle" | "newspaperArticle" => "article",
        "book" | "bookSection" => "book",
        "chapter" => "chapter",
        "conferencePaper" => "article",
        "thesis" => "thesis",
        "report" => "report",
        "webpage" | "blogPost" | "forumPost" => "web",
        "letter" | "email" => "letter",
        "interview" => "interview",
        "manuscript" => "manuscript",
        "presentation" => "misc",
        "patent" => "patent",
        "audioRecording" => "audio",
        "videoRecording" | "film" | "tvBroadcast" => "video",
        _ => "misc",
    }
}

/// Wrap a YAML scalar in double quotes when it contains punctuation
/// that would otherwise need explicit YAML escaping (colons, leading
/// dashes, etc.). The result is always safely parseable.
fn quote_yaml(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(citekey: &str, year: &str, authors: &str, title: &str) -> ZoteroRef {
        ZoteroRef {
            key: "K".into(),
            citekey: citekey.into(),
            title: title.into(),
            authors: authors.into(),
            year: year.into(),
            item_type: "book".into(),
        }
    }

    #[test]
    fn emits_one_entry_per_ref() {
        let refs = vec![
            r("halbwachs1992", "1992", "Halbwachs, M; Coser, L", "On Collective Memory"),
            r("ricoeur2004", "2004", "Ricœur, P", "Memory, History, Forgetting"),
        ];
        let yaml = to_hayagriva_yaml(&refs);
        assert!(yaml.contains("halbwachs1992:"));
        assert!(yaml.contains("ricoeur2004:"));
        assert!(yaml.contains("Halbwachs"));
    }

    #[test]
    fn dedupes_by_citekey() {
        let refs = vec![
            r("a2020", "2020", "Smith", "First"),
            r("a2020", "2020", "Smith", "Second"),
        ];
        let yaml = to_hayagriva_yaml(&refs);
        assert_eq!(yaml.matches("a2020:").count(), 1);
    }
}
