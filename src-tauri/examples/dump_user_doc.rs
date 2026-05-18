// Convert a markdown file at /tmp/userdoc.md through the export
// pipeline so we can read the generated Typst source straight off
// disk and see exactly what tripped the compiler.

use hush_lib::typst_export::{
    markdown::{to_typst, CitationMode},
    styles, ExportRequest, ZoteroRef,
};

fn main() {
    let md = std::fs::read_to_string("/tmp/userdoc.md").expect("read userdoc.md");
    let body = to_typst(
        &md,
        CitationMode::Resolve {
            known_keys: ["halbwachs1992"].into_iter().map(String::from).collect(),
        },
    );
    let style = styles::lookup("formal").unwrap();
    let wrap_opts = styles::WrapOptions {
        with_bibliography: false,
        number_headings: true,
        page_numbers: true,
    };
    let main = styles::wrap(style, &body, &wrap_opts);

    let out = "/tmp/userdoc-converted.typ";
    std::fs::write(out, &main).unwrap();
    println!("wrote {} bytes to {}", main.len(), out);

    // Stand in for a Zotero library that only knows about ONE of the
    // citekeys the user references. Every other `[@key]` in the doc
    // should now render as a red marker rather than fail the compile.
    let req = ExportRequest {
        markdown: md,
        style_id: "formal".into(),
        include_citations: true,
        citation_style: "numbered".into(),
        strip_comments: true,
        strip_flags: true,
        number_headings: true,
        page_numbers: true,
        references: vec![ZoteroRef {
            key: "K1".into(),
            citekey: "halbwachs1992".into(),
            title: "On Collective Memory".into(),
            authors: "Halbwachs, M; Coser, L".into(),
            year: "1992".into(),
            item_type: "book".into(),
        }],
        images: vec![],
    };
    match hush_lib::typst_export::render_pdf(&req) {
        Ok(b) => {
            std::fs::write("/tmp/userdoc-rendered.pdf", &b).unwrap();
            println!("rendered {} bytes of PDF → /tmp/userdoc-rendered.pdf", b.len());
        }
        Err(e) => println!("PDF render error:\n{}", e),
    }
}
