/*!
Markdown → Typst conversion.

Designed for the kind of markdown Hush docs actually contain, not the
full CommonMark surface. The strategy:

  - Block-level tags (headings, lists, blockquotes, code blocks) emit
    Typst block syntax (`=`, `-`, `+`, `> quote`, raw blocks).
  - Inline text is escaped so user content can't accidentally turn into
    Typst markup. We then re-emit emphasis/strong/code/links/images as
    Typst markup ourselves.
  - The two Hush citation shapes —
        [@citekey]
        [@citekey](zotero://select/library/...)
    — collapse to native Typst cite syntax (`@citekey`) when the caller
    asked for citations, and to the bare citekey text otherwise. We do
    this in two places:
        * Inside text events for the bracket-only form (pulldown emits
          it as plain text since there's no `(...)`).
        * Inside link events for the bracket+URL form.

When in doubt: a slightly degraded rendering beats refusing to compile.
*/

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use super::citations::{expand_cite_sentinels, preprocess_cites};
use super::preprocess::{TAB_MARKER_CLOSE, TAB_MARKER_OPEN};

pub use super::citations::CitationMode;

pub fn to_typst(markdown: &str, cite_mode: CitationMode) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);

    // Hush stitches project docs together with `---hush-separator---`
    // lines. The sidebar export already strips them, but if any sneak
    // through we drop them here so they don't appear as a literal HR.
    let cleaned: String = markdown
        .lines()
        .filter(|l| l.trim() != "---hush-separator---")
        .collect::<Vec<_>>()
        .join("\n");

    // Pulldown splits `[@key]` into three text events ('[' / '@key' /
    // ']'), so we can't recognise the bracket form during the event
    // walk. Pre-process the source first, turning every citation shape
    // into an inert sentinel that survives both pulldown and the
    // markup-escape pass below; then expand the sentinel in a single
    // pass after the markdown has been converted.
    let with_sentinels = preprocess_cites(&cleaned);

    let parser = Parser::new_ext(&with_sentinels, opts);
    let mut emitter = Emitter::new();
    let mut out = String::with_capacity(with_sentinels.len() + 128);
    for event in parser {
        emitter.handle(event, &mut out);
    }
    let out = expand_cite_sentinels(&out, &cite_mode);
    let out = expand_tab_sentinels(&out);
    let out = super::notes::expand_footnote_sentinels(&out);

    if out.ends_with('\n') { out } else { out + "\n" }
}

// ───────────────────── tab marker sentinels ─────────────────────

/// Replace each `\x1D…\x1C` run (planted by `preprocess::process_tabs`)
/// with a centred rounded pill carrying the tab's path label. The pill
/// visual mirrors the editor's `.cm-tab-marker-pill` so the printed
/// page reads the same way the editor surface does.
fn expand_tab_sentinels(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != TAB_MARKER_OPEN {
            out.push(c);
            continue;
        }
        let mut label = String::new();
        for k in chars.by_ref() {
            if k == TAB_MARKER_CLOSE {
                break;
            }
            label.push(k);
        }
        // The label arrived through `escape_typst_text` already (text
        // events run through the escape pass), so we feed it into the
        // box body verbatim — re-escaping would double-backslash any
        // glyphs the user put in the tab name.
        out.push_str(
            "\n#align(center)[#box(\
stroke: 0.5pt + luma(160), \
radius: 999pt, \
fill: luma(245), \
inset: (x: 0.9em, y: 0.3em))[#text(size: 0.85em, fill: luma(80))[",
        );
        out.push_str(&label);
        out.push_str("]]]\n\n");
    }
    out
}

struct Emitter {
    list_stack: Vec<ListKind>,
    /// Set while inside a Link so Text events accumulate into a buffer
    /// the link handler can sniff before deciding how to emit.
    pending: Option<PendingLink>,
    /// Set while inside an Image so the alt text accumulates into a
    /// buffer; the figure (with caption) is emitted on image end.
    image: Option<PendingImage>,
    code_block: Option<String>,
}

#[derive(Clone, Copy)]
enum ListKind {
    Bullet,
    Ordered,
}

struct PendingLink {
    url: String,
    title: String,
    text: String,
}

struct PendingImage {
    path: String,
    /// Markdown title (`![alt](url "title")`) — wins as the caption when present.
    title: String,
    /// Bracket contents (`alt` or `alt|caption`), accumulated raw.
    alt: String,
}

impl Emitter {
    fn new() -> Self {
        Self {
            list_stack: Vec::new(),
            pending: None,
            image: None,
            code_block: None,
        }
    }

    fn handle(&mut self, event: Event<'_>, out: &mut String) {
        match event {
            Event::Start(tag) => self.start(tag, out),
            Event::End(tag) => self.end(tag, out),
            Event::Text(t) => self.text(&t, out),
            Event::Code(c) => self.write(&format!("`{}`", c.replace('`', "\\`")), out),
            Event::Html(h) | Event::InlineHtml(h) => {
                // Escape HTML so it shows up as text — Typst doesn't
                // render raw HTML. Styles can override later.
                self.write(&escape_typst_text(&h), out);
            }
            Event::SoftBreak => self.write(" ", out),
            Event::HardBreak => self.write(" \\ \n", out),
            Event::Rule => out.push_str("\n#line(length: 100%, stroke: 0.4pt + gray)\n\n"),
            Event::FootnoteReference(name) => {
                self.write(&format!("#footnote[see {}]", escape_typst_text(&name)), out);
            }
            Event::TaskListMarker(done) => {
                self.write(if done { "[x] " } else { "[ ] " }, out);
            }
            Event::InlineMath(m) => self.write(&format!("${}$", m), out),
            Event::DisplayMath(m) => out.push_str(&format!("\n$ {} $\n\n", m)),
        }
    }

    fn write(&mut self, s: &str, out: &mut String) {
        if let Some(img) = self.image.as_mut() {
            img.alt.push_str(s);
        } else if let Some(p) = self.pending.as_mut() {
            p.text.push_str(s);
        } else if let Some(buf) = self.code_block.as_mut() {
            buf.push_str(s);
        } else {
            out.push_str(s);
        }
    }

    fn text(&mut self, t: &str, out: &mut String) {
        // Raw code blocks keep text literal; link bodies keep text raw
        // so the link handler can re-escape its own way. Everywhere
        // else, escape Typst markup chars. Citation sentinels are
        // ASCII control characters that the escape table leaves alone,
        // so they survive intact for expansion at the end of the run.
        if self.code_block.is_some() {
            self.write(t, out);
        } else if self.pending.is_some() {
            self.write(t, out);
        } else if self.image.is_some() {
            // Keep the alt/caption raw; the caption is escaped once on
            // image end after the `alt|caption` split.
            self.write(t, out);
        } else {
            self.write(&escape_typst_text(t), out);
        }
    }

    fn start(&mut self, tag: Tag<'_>, out: &mut String) {
        match tag {
            Tag::Paragraph => { /* nothing — let content flow */ }
            Tag::Heading { level, .. } => {
                let depth = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
                out.push('\n');
                for _ in 0..depth {
                    out.push('=');
                }
                out.push(' ');
            }
            Tag::BlockQuote(_) => out.push_str("\n#quote(block: true)[\n"),
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    pulldown_cmark::CodeBlockKind::Fenced(l) => l.to_string(),
                    pulldown_cmark::CodeBlockKind::Indented => String::new(),
                };
                self.code_block = Some(format!("```{}\n", lang));
            }
            Tag::List(start) => {
                self.list_stack.push(match start {
                    Some(_) => ListKind::Ordered,
                    None => ListKind::Bullet,
                });
            }
            Tag::Item => {
                out.push('\n');
                for _ in 1..self.list_stack.len() {
                    out.push_str("  ");
                }
                match self.list_stack.last() {
                    Some(ListKind::Ordered) => out.push_str("+ "),
                    _ => out.push_str("- "),
                }
            }
            // Always use the function form so positions like
            // `*shape*attention` (intra-word) and `a*rs foo*` (mid-word
            // open) don't trip Typst's whitespace-sensitive emphasis
            // markup. Renders identically to `_..._` / `*...*`.
            Tag::Emphasis => self.write("#emph[", out),
            Tag::Strong => self.write("#strong[", out),
            Tag::Strikethrough => self.write("#strike[", out),
            Tag::Link { dest_url, title, .. } => {
                self.pending = Some(PendingLink {
                    url: dest_url.to_string(),
                    title: title.to_string(),
                    text: String::new(),
                });
            }
            Tag::Image { dest_url, title, .. } => {
                // Resolve image URL to one of:
                //  - /<filename>  for refs we have bytes for (Typst
                //    will read via World::file).
                //  - http(s)://...  passed through; will fail inside
                //    Typst (no network) and surface as a diagnostic.
                // Defer the figure to TagEnd::Image so the alt text (which
                // arrives as Text events between start and end) can be
                // captured. Hush images carry the caption after a pipe
                // (`![alt|caption](url)`); the figure caption shows that
                // caption, not the alt text.
                self.image = Some(PendingImage {
                    path: image_path(&dest_url),
                    title: title.to_string(),
                    alt: String::new(),
                });
            }
            Tag::Table(_) => out.push_str("\n#table(columns: auto,\n"),
            Tag::TableHead | Tag::TableRow => {}
            Tag::TableCell => out.push_str("  ["),
            Tag::FootnoteDefinition(_) => out.push_str("\n#footnote[\n"),
            Tag::HtmlBlock
            | Tag::MetadataBlock(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition => {}
            Tag::Superscript => self.write("#super[", out),
            Tag::Subscript => self.write("#sub[", out),
        }
    }

    fn end(&mut self, tag: TagEnd, out: &mut String) {
        match tag {
            TagEnd::Paragraph => out.push_str("\n\n"),
            TagEnd::Heading(_) => out.push_str("\n\n"),
            TagEnd::BlockQuote(_) => out.push_str("\n]\n\n"),
            TagEnd::CodeBlock => {
                if let Some(mut buf) = self.code_block.take() {
                    if !buf.ends_with('\n') {
                        buf.push('\n');
                    }
                    buf.push_str("```\n\n");
                    out.push('\n');
                    out.push_str(&buf);
                }
            }
            TagEnd::List(_) => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    out.push_str("\n\n");
                }
            }
            TagEnd::Item => { /* spacing handled by next Item or List end */ }
            TagEnd::Emphasis => self.write("]", out),
            TagEnd::Strong => self.write("]", out),
            TagEnd::Strikethrough => self.write("]", out),
            TagEnd::Link => {
                if let Some(p) = self.pending.take() {
                    let emitted = self.emit_link(&p);
                    out.push_str(&emitted);
                }
            }
            TagEnd::Image => {
                if let Some(img) = self.image.take() {
                    // Caption precedence: an explicit markdown title wins;
                    // otherwise the text after the first `|` in the alt
                    // (Hush's `![alt|caption](url)` form). A bare alt with
                    // no caption shows no caption at all — the alt is
                    // typically just the image id/filename.
                    let caption_text = if !img.title.is_empty() {
                        img.title.clone()
                    } else if let Some(idx) = img.alt.find('|') {
                        img.alt[idx + 1..].trim().to_string()
                    } else {
                        String::new()
                    };
                    let caption = if caption_text.is_empty() {
                        String::new()
                    } else {
                        format!(", caption: [{}]", escape_typst_text(&caption_text))
                    };
                    out.push_str(&format!(
                        "\n#figure(image(\"{}\", width: 80%){})\n\n",
                        escape_string(&img.path),
                        caption
                    ));
                }
            }
            TagEnd::HtmlBlock
            | TagEnd::MetadataBlock(_)
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition => {}
            TagEnd::Table => out.push_str(")\n\n"),
            TagEnd::TableHead | TagEnd::TableRow => out.push('\n'),
            TagEnd::TableCell => out.push_str("],\n"),
            TagEnd::FootnoteDefinition => out.push_str("\n]\n\n"),
            TagEnd::Superscript | TagEnd::Subscript => self.write("]", out),
        }
    }

    fn emit_link(&self, p: &PendingLink) -> String {
        // Citation links (`[@key](zotero://...)`) never reach this
        // branch — the citation pre-processor in `to_typst` rewrites
        // them before pulldown sees them.
        let escaped_text = if p.text.is_empty() {
            String::new()
        } else {
            escape_typst_text(&p.text)
        };
        let title_attr = if p.title.is_empty() {
            String::new()
        } else {
            format!(", \"{}\"", escape_string(&p.title))
        };
        // Bare URL (no display text) renders as the link itself.
        if escaped_text.is_empty() {
            format!("#link(\"{}\"{})", escape_string(&p.url), title_attr)
        } else {
            format!(
                "#link(\"{}\")[{}]",
                escape_string(&p.url),
                escaped_text
            )
        }
    }
}

/// Escape a string for use inside Typst `"..."` literals.
pub(super) fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escape arbitrary text so it renders verbatim inside Typst markup.
/// `=` is in the list so a `==FLAG==` line that the user opted not to
/// strip doesn't accidentally turn into a Typst heading.
fn escape_typst_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '#' | '*' | '_' | '$' | '`' | '<' | '>' | '@' | '\\' | '[' | ']' | '=' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn image_path(dest_url: &str) -> String {
    if dest_url.starts_with("http://") || dest_url.starts_with("https://") {
        return dest_url.to_string();
    }
    let trimmed = dest_url.trim_start_matches("./");
    let trimmed = trimmed.trim_start_matches("images/");
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{}", trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_with(keys: &[&str]) -> CitationMode {
        CitationMode::Resolve {
            known_keys: keys.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn citation_bracket_resolve() {
        let out = to_typst(
            "See [@halbwachs1992] for context.",
            resolve_with(&["halbwachs1992"]),
        );
        assert!(out.contains("#cite(<halbwachs1992>)"), "got: {}", out);
    }

    #[test]
    fn citation_bracket_strip() {
        let out = to_typst("See [@halbwachs1992] for context.", CitationMode::Strip);
        assert!(out.contains("halbwachs1992"), "got: {}", out);
        assert!(!out.contains("#cite"), "got: {}", out);
    }

    #[test]
    fn citation_link_resolve() {
        let src = "See [@halbwachs1992](zotero://select/library/items/ABC123).";
        let out = to_typst(src, resolve_with(&["halbwachs1992"]));
        assert!(out.contains("#cite(<halbwachs1992>)"), "got: {}", out);
        assert!(!out.contains("zotero://"), "got: {}", out);
    }

    /// Regression: `*shape*attention` (intra-word emphasis) used to
    /// produce `_shape_attention`, which Typst rejected because the
    /// closing `_` had no whitespace boundary. Function form fixes it.
    #[test]
    fn intra_word_emphasis_renders_through_function_form() {
        let out = to_typst("Past experiences *shape*attention here.", CitationMode::Strip);
        assert!(out.contains("#emph[shape]attention"), "got: {}", out);
    }

    /// Regression: `acts[@key]` used to expand to `acts@key`, but
    /// Typst's `@`-reference markup requires whitespace before the
    /// `@`. Function form sidesteps that.
    #[test]
    fn cite_flush_against_text() {
        let out = to_typst(
            "collective acts[@mandolessi2024].",
            resolve_with(&["mandolessi2024"]),
        );
        assert!(out.contains("acts#cite(<mandolessi2024>)."), "got: {}", out);
    }

    /// Regression: `_mimesis_@key` previously left an unclosed `_`
    /// because Typst's emphasis close needs whitespace/punctuation
    /// after, and `@` started a reference instead.
    #[test]
    fn emphasis_immediately_followed_by_cite() {
        let out = to_typst(
            "but *mimesis*[@mandolessi2024]. End.",
            resolve_with(&["mandolessi2024"]),
        );
        assert!(
            out.contains("#emph[mimesis]#cite(<mandolessi2024>)"),
            "got: {}",
            out
        );
    }

    /// A citekey that isn't in the bibliography renders as a red
    /// marker rather than failing the compile. The marker keeps the
    /// bracket-form `[@key]` shape so the user can spot what's
    /// missing on the page.
    #[test]
    fn missing_cite_renders_as_visible_marker() {
        let out = to_typst(
            "See [@notfound2099] and [@known2020] later.",
            resolve_with(&["known2020"]),
        );
        assert!(out.contains("rgb(\"#c0392b\")"), "missing marker absent: {}", out);
        assert!(out.contains("\\@notfound2099"), "key not surfaced: {}", out);
        assert!(!out.contains("#cite(<notfound2099>)"), "missing cite emitted as live ref: {}", out);
        assert!(out.contains("#cite(<known2020>)"), "known cite swapped: {}", out);
    }

    /// Semicolon-chained citations — `[@a](url);@b;@c;[@d](url)` —
    /// resolve every key in the chain, emitting adjacent #cite calls so
    /// Typst groups them into one citation.
    #[test]
    fn citation_chain_resolve() {
        let src = "See [@adriaansen2025](zotero://select/library/items/JN3KPW6D);@hoskins2011;@hoskins2016;[@bendavid2024](zotero://select/library/items/4LG9HWU6).";
        let out = to_typst(
            src,
            resolve_with(&["adriaansen2025", "hoskins2011", "hoskins2016", "bendavid2024"]),
        );
        assert!(
            out.contains("#cite(<adriaansen2025>)#cite(<hoskins2011>)#cite(<hoskins2016>)#cite(<bendavid2024>)"),
            "got: {}",
            out
        );
        assert!(!out.contains("zotero://"), "got: {}", out);
    }

    #[test]
    fn citation_chain_strip() {
        let out = to_typst("See [@a2020];@b2021;@c2022.", CitationMode::Strip);
        assert!(out.contains("a2020; b2021; c2022"), "got: {}", out);
        assert!(!out.contains("#cite"), "got: {}", out);
    }

    /// A semicolon that isn't followed by a citation ends the chain —
    /// the rest of the text renders normally.
    #[test]
    fn citation_chain_stops_at_non_cite() {
        let out = to_typst(
            "See [@a2020];later text.",
            resolve_with(&["a2020"]),
        );
        assert!(out.contains("#cite(<a2020>);later text"), "got: {}", out);
    }

    #[test]
    fn citation_inline_mode_formats_label() {
        let mut formatted = std::collections::HashMap::new();
        formatted.insert("halbwachs1992".to_string(), "(Halbwachs 1992)".to_string());
        let out = to_typst(
            "See [@halbwachs1992] for context.",
            CitationMode::Inline { formatted },
        );
        assert!(out.contains("(Halbwachs 1992)"), "got: {}", out);
        assert!(!out.contains("#cite"), "got: {}", out);
        assert!(!out.contains("halbwachs1992"), "raw citekey leaked: {}", out);
    }

    #[test]
    fn citation_inline_mode_missing_key_marks_red() {
        let out = to_typst(
            "See [@notfound2099] here.",
            CitationMode::Inline { formatted: std::collections::HashMap::new() },
        );
        assert!(out.contains("rgb(\"#c0392b\")"), "missing marker absent: {}", out);
    }

    #[test]
    fn headings_and_emphasis() {
        let out = to_typst("# Title\n\n*bold* and _ital_.", CitationMode::Strip);
        assert!(out.contains("= Title"), "got: {}", out);
    }

    #[test]
    fn ordinary_link_preserved() {
        let out = to_typst("[hush](https://example.com)", CitationMode::Strip);
        assert!(out.contains("#link("), "got: {}", out);
        assert!(out.contains("hush"));
    }

    #[test]
    fn at_sign_in_body_escaped() {
        let out = to_typst("Email user@example.com.", resolve_with(&[]));
        assert!(out.contains("\\@example"), "got: {}", out);
    }
}
