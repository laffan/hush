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
}

pub fn lookup(id: &str) -> Option<&'static Style> {
    STYLES.iter().find(|s| s.id == id)
}

pub fn list() -> &'static [Style] {
    STYLES
}

/// Compose the final Typst source: preamble → optional title block →
/// markdown body → optional bibliography directive.
pub fn wrap(style: &Style, body: &str, with_bibliography: bool, title: Option<&str>) -> String {
    let mut out = String::with_capacity(style.preamble.len() + body.len() + 128);
    out.push_str(style.preamble);
    out.push('\n');

    if let Some(t) = title {
        let escaped = escape_title(t);
        out.push_str(&format!("\n#align(center)[#text(size: 18pt, weight: \"bold\")[{}]]\n\n", escaped));
    }

    out.push_str(body);

    if with_bibliography {
        // The bibliography file is registered at `/refs.yml` by the
        // World — Typst's `bibliography()` accepts a path and a style
        // name ("ieee", "apa", "chicago-author-date", etc.). We pick
        // chicago-author-date so inline `@key` references render as
        // (Author Year) which is what the spec asked for.
        out.push_str("\n#pagebreak()\n");
        out.push_str("#bibliography(\"/refs.yml\", style: \"chicago-author-date\")\n");
    }

    out
}

fn escape_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '#' | '*' | '_' | '$' | '`' | '<' | '>' | '@' | '\\' | '[' | ']' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

// ───────────────────── registered styles ─────────────────────

static STYLES: &[Style] = &[
    Style {
        id: "formal",
        name: "Formal",
        preamble: FORMAL_PREAMBLE,
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
