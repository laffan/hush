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
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub enum CitationMode {
    /// Replace citation-shaped links with Typst `@citekey` references.
    /// The supplied set lists the citekeys present in the bibliography
    /// — anything else renders as a visible "missing reference" marker
    /// so the export still succeeds.
    Resolve { known_keys: HashSet<String> },
    /// Strip the brackets and the deep-link URL, leaving the bare key.
    Strip,
}

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

    if out.ends_with('\n') { out } else { out + "\n" }
}

// ───────────────────── citation sentinels ─────────────────────

// Unit-Separator brackets a citekey through pulldown and the markup
// escape pass. The escape table excludes ASCII control characters, so
// these survive untouched.
const CITE_OPEN: char = '\x1F';
const CITE_CLOSE: char = '\x1E';

fn preprocess_cites(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some((key, consumed)) = parse_bracket_cite(&s[i..]) {
                out.push(CITE_OPEN);
                out.push_str(key);
                out.push(CITE_CLOSE);
                i += consumed;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn expand_cite_sentinels(s: &str, mode: &CitationMode) -> String {
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
        match mode {
            // Function form sidesteps the whitespace-sensitive `@key`
            // markup rules, so cites that sit flush against adjacent
            // text (`acts[@mandolessi2024]`) still resolve cleanly. If
            // the key isn't in the supplied bibliography we render a
            // visible "missing" marker instead of `#cite(...)` — the
            // latter would fail compilation and sink the whole export.
            CitationMode::Resolve { known_keys } => {
                if known_keys.contains(&key) {
                    out.push_str("#cite(<");
                    out.push_str(&key);
                    out.push_str(">)");
                } else {
                    out.push_str(&missing_cite_marker(&key));
                }
            }
            CitationMode::Strip => out.push_str(&key),
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

struct Emitter {
    list_stack: Vec<ListKind>,
    /// Set while inside a Link so Text events accumulate into a buffer
    /// the link handler can sniff before deciding how to emit.
    pending: Option<PendingLink>,
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

impl Emitter {
    fn new() -> Self {
        Self {
            list_stack: Vec::new(),
            pending: None,
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
        if let Some(p) = self.pending.as_mut() {
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
                let path = image_path(&dest_url);
                let caption = if title.is_empty() {
                    String::new()
                } else {
                    format!(", caption: [{}]", escape_typst_text(&title))
                };
                out.push_str(&format!(
                    "\n#figure(image(\"{}\", width: 80%){})\n\n",
                    escape_string(&path),
                    caption
                ));
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
            TagEnd::Image
            | TagEnd::HtmlBlock
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

fn is_citekey_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '+')
}

/// Escape a string for use inside Typst `"..."` literals.
fn escape_string(s: &str) -> String {
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
