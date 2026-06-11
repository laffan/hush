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
pub mod csl;
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

    let body = markdown::to_typst(&cleaned_md, cite_mode);
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
            references: vec![],
            images: vec![],
        };
        let pdf = render_pdf(&req).expect("render");
        assert!(pdf.len() > 1000, "PDF unexpectedly small: {} bytes", pdf.len());
        assert_eq!(&pdf[..4], b"%PDF", "missing PDF magic");
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
