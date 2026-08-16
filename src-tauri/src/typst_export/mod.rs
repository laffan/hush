/*!
Typst-backed PDF export for docs (and, eventually, projects).

Pipeline:
  1. Caller hands us markdown source, a style id, an optional set of
     Zotero references, and a map of image filenames → bytes.
  2. `markdown::to_typst` walks the markdown with pulldown-cmark and
     emits Typst source. Citation links of the form `[@key]` and
     `[@key](zotero://...)` collapse to native Typst `@key`s.
  3. `styles::wrap` prepends a preamble for the chosen style (the only
     style today is `formal`).
  4. `bibliography::to_hayagriva_yaml` produces a YAML file from the
     Zotero references that the wrapped document references via
     `#bibliography("refs.yml")`.
  5. `world::ExportWorld` exposes the synthesised main source, the
     bibliography, and every image as virtual files and hands them to
     `typst::compile` → `typst_pdf::pdf`.

Every file is virtual — nothing touches the user's disk. That keeps the
pipeline deterministic and avoids tempfile permissions issues on iOS.
*/

pub mod bibliography;
pub mod citations;
pub mod code;
pub mod csl;
pub mod images;
pub mod markdown;
pub mod notes;
pub mod preprocess;
pub mod styles;
pub mod world;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroRef {
    // The Zotero item id. We don't use it on the Rust side but accept
    // it so the JSON shape lines up with what the frontend has on
    // hand — easier than asking JS to strip fields.
    #[allow(dead_code)]
    pub key: String,
    #[serde(default)]
    pub citekey: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub authors: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub item_type: String,
}

#[derive(Debug, Deserialize)]
pub struct ImageInput {
    pub filename: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub markdown: String,
    pub style_id: String,
    /// When true and `references` is non-empty, a bibliography section is
    /// rendered (and inline cites resolve through Typst's CSL machinery).
    /// When false, inline citations are *still* formatted — as author-date
    /// `(Author Year)` labels built directly from the reference metadata —
    /// so the prose never shows bare citekeys; only the bibliography list
    /// is omitted. Named `include_citations` for IPC back-compat; it now
    /// gates the bibliography specifically.
    pub include_citations: bool,
    /// One of the ids from `csl::list()`. Falls back to the default
    /// (`csl::default_id()`) if the value is missing or unrecognised
    /// — keeps an old frontend usable against a new backend without
    /// erroring on a stale value.
    #[serde(default = "default_cite_style")]
    pub citation_style: String,
    /// Drop `%% comment %%` blocks and `---%`/separator regions before
    /// rendering — defaults exposed by the modal default to true.
    #[serde(default = "true_default")]
    pub strip_comments: bool,
    /// Drop `==FLAG==` / `==FLAG: body==` runs before rendering.
    #[serde(default = "true_default")]
    pub strip_flags: bool,
    /// Apply `1`, `1.1`, `1.1.1` numbering to headings.
    #[serde(default)]
    pub number_headings: bool,
    /// Footer page numbers.
    #[serde(default = "true_default")]
    pub page_numbers: bool,
    /// Render `---Tab---` markers as a centred pill block in the PDF.
    /// When false, marker lines are dropped entirely.
    #[serde(default = "true_default")]
    pub include_tabs: bool,
    /// Line-spacing multiplier (1.0 / 1.5 / 2.0). Mapped to a concrete
    /// Typst `leading` value inside `styles::wrap`.
    #[serde(default = "default_line_spacing")]
    pub line_spacing: f32,
    /// Header-size multiplier from the modal slider (default 1.0). Scales
    /// every heading level by the same factor — see `styles::WrapOptions`.
    #[serde(default = "default_header_scale")]
    pub header_scale: f32,
    /// Extra space above every heading, in `em` (modal slider, 0 = the
    /// style's own spacing). See `styles::WrapOptions::heading_space`.
    #[serde(default)]
    pub heading_space: f32,
    #[serde(default)]
    pub references: Vec<ZoteroRef>,
    #[serde(default)]
    pub images: Vec<ImageInput>,
}

fn true_default() -> bool { true }
fn default_cite_style() -> String { csl::default_id().to_string() }
fn default_line_spacing() -> f32 { 1.5 }
fn default_header_scale() -> f32 { 1.0 }

pub fn render_pdf(req: &ExportRequest) -> Result<Vec<u8>, String> {
    let style = styles::lookup(&req.style_id)
        .ok_or_else(|| format!("unknown style: {}", req.style_id))?;

    let cleaned_md = preprocess::run(
        &req.markdown,
        req.strip_comments,
        req.strip_flags,
        req.include_tabs,
    );

    let have_refs = !req.references.is_empty();
    // `include_citations` now means "render the bibliography section". The
    // bibliography path needs references to exist; without them we can't
    // render one regardless of the flag.
    let render_bibliography = req.include_citations && have_refs;

    let cite_mode = if !have_refs {
        // No reference data at all — leave the bare key (nothing better
        // to show).
        markdown::CitationMode::Strip
    } else if render_bibliography {
        // The bibliography emitter dedupes by citekey, so the set we
        // hand the markdown converter mirrors what actually ends up in
        // refs.yml. Anything not in this set renders as a red marker
        // rather than a `#cite(...)` that would fail compilation.
        let known: std::collections::HashSet<String> = req
            .references
            .iter()
            .filter(|r| !r.citekey.is_empty())
            .map(|r| r.citekey.clone())
            .collect();
        markdown::CitationMode::Resolve { known_keys: known }
    } else {
        // Bibliography off, but we have reference metadata — format each
        // cite as an inline author-date label so the prose never shows a
        // raw citekey.
        let formatted: std::collections::HashMap<String, String> = req
            .references
            .iter()
            .filter(|r| !r.citekey.is_empty())
            .map(|r| (r.citekey.clone(), bibliography::inline_citation(r)))
            .collect();
        markdown::CitationMode::Inline { formatted }
    };

    // The images that actually made it into the request are the ones
    // the World will be able to serve — `collect_images` drops the rest
    // — so this set is exactly what the converter needs to tell a live
    // reference from a dead one.
    let available_images: std::collections::HashSet<String> = req
        .images
        .iter()
        .map(|i| images::normalize_path(&i.filename))
        .collect();

    let body = markdown::to_typst(&cleaned_md, cite_mode, &available_images);
    let bib_yaml = if render_bibliography {
        Some(bibliography::to_hayagriva_yaml(&req.references))
    } else {
        None
    };

    // Resolve the citation style now — unknown ids fall back to the
    // default so a stale frontend value doesn't kill the export.
    let cite_style = if render_bibliography {
        Some(
            csl::resolve(&req.citation_style)
                .or_else(|| csl::resolve(csl::default_id()))
                .expect("default citation style id must resolve"),
        )
    } else {
        None
    };

    let wrap_opts = styles::WrapOptions {
        bibliography: cite_style,
        number_headings: req.number_headings,
        page_numbers: req.page_numbers,
        line_spacing: req.line_spacing,
        header_scale: req.header_scale,
        heading_space: req.heading_space,
    };
    let main_source = styles::wrap(style, &body, &wrap_opts);

    let world = world::ExportWorld::new(
        main_source.clone(),
        bib_yaml,
        // Custom CSL (when the chosen citation style is a `Custom`
        // variant) gets registered at `/style.csl` so
        // `#bibliography(style: "/style.csl")` resolves. Built-in
        // names need no virtual file — Typst looks them up internally.
        cite_style.and_then(|s| s.custom_bytes()),
        req.images
            .iter()
            .map(|i| (i.filename.clone(), i.bytes.clone()))
            .collect(),
    );

    let warned = typst::compile::<typst::layout::PagedDocument>(&world);
    let document = warned.output.map_err(|errs| {
        let dump = dump_failing_source(&main_source);
        format!(
            "{}{}",
            format_diagnostics("compile", &errs, &world),
            dump,
        )
    })?;

    let pdf_opts = typst_pdf::PdfOptions::default();
    typst_pdf::pdf(&document, &pdf_opts).map_err(|errs| {
        let dump = dump_failing_source(&main_source);
        format!(
            "{}{}",
            format_diagnostics("pdf", &errs, &world),
            dump,
        )
    })
}

/// On failure, write the generated `.typ` source to a temp file and
/// return a `\n  source: <path>` suffix the error formatter appends to
/// its message. Writing it once we know we're already on the error
/// path keeps the happy path allocation-free.
fn dump_failing_source(source: &str) -> String {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.push(format!("hush-typst-failed-{}.typ", stamp));
    match std::fs::write(&path, source) {
        Ok(()) => format!("\n  source: {}", path.display()),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_minimal_doc() {
        let req = ExportRequest {
            markdown: "# Hello\n\nA paragraph with *bold* text.".into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000, "PDF unexpectedly small: {} bytes", pdf.len());
        assert_eq!(&pdf[..4], b"%PDF", "missing PDF magic");
    }

    /// No markdown position may let a bare `#tag` reach the Typst
    /// source as code. Every one of these used to be a live way to lose
    /// an export: Typst reads `#word` as a variable, so one hashtag in
    /// the prose is a hard compile failure for the whole document.
    #[test]
    fn hash_never_leaks_as_typst_code() {
        let cases: Vec<(&str, String)> = vec![
            ("plain", "A tag #ongoing here.".into()),
            ("footnote body", "Text[^1]\n\n[^1]: note about #ongoing".into()),
            ("link label", "[#ongoing](http://x)".into()),
            ("heading", "## Heading #ongoing".into()),
            ("table cell", "| a | b |\n|---|---|\n| #ongoing | y |".into()),
            ("list item", "- item #ongoing".into()),
            ("emphasis", "*#ongoing*".into()),
            ("blockquote", "> quoted #ongoing".into()),
            ("image alt", "![#ongoing](pic.png)".into()),
            ("task list", "- [ ] todo #ongoing".into()),
            ("tab marker", "---Tab #ongoing---\n\nbody".into()),
            ("comment anchor", "{>text #ongoing<ab}\n\n[>ab]: note".into()),
            ("strikethrough", "~~#ongoing~~".into()),
            ("html", "<span>#ongoing</span>".into()),
            ("after a nested fence", "````\n```\n````\n\ntag #ongoing".into()),
            ("after inline backticks", "`` a`b `` then #ongoing".into()),
        ];
        let mut leaks = Vec::new();
        for (label, md) in cases {
            let cleaned = preprocess::run(&md, true, true, true);
            let body = markdown::to_typst(&cleaned, markdown::CitationMode::Strip, &std::collections::HashSet::new());
            // A leak is `#ongoing` neither backslash-escaped nor sitting
            // inside a quoted string (a URL argument is just data).
            for (i, _) in body.match_indices("#ongoing") {
                let escaped = i > 0 && body.as_bytes()[i - 1] == b'\\';
                let in_string = body[..i].matches('"').count() % 2 == 1;
                if !escaped && !in_string {
                    leaks.push(format!("{label}: {}", body.replace('\n', "\\n")));
                    break;
                }
            }
        }
        assert!(leaks.is_empty(), "unescaped hash leaked from:\n  {}", leaks.join("\n  "));
    }

    /// Compile `body` through the Formal style, reporting the first
    /// diagnostic on failure.
    fn compiles(body: &str) -> Result<(), String> {
        let style = styles::lookup("formal").unwrap();
        let source = styles::wrap(style, body, &styles::WrapOptions {
            bibliography: None, number_headings: false, page_numbers: false,
            line_spacing: 1.5, header_scale: 1.0, heading_space: 0.0,
        });
        let world = world::ExportWorld::new(source, None, None, vec![]);
        typst::compile::<typst::layout::PagedDocument>(&world)
            .output
            .map(|_| ())
            .map_err(|e| e.first().map(|d| d.message.to_string()).unwrap_or_default())
    }

    /// The Typst behaviour the code-block fencing rule is built on: a
    /// raw block closes at the first matching backtick run, so a fence
    /// must be longer than anything inside it. Pinned as a test because
    /// the rule is invisible in our own source — if a Typst upgrade ever
    /// changes it, this says so rather than the export dying in the
    /// field.
    #[test]
    fn typst_raw_closes_at_the_first_matching_run() {
        assert!(compiles("```rust\nlet x = 1;\n```").is_ok());
        assert!(compiles("```\nsee ``` here\n```").is_err(), "a short fence must not hold a longer run");
        assert!(compiles("````\nsee ``` here\n````").is_ok());
        assert!(compiles("`````rust\nsee ```` here\n`````").is_ok());
    }

    /// Regression, from an iPad export that died on
    /// `unknown variable: ongoing` six hundred lines from the cause: a
    /// fenced block containing a fence closed its raw early, and the
    /// prose after it was parsed as Typst code.
    #[test]
    fn renders_doc_whose_code_block_contains_a_fence() {
        let req = ExportRequest {
            markdown: "# Notes\n\n````\nMarkdown fences look like this:\n```\ncode\n```\n````\n\nA paragraph about #ongoing work, with `a`b` inline too."
                .into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("a nested fence must not fail the export");
        assert_eq!(&pdf[..4], b"%PDF");
    }

    /// Lay out `markdown` through the Formal style and report how many
    /// pages it came to — the only way to assert that a spacing knob
    /// actually moved anything.
    fn formal_page_count(markdown: &str, heading_space: f32) -> usize {
        let style = styles::lookup("formal").unwrap();
        let body = markdown::to_typst(
            markdown,
            markdown::CitationMode::Strip,
            &std::collections::HashSet::new(),
        );
        let source = styles::wrap(
            style,
            &body,
            &styles::WrapOptions {
                bibliography: None,
                number_headings: false,
                page_numbers: false,
                line_spacing: 1.5,
                header_scale: 1.0,
                heading_space,
            },
        );
        let world = world::ExportWorld::new(source, None, None, vec![]);
        typst::compile::<typst::layout::PagedDocument>(&world)
            .output
            .expect("compile")
            .pages
            .len()
    }

    /// The heading-space knob has to survive the styles' own per-level
    /// `heading.where(level: N)` show rules — a rule that got shadowed
    /// instead of composing would compile perfectly and change nothing.
    #[test]
    fn heading_space_pushes_content_down() {
        let doc: String = (1..=20)
            .map(|n| format!("## Section {n}\n\nA paragraph of body text under the heading.\n\n"))
            .collect();
        let tight = formal_page_count(&doc, 0.0);
        let airy = formal_page_count(&doc, 5.0);
        assert!(
            airy > tight,
            "heading space changed nothing: {tight} pages either way"
        );
    }

    /// Regression: a doc referencing an image the store couldn't
    /// produce failed the whole compile with Typst's "file not found",
    /// so the user got no PDF (and no preview) at all. The reference now
    /// prints as red markdown and the rest of the document renders.
    #[test]
    fn renders_doc_with_missing_image() {
        let req = ExportRequest {
            markdown: "# Title\n\n![ecosystem-diagram.png](ecosystem-diagram.png)\n\nBody after."
                .into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("missing image must not fail the export");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn renders_with_citation_and_bibliography() {
        let req = ExportRequest {
            markdown: "See [@halbwachs1992] on collective memory.".into(),
            style_id: "formal".into(),
            include_citations: true,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![ZoteroRef {
                key: "ABC".into(),
                citekey: "halbwachs1992".into(),
                title: "On Collective Memory".into(),
                authors: "Halbwachs, M".into(),
                year: "1992".into(),
                item_type: "book".into(),
            }],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn renders_article_two_column_style() {
        // Exercises the bundled Lato sans face + the two-column preamble
        // end to end — a compile failure here means the font didn't load
        // or the preamble is malformed.
        let req = ExportRequest {
            markdown: "# Heading\n\nA paragraph of body text that should flow into columns. \
                       Lorem ipsum dolor sit amet, consectetur adipiscing elit.".into(),
            style_id: "article-2col".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn citations_formatted_without_bibliography() {
        // include_citations=false but references are present: the cite
        // must render as a formatted (Author Year) label, not a bare
        // citekey, and no bibliography is appended.
        let req = ExportRequest {
            markdown: "As shown [@halbwachs1992], memory is social.".into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![ZoteroRef {
                key: "ABC".into(),
                citekey: "halbwachs1992".into(),
                title: "On Collective Memory".into(),
                authors: "Halbwachs, M".into(),
                year: "1992".into(),
                item_type: "book".into(),
            }],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn renders_doc_with_tab_markers() {
        // Tab markers must compile when `include_tabs` is on.
        let req = ExportRequest {
            markdown: "Intro paragraph.\n\n---Section A---\n\nBody of A.\n\n---Section B---/---Subsection---\n\nMore."
                .into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn renders_footnotes_and_strips_comments() {
        // A real footnote (`[^1]`) renders as `#footnote[...]`; an imported
        // Google comment (`{>span<ab}` + `[>ab]:`) is stripped to plain
        // prose. Both must compile end to end.
        let req = ExportRequest {
            markdown: "Body with a note[^1] and a {>flagged span<ab} here.\n\n\
                       [^1]: the footnote body\n\n[>ab]: a reviewer comment"
                .into(),
            style_id: "formal".into(),
            include_citations: false,
            citation_style: "numbered".into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
            include_tabs: true,
            line_spacing: 1.5,
            header_scale: 1.0,
            heading_space: 0.0,
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000);
        assert_eq!(&pdf[..4], b"%PDF");
    }
}

fn format_diagnostics(
    stage: &str,
    errors: &ecow::EcoVec<typst::diag::SourceDiagnostic>,
    world: &world::ExportWorld,
) -> String {
    let mut out = format!("{} stage failed:", stage);
    for d in errors {
        let severity = match d.severity {
            typst::diag::Severity::Error => "error",
            typst::diag::Severity::Warning => "warn",
        };
        let label = world.span_label(d.span);
        out.push_str(&format!("\n  - [{}] {}{}", severity, d.message, label));
        for hint in &d.hints {
            out.push_str(&format!("\n      hint: {}", hint));
        }
    }
    out
}
