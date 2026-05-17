/*!
Document-style registry.

A "style" is a small Typst preamble that lives in front of the
converted markdown body. Adding a new style means appending a `Style`
to the table at the bottom of this file — the frontend mirrors the
list in `src/sidebar/doc-export-styles.js` so users can pick one.

Constraints on a style preamble:

  - Must not depend on any `@preview/...` package — the World we ship
    has no package storage so those imports would fail at compile.
  - Must reference at least one font we know `typst-assets` ships
    (Libertinus Serif, New Computer Modern, DejaVu Sans Mono).
  - Should expose a `body` content slot via the conventional `#show`
    + `#set` pattern so the body emitted by the markdown converter
    drops in without further wrapping.
*/

pub struct Style {
    pub id: &'static str,
    pub name: &'static str,
    preamble: &'static str,
    /// Optional CSL bytes for the bibliography. When set, the wrap
    /// function points `#bibliography(...)` at `/style.csl` and the
    /// world registers these bytes there. When None, falls back to
    /// the built-in chicago-author-date style.
    csl: Option<&'static str>,
}

impl Style {
    /// CSL XML for this style's bibliography, if any. Lives on the
    /// type so `mod.rs` can register it in the export World without
    /// reaching into the styles module internals.
    pub fn csl_bytes(&self) -> Option<&'static str> {
        self.csl
    }
}

/// Per-export knobs that aren't baked into a style — these come from
/// the modal toggles. Keeping them here (rather than per-style)
/// because they're orthogonal: any style can choose to show or hide
/// page numbers, number its headings, and so on.
pub struct WrapOptions {
    pub with_bibliography: bool,
    pub number_headings: bool,
    pub page_numbers: bool,
}

pub fn lookup(id: &str) -> Option<&'static Style> {
    STYLES.iter().find(|s| s.id == id)
}

pub fn list() -> &'static [Style] {
    STYLES
}

/// Compose the final Typst source: preamble → per-export overrides
/// → markdown body → optional bibliography directive.
///
/// Doc title is intentionally not rendered — the source markdown owns
/// its own front matter (a `#` heading if the author wants one), and
/// the export filename carries the document name into the OS.
pub fn wrap(style: &Style, body: &str, opts: &WrapOptions) -> String {
    let mut out = String::with_capacity(style.preamble.len() + body.len() + 256);
    out.push_str(style.preamble);
    out.push('\n');

    // Page numbering rides on top of whatever the style already
    // configured for `#set page(...)`. Typst lets a later `#set` win
    // over earlier ones in the same scope, so this is safe to append.
    if opts.page_numbers {
        // "1" centred in the footer is the conventional default for a
        // formal doc. Styles can override later if they need totals
        // ("1 / 1") or roman numerals.
        out.push_str("#set page(numbering: \"1\")\n");
    }

    if opts.number_headings {
        // `"1.1"` produces 1, 1.1, 1.1.1 (per the spec — h1 is just
        // "1", h2 adds the second component, h3 the third).
        out.push_str("#set heading(numbering: \"1.1\")\n");
    }

    out.push('\n');
    out.push_str(body);

    if opts.with_bibliography {
        // The bibliography file is registered at `/refs.yml` by the
        // World — Typst's `bibliography()` accepts a path and a style
        // (built-in name OR a path to a CSL file). If this style ships
        // its own CSL we point at `/style.csl` (registered alongside
        // refs.yml in the export World); otherwise we fall back to
        // built-in chicago-author-date so inline cites still read as
        // (Author Year).
        out.push_str("\n#pagebreak()\n");
        let style_arg = if style.csl.is_some() { "\"/style.csl\"" } else { "\"chicago-author-date\"" };
        out.push_str(&format!(
            "#bibliography(\"/refs.yml\", style: {})\n",
            style_arg
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn formal() -> &'static Style {
        lookup("formal").unwrap()
    }

    fn base() -> WrapOptions {
        WrapOptions {
            with_bibliography: false,
            number_headings: false,
            page_numbers: false,
        }
    }

    #[test]
    fn page_numbers_directive_emitted_when_on() {
        let out = wrap(formal(), "body", &WrapOptions { page_numbers: true, ..base() });
        assert!(out.contains("#set page(numbering: \"1\")"), "got: {}", out);
    }

    #[test]
    fn heading_numbering_directive_emitted_when_on() {
        let out = wrap(formal(), "body", &WrapOptions { number_headings: true, ..base() });
        assert!(out.contains("#set heading(numbering: \"1.1\")"), "got: {}", out);
    }

    #[test]
    fn neither_directive_when_off() {
        let out = wrap(formal(), "body", &base());
        assert!(!out.contains("#set heading(numbering"));
        assert!(!out.contains("#set page(numbering"));
    }
}

// ───────────────────── registered styles ─────────────────────

static STYLES: &[Style] = &[
    Style {
        id: "formal",
        name: "Formal",
        preamble: FORMAL_PREAMBLE,
        csl: Some(FORMAL_CSL),
    },
];

/// White page, serif body, generous line spacing — the brief from the
/// initial spec. New Computer Modern Math is loaded for inline math so
/// `$x^2$` snippets don't fall back to a missing-glyph box.
const FORMAL_PREAMBLE: &str = r##"
#set page(
  paper: "us-letter",
  margin: (x: 1.25in, y: 1in),
  fill: white,
)
#set text(
  font: "Libertinus Serif",
  size: 11pt,
  lang: "en",
)
#set par(
  justify: true,
  leading: 0.85em,
  first-line-indent: 0pt,
  spacing: 1.2em,
)
#show heading: set text(weight: "semibold")
#show heading.where(level: 1): it => block(below: 1em)[#text(size: 1.4em)[#it]]
#show heading.where(level: 2): it => block(above: 1.4em, below: 0.6em)[#text(size: 1.2em)[#it]]
#show link: set text(fill: rgb("#1a4b8c"))
#show raw.where(block: true): block.with(
  fill: luma(245),
  inset: 8pt,
  radius: 4pt,
  width: 100%,
)
#show quote: set block(spacing: 1.2em)
#show quote.where(block: true): it => block(
  stroke: (left: 2pt + luma(180)),
  inset: (left: 1em, top: 0.4em, bottom: 0.4em),
  it.body,
)
"##;

/// CSL style for the Formal preset. Two non-obvious choices baked in:
///
///   - `<citation>` keeps the chicago-author-date shape: `(Author
///     Year)` inline, suppress the author when prose context already
///     names them, et-al collapse for 3+ authors.
///   - `<bibliography>` swaps the default by-author list for a
///     numbered list with `second-field-align="margin"` — Hayagriva
///     renders that as a two-column layout where the citation number
///     sits in a narrow left gutter and the entry body hangs in the
///     wider right column, matching the brief.
///
/// Entries are sorted by author then year so the visible numbering
/// reflects bibliography order, not citation order. That's the
/// chicago-author-date convention and avoids "[1]"-style surprise
/// where a later cite picks up a lower number.
const FORMAL_CSL: &str = r##"<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="sort-only" default-locale="en-US">
  <info>
    <title>Hush Formal (Author-Date, Numbered Bibliography)</title>
    <id>https://hush.app/styles/formal</id>
    <link href="https://hush.app/styles/formal" rel="self"/>
    <updated>2026-05-17T00:00:00+00:00</updated>
    <category citation-format="author-date"/>
    <summary>Chicago-style author-date inline citations with a numbered, gutter-aligned bibliography.</summary>
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
