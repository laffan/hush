/*!
Minimal in-memory `typst::World` for export rendering.

What's in the world:
  - One main source (`/main.typ`) — the wrapped Typst document.
  - Optionally `/refs.yml` for the bibliography.
  - One virtual file per supplied image, keyed by its filename.
  - Every font from `typst-assets` so the bundled styles render even
    when the host has no fonts of its own.

What's not:
  - Package resolution (`@preview/...`). Styles must stay self-contained
    — they can't `#import "@preview/cetz"` because we don't ship a
    package storage. That's intentional for the first pass; the iOS
    build can't reach the network either.
  - Filesystem access. Every read goes through the in-memory map.
*/

use std::collections::HashMap;
use std::sync::OnceLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, Span, VirtualPath};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

pub struct ExportWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    main: FileId,
    sources: HashMap<FileId, Source>,
    files: HashMap<FileId, Bytes>,
}

impl ExportWorld {
    pub fn new(
        main_typst: String,
        bib_yaml: Option<String>,
        csl: Option<&'static str>,
        images: Vec<(String, Vec<u8>)>,
    ) -> Self {
        let fonts = load_bundled_fonts();
        let book = FontBook::from_fonts(fonts.iter());

        let main_id = FileId::new(None, VirtualPath::new("/main.typ"));
        let mut sources = HashMap::new();
        sources.insert(main_id, Source::new(main_id, main_typst));

        let mut files: HashMap<FileId, Bytes> = HashMap::new();

        if let Some(yaml) = bib_yaml {
            let bib_id = FileId::new(None, VirtualPath::new("/refs.yml"));
            files.insert(bib_id, Bytes::new(yaml.into_bytes()));
        }

        if let Some(csl_xml) = csl {
            let csl_id = FileId::new(None, VirtualPath::new("/style.csl"));
            files.insert(csl_id, Bytes::new(csl_xml.as_bytes().to_vec()));
        }

        for (name, bytes) in images {
            let path = format!("/{}", name);
            let id = FileId::new(None, VirtualPath::new(&path));
            files.insert(id, Bytes::new(bytes));
        }

        Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
            main: main_id,
            sources,
            files,
        }
    }

    /// Best-effort source-location hint for diagnostics. The span may
    /// resolve to a synthesized FileId (e.g. the wrapped preamble) so we
    /// surface the path either way rather than swallowing it.
    pub fn span_label(&self, span: Span) -> String {
        let Some(id) = span.id() else { return String::new() };
        let path = id.vpath().as_rooted_path().display().to_string();
        if let Some(source) = self.sources.get(&id) {
            if let Some(range) = source.range(span) {
                let before = &source.text()[..range.start.min(source.text().len())];
                let line = before.matches('\n').count() + 1;
                let col = before.rsplit('\n').next().map(|s| s.chars().count() + 1).unwrap_or(1);
                return format!(" ({}:{}:{})", path, line, col);
            }
        }
        format!(" ({})", path)
    }
}

impl World for ExportWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.sources
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(id.vpath().as_rooted_path().to_path_buf()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(id.vpath().as_rooted_path().to_path_buf()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        // Wallclock today is fine for exports — Typst uses this for
        // `datetime.today()` calls in user templates, and there's no
        // determinism requirement on the PDF output. We feed naive
        // local time; offset handling can be revisited if a style ever
        // needs timezone math.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        let secs = now.as_secs() as i64;
        // Convert to civil date via a tiny inline calc — avoids pulling
        // chrono into typst's namespace.
        let days = secs.div_euclid(86_400);
        let (y, m, d) = days_to_ymd(days);
        Datetime::from_ymd(y, m as u8, d as u8)
    }
}

/// Sans-serif faces bundled with Hush. `typst-assets` ships only serif
/// (Libertinus / New Computer Modern) and monospace (DejaVu Sans Mono)
/// families, so styles that want a proportional sans — e.g. "Article
/// (2 Column)" — pull from these. "Karla" is one of the sans options
/// Hush already offers in the editor, kept here as compact variable
/// fonts (upright + italic); Typst varies the weight axis for bold and
/// the explicit `[&'static [u8]; 2]` return type coerces the fixed-size
/// `include_bytes!` arrays into slices.
fn extra_font_blobs() -> [&'static [u8]; 2] {
    [
        include_bytes!("../../fonts/karla/Karla-Variable.ttf"),
        include_bytes!("../../fonts/karla/Karla-Italic-Variable.ttf"),
    ]
}

fn load_bundled_fonts() -> Vec<Font> {
    static CACHE: OnceLock<Vec<Font>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut out = Vec::new();
            for data in typst_assets::fonts().chain(extra_font_blobs()) {
                let bytes = Bytes::new(data);
                // A single asset blob can contain several faces (TTC).
                // FontInfo::iter walks them, and Font::new picks one out
                // by index.
                for (idx, _info) in FontInfo::iter(&bytes).enumerate() {
                    if let Some(font) = Font::new(bytes.clone(), idx as u32) {
                        out.push(font);
                    }
                }
            }
            out
        })
        .clone()
}

/// Convert epoch-days to a (year, month, day) civil date. Lifted from
/// the public-domain "Date Algorithms" by Howard Hinnant — small enough
/// to inline rather than pull chrono into this module.
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
