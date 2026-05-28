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

/// Format a short author-date inline citation like `(Halbwachs 1992)`
/// directly from the flattened Zotero metadata. Used when the user wants
/// citations formatted in the text but opted out of the bibliography
/// section, so there's no Typst `#bibliography` / CSL machinery to lean
/// on. Mirrors the Chicago author-date shape: surname(s) + year, with
/// "and" for two authors and "et al." for three or more.
pub fn inline_citation(r: &ZoteroRef) -> String {
    let surnames: Vec<String> = split_authors(&r.authors)
        .iter()
        .map(|a| surname(a))
        .filter(|s| !s.is_empty())
        .collect();
    let author = match surnames.len() {
        0 => String::new(),
        1 => surnames[0].clone(),
        2 => format!("{} and {}", surnames[0], surnames[1]),
        _ => format!("{} et al.", surnames[0]),
    };
    let year = r.year.trim();
    match (author.is_empty(), year.is_empty()) {
        (false, false) => format!("({} {})", author, year),
        (false, true) => format!("({})", author),
        (true, false) => format!("({})", year),
        // No author and no year — surface the title (or, failing that,
        // the citekey) so the reference is at least identifiable.
        (true, true) => {
            let label = if !r.title.is_empty() { r.title.trim() } else { r.citekey.trim() };
            format!("({})", label)
        }
    }
}

/// Pull a surname from a single author segment. Zotero stores authors as
/// "Last, First" (so the surname is the part before the comma) but bare
/// "Full Name" segments fall back to the last whitespace-delimited token.
fn surname(seg: &str) -> String {
    if let Some(idx) = seg.find(',') {
        seg[..idx].trim().to_string()
    } else {
        seg.split_whitespace().last().unwrap_or("").trim().to_string()
    }
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

/// Map Zotero item types → Hayagriva entry types. Hayagriva's `type`
/// field rejects anything outside its closed vocabulary, so we only
/// emit values from that list and fall through to `misc` for anything
/// we're not certain maps cleanly. The current list is taken from the
/// Hayagriva 0.9 source — keep it in sync if we bump the dep.
fn map_item_type(zotero: &str) -> &'static str {
    match zotero {
        // Periodicals / press
        "journalArticle" | "magazineArticle" => "article",
        "newspaperArticle" => "newspaper",
        // Books and their parts
        "book" => "book",
        "bookSection" | "chapter" | "encyclopediaArticle" | "dictionaryEntry" => "chapter",
        // Academic / professional
        "conferencePaper" => "conference",
        "thesis" => "thesis",
        "report" => "report",
        "manuscript" => "manuscript",
        "patent" => "patent",
        "case" => "case",
        "statute" | "bill" | "hearing" => "legislation",
        // Web / posts
        "webpage" => "web",
        "blogPost" => "blog",
        "forumPost" | "instantMessage" => "post",
        // Media
        "audioRecording" | "podcast" | "radioBroadcast" => "audio",
        "videoRecording" | "film" | "tvBroadcast" => "video",
        "artwork" => "artwork",
        "performance" => "performance",
        "exhibitionCatalog" | "exhibition" => "exhibition",
        // Things Hayagriva has no first-class slot for
        "letter" | "email" | "interview" | "presentation" | "computerProgram"
        | "map" | "dataset" | "document" => "misc",
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

    /// Regression: Hayagriva rejects any `type:` value outside its
    /// closed vocabulary. Several real Zotero item types (interview,
    /// letter, presentation, …) had no direct equivalent so they must
    /// fall through to `misc` rather than appearing verbatim.
    #[test]
    fn unknown_zotero_types_become_misc() {
        for kind in ["interview", "letter", "presentation", "computerProgram", "dataset"] {
            let refs = vec![ZoteroRef {
                key: "K".into(),
                citekey: "k2020".into(),
                title: "T".into(),
                authors: String::new(),
                year: "2020".into(),
                item_type: kind.into(),
            }];
            let yaml = to_hayagriva_yaml(&refs);
            assert!(yaml.contains("type: misc"), "{}: {}", kind, yaml);
        }
    }

    #[test]
    fn inline_citation_author_date() {
        assert_eq!(inline_citation(&r("h1992", "1992", "Halbwachs, M", "T")), "(Halbwachs 1992)");
        assert_eq!(
            inline_citation(&r("hc1992", "1992", "Halbwachs, M; Coser, L", "T")),
            "(Halbwachs and Coser 1992)",
        );
        assert_eq!(
            inline_citation(&r("abc2020", "2020", "Adams, A; Brown, B; Clark, C", "T")),
            "(Adams et al. 2020)",
        );
    }

    #[test]
    fn inline_citation_handles_bare_name_and_missing_year() {
        assert_eq!(inline_citation(&r("k", "", "Jane Austen", "T")), "(Austen)");
        assert_eq!(inline_citation(&r("k", "2001", "", "Title Here")), "(2001)");
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
