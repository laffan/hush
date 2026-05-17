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
pub mod markdown;
pub mod styles;
pub mod world;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
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
    /// When true and `references` is non-empty, inline `(Author, Year)`
    /// citations + a bibliography section get rendered.
    pub include_citations: bool,
    #[serde(default)]
    pub references: Vec<ZoteroRef>,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    pub title: Option<String>,
}

pub fn render_pdf(req: &ExportRequest) -> Result<Vec<u8>, String> {
    let style = styles::lookup(&req.style_id)
        .ok_or_else(|| format!("unknown style: {}", req.style_id))?;

    let cite_mode = if req.include_citations && !req.references.is_empty() {
        markdown::CitationMode::Resolve
    } else {
        markdown::CitationMode::Strip
    };

    let body = markdown::to_typst(&req.markdown, cite_mode);
    let bib_yaml = if matches!(cite_mode, markdown::CitationMode::Resolve) {
        Some(bibliography::to_hayagriva_yaml(&req.references))
    } else {
        None
    };

    let main_source = styles::wrap(style, &body, bib_yaml.is_some(), req.title.as_deref());

    let world = world::ExportWorld::new(
        main_source.clone(),
        bib_yaml,
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
            references: vec![],
            images: vec![],
            title: Some("Test Doc".into()),
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
            references: vec![ZoteroRef {
                key: "ABC".into(),
                citekey: "halbwachs1992".into(),
                title: "On Collective Memory".into(),
                authors: "Halbwachs, M".into(),
                year: "1992".into(),
                item_type: "book".into(),
            }],
            images: vec![],
            title: None,
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
