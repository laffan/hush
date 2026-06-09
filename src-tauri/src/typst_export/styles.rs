/*!
Document-style registry.

A "style" is a small Typst preamble that lives in front of the
converted markdown body. Adding a new style means appending a `Style`
to the table at the bottom of this file — the frontend mirrors the
list in `src/sidebar/doc-export-styles.js` so users can pick one.

Constraints on a style preamble:

  - Must not depend on any `@preview/...` package — the World we ship
    has no package storage so those imports would fail at compile.
  - Must reference at least one font we know is available — either a
    `typst-assets` family (Libertinus Serif, New Computer Modern, DejaVu
    Sans Mono) or one of the faces Hush bundles in `world::EXTRA_FONTS`
    (the "Lato" sans-serif used by the Article style).
  - Should expose a `body` content slot via the conventional `#show`
    + `#set` pattern so the body emitted by the markdown converter
    drops in without further wrapping.
*/

pub struct Style {
    pub id: &'static str,
    pub name: &'static str,
    preamble: &'static str,
}

/// Per-export knobs that aren't baked into a style — these come from
/// the modal toggles. Keeping them here (rather than per-style)
/// because they're orthogonal: any style can choose to show or hide
/// page numbers, number its headings, and so on.
///
/// `bibliography` carries both "render a bibliography?" and "which
/// citation grammar?" in one slot — `Some` means yes, with the chosen
/// CSL; `None` means no bibliography (cites still resolve to a red
/// missing-marker, per `markdown::missing_cite_marker`).
pub struct WrapOptions {
    pub bibliography: Option<crate::typst_export::csl::CitationStyle>,
    pub number_headings: bool,
    pub page_numbers: bool,
    /// Multiplier exposed in the modal — 1.0, 1.5, or 2.0. Mapped to a
    /// concrete Typst `leading` value inside `wrap`.
    pub line_spacing: f32,
    /// Header-size multiplier from the modal's slider. Each style's
    /// preamble multiplies its per-level heading `em` sizes by the
    /// `header-scale` binding `wrap` emits, so the headings keep their
    /// relationship to one another while their size *relative to the
    /// body text* tracks the slider. `1.0` leaves the style's design
    /// sizes untouched.
    pub header_scale: f32,
}

pub fn lookup(id: &str) -> Option<&'static Style> {
    STYLES.iter().find(|s| s.id == id)
}

pub fn list() -> &'static [Style] {
    STYLES
}

/// Map a user-facing line-spacing multiplier to a Typst `leading`
/// value. Typst's default leading is ~0.65em; the formal preamble used
/// 0.85em for "1.5 line spacing" before this was made a knob.
fn leading_for(mult: f32) -> f32 {
    if mult >= 1.75 {
        1.5
    } else if mult <= 1.1 {
        0.45
    } else {
        0.85
    }
}

/// Compose the final Typst source: preamble → per-export overrides
/// → markdown body → optional bibliography directive.
///
/// Doc title is intentionally not rendered — the source markdown owns
/// its own front matter (a `#` heading if the author wants one), and
/// the export filename carries the document name into the OS.
pub fn wrap(style: &Style, body: &str, opts: &WrapOptions) -> String {
    let mut out = String::with_capacity(style.preamble.len() + body.len() + 256);

    // Header-size slider. The styles' preambles reference `header-scale`
    // when sizing each heading level, so binding it here (before the
    // preamble) scales every heading by the same factor — preserving the
    // levels' relationship while changing their size relative to the
    // body. Clamp to a sane range so a stray value can't blow the layout.
    let header_scale = if opts.header_scale.is_finite() {
        opts.header_scale.clamp(0.5, 3.0)
    } else {
        1.0
    };
    out.push_str(&format!("#let header-scale = {}\n", header_scale));

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

    // Override the preamble's default leading with whatever the modal
    // dropdown selected. Mapped to concrete em values that match the
    // visual feel of "single / 1.5 / double" spaced text at 11pt.
    let leading_em = leading_for(opts.line_spacing);
    out.push_str(&format!("#set par(leading: {}em)\n", leading_em));

    out.push('\n');
    out.push_str(body);

    if let Some(cite_style) = &opts.bibliography {
        // The bibliography file is registered at `/refs.yml` by the
        // World — Typst's `#bibliography()` accepts a path and a CSL
        // style argument (either a built-in name like "apa" or a path
        // to a CSL file registered alongside refs.yml).
        // `CitationStyle::typst_style_arg()` hands us the right one.
        //
        // Force a single column for the bibliography. On a multi-column
        // style (Article) the reference list reads better full-width;
        // placing the `#set page(columns: 1)` right after the pagebreak
        // applies it to the bibliography page. On single-column styles
        // (Formal) it's a harmless no-op.
        out.push_str("\n#pagebreak()\n");
        out.push_str("#set page(columns: 1)\n");
        out.push_str(&format!(
            "#bibliography(\"/refs.yml\", style: \"{}\")\n",
            cite_style.typst_style_arg()
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
            bibliography: None,
            number_headings: false,
            page_numbers: false,
            line_spacing: 1.5,
            header_scale: 1.0,
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

    #[test]
    fn header_scale_binding_emitted() {
        let scaled = wrap(formal(), "body", &WrapOptions { header_scale: 1.5, ..base() });
        assert!(scaled.contains("#let header-scale = 1.5"), "got: {}", scaled);
        // Out-of-range values clamp rather than passing through raw.
        let huge = wrap(formal(), "body", &WrapOptions { header_scale: 99.0, ..base() });
        assert!(huge.contains("#let header-scale = 3"), "got: {}", huge);
    }

    #[test]
    fn line_spacing_emitted_in_wrap() {
        let single = wrap(formal(), "body", &WrapOptions { line_spacing: 1.0, ..base() });
        assert!(single.contains("#set par(leading: 0.45em)"), "got: {}", single);
        let one_half = wrap(formal(), "body", &WrapOptions { line_spacing: 1.5, ..base() });
        assert!(one_half.contains("#set par(leading: 0.85em)"), "got: {}", one_half);
        let double = wrap(formal(), "body", &WrapOptions { line_spacing: 2.0, ..base() });
        assert!(double.contains("#set par(leading: 1.5em)"), "got: {}", double);
    }
}

// ───────────────────── registered styles ─────────────────────

static STYLES: &[Style] = &[
    Style {
        id: "formal",
        name: "Formal",
        preamble: FORMAL_PREAMBLE,
    },
    Style {
        id: "article-2col",
        name: "Article (2 Column)",
        preamble: ARTICLE_TWO_COLUMN_PREAMBLE,
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
  first-line-indent: (amount: 1.5em, all: false),
  spacing: 1.2em,
)
#show heading: set text(weight: "semibold")
#show heading.where(level: 1): it => block(below: 1.8em)[#text(size: header-scale * 1.4em)[#it]]
#show heading.where(level: 2): it => block(above: 1.4em, below: 1.4em)[#text(size: header-scale * 1.2em)[#it]]
#show heading.where(level: 3): it => block(above: 1.1em, below: 1.1em)[#text(size: header-scale * 1.05em)[#it]]
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

/// Two-column, sans-serif magazine/journal layout. Uses the bundled
/// "Karla" face (registered in `world::extra_font_blobs`) since
/// `typst-assets` has no proportional sans of its own. Body text is a
/// touch smaller than the Formal style because two columns are narrower.
const ARTICLE_TWO_COLUMN_PREAMBLE: &str = r##"
#set page(
  paper: "us-letter",
  margin: (x: 1in, y: 1in),
  fill: white,
  columns: 2,
)
#set text(
  font: "Karla",
  size: 9.5pt,
  lang: "en",
)
#set par(
  justify: true,
  leading: 0.7em,
  first-line-indent: (amount: 1.2em, all: false),
  spacing: 0.9em,
)
#show heading: set text(weight: "bold")
#show heading.where(level: 1): it => block(above: 1.4em, below: 1.1em)[#text(size: header-scale * 1.5em)[#it]]
#show heading.where(level: 2): it => block(above: 2em, below: 0.7em)[#text(size: header-scale * 1.2em)[#it]]
#show heading.where(level: 3): it => block(above: 1.5em, below: 0.6em)[#text(size: header-scale * 1.05em)[#it]]
#show link: set text(fill: rgb("#1a4b8c"))
#show raw.where(block: true): block.with(
  fill: luma(245),
  inset: 6pt,
  radius: 3pt,
  width: 100%,
)
#show quote: set block(spacing: 1em)
#show quote.where(block: true): it => block(
  stroke: (left: 2pt + luma(180)),
  inset: (left: 0.8em, top: 0.3em, bottom: 0.3em),
  it.body,
)
"##;

