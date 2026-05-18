/*!
Citation-style registry.

A citation style is the CSL grammar that decides how `#cite(<key>)`
renders inline and how `#bibliography(...)` renders the reference
list. It's deliberately orthogonal to the document style (typography,
margins, page numbering): two docs in the same Formal layout can pick
APA vs IEEE without touching the preamble, and a future style can ship
its own preamble without redefining the citation grammar.

Two flavours under the hood:

  - **`BuiltIn`** — a hayagriva-bundled CSL identifier ("apa", "mla",
    "chicago-author-date", "ieee", "harvard-cite-them-right"). Typst
    looks the name up directly inside `#bibliography(style: "...")`.
  - **`Custom`** — raw CSL XML that's registered as `/style.csl` in
    the export World. `#bibliography(style: "/style.csl")` then picks
    it up via `World::file`.

The only Custom CSL today is the "Numbered (gutter)" style we built
to satisfy the brief — `(Author Year)` inline cites + a numbered
bibliography with the entry numbers floating in a left gutter column.
It's the default option in the modal because it's what shipped first.
*/

#[derive(Debug, Clone, Copy)]
pub enum CitationStyle {
    /// Name of a hayagriva-bundled CSL style.
    BuiltIn(&'static str),
    /// Raw CSL XML to be registered as a virtual file in the World.
    Custom(&'static str),
}

impl CitationStyle {
    /// Path or built-in name appropriate for the `style:` argument of
    /// `#bibliography(...)`.
    pub fn typst_style_arg(&self) -> &'static str {
        match self {
            Self::BuiltIn(name) => name,
            Self::Custom(_) => "/style.csl",
        }
    }

    pub fn custom_bytes(&self) -> Option<&'static str> {
        match self {
            Self::Custom(bytes) => Some(bytes),
            Self::BuiltIn(_) => None,
        }
    }
}

/// Modal-friendly id → style mapping. `None` for an unknown id so the
/// caller can fall back to the default without panicking on a stale
/// frontend value.
pub fn resolve(id: &str) -> Option<CitationStyle> {
    Some(match id {
        "numbered" => CitationStyle::Custom(NUMBERED_GUTTER_CSL),
        "apa" => CitationStyle::BuiltIn("apa"),
        "mla" => CitationStyle::BuiltIn("modern-language-association"),
        "chicago" => CitationStyle::BuiltIn("chicago-author-date"),
        "ieee" => CitationStyle::BuiltIn("ieee"),
        "harvard" => CitationStyle::BuiltIn("harvard-cite-them-right"),
        _ => return None,
    })
}

pub fn default_id() -> &'static str {
    "numbered"
}

/// Ordered (id, display name) pairs for the citation-style dropdown.
/// The first entry is the default; the frontend respects this order.
pub fn list() -> &'static [(&'static str, &'static str)] {
    &[
        ("numbered", "Numbered (gutter)"),
        ("apa", "APA"),
        ("mla", "MLA"),
        ("chicago", "Chicago / Turabian"),
        ("ieee", "IEEE"),
        ("harvard", "Harvard"),
    ]
}

// ───────────────────── bundled custom CSL ─────────────────────

/// CSL XML for the "Numbered (gutter)" style. Two non-obvious choices:
///
///   - `<citation>` keeps the chicago-author-date shape: `(Author
///     Year)` inline, suppress the author when prose context already
///     names them, et-al collapse for 3+ authors.
///   - `<bibliography>` swaps the default by-author list for a
///     numbered list with `second-field-align="margin"` — Hayagriva
///     renders that as a two-column layout where the citation number
///     sits in a narrow left gutter and the entry body hangs in the
///     wider right column.
///
/// Entries are sorted by author then year so the visible numbering
/// reflects bibliography order, not citation order. That's the
/// chicago-author-date convention and avoids "[1]"-style surprise
/// where a later cite picks up a lower number.
const NUMBERED_GUTTER_CSL: &str = r##"<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="sort-only" default-locale="en-US">
  <info>
    <title>Hush Numbered (Author-Date, Gutter Bibliography)</title>
    <id>https://hush.app/styles/numbered</id>
    <link href="https://hush.app/styles/numbered" rel="self"/>
    <updated>2026-05-17T00:00:00+00:00</updated>
    <category citation-format="author-date"/>
    <summary>Author-date inline citations with a numbered, gutter-aligned bibliography.</summary>
  </info>
  <macro name="author-short">
    <names variable="author">
      <name form="short" and="text" delimiter=", " initialize-with=". "/>
      <substitute>
        <names variable="editor"/>
        <names variable="translator"/>
        <text variable="title" font-style="italic"/>
      </substitute>
    </names>
  </macro>
  <macro name="author-long">
    <names variable="author">
      <name name-as-sort-order="first" and="text" delimiter=", " initialize-with=". "/>
      <substitute>
        <names variable="editor"/>
        <names variable="translator"/>
        <text variable="title" font-style="italic"/>
      </substitute>
    </names>
  </macro>
  <macro name="year">
    <date variable="issued">
      <date-part name="year"/>
    </date>
  </macro>
  <macro name="title">
    <choose>
      <if type="book thesis report" match="any">
        <text variable="title" font-style="italic"/>
      </if>
      <else>
        <text variable="title" quotes="true"/>
      </else>
    </choose>
  </macro>
  <macro name="publisher">
    <group delimiter=": ">
      <text variable="publisher-place"/>
      <text variable="publisher"/>
    </group>
  </macro>
  <citation et-al-min="3" et-al-use-first="1" disambiguate-add-year-suffix="true">
    <layout prefix="(" suffix=")" delimiter="; ">
      <group delimiter=" ">
        <text macro="author-short"/>
        <text macro="year"/>
      </group>
    </layout>
  </citation>
  <bibliography hanging-indent="true" second-field-align="margin" entry-spacing="1">
    <sort>
      <key macro="author-long"/>
      <key macro="year"/>
    </sort>
    <layout>
      <text variable="citation-number" suffix="."/>
      <group delimiter=". ">
        <text macro="author-long"/>
        <text macro="year"/>
        <text macro="title"/>
        <text macro="publisher"/>
      </group>
      <text value="."/>
    </layout>
  </bibliography>
</style>
"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_id_resolves() {
        for (id, _) in list() {
            assert!(resolve(id).is_some(), "missing resolver for {}", id);
        }
    }

    #[test]
    fn default_id_resolves() {
        assert!(resolve(default_id()).is_some());
    }

    #[test]
    fn unknown_id_returns_none() {
        assert!(resolve("nope").is_none());
    }

    #[test]
    fn custom_bytes_only_for_custom_variant() {
        assert!(resolve("numbered").unwrap().custom_bytes().is_some());
        assert!(resolve("apa").unwrap().custom_bytes().is_none());
    }
}
