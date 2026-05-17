// Convert a markdown file at /tmp/userdoc.md through the export
// pipeline so we can read the generated Typst source straight off
// disk and see exactly what tripped the compiler.

use hush_lib::typst_export::{
    markdown::{to_typst, CitationMode},
    styles, ExportRequest,
};

fn main() {
    let md = std::fs::read_to_string("/tmp/userdoc.md").expect("read userdoc.md");
    let body = to_typst(&md, CitationMode::Resolve);
    let style = styles::lookup("formal").unwrap();
    let main = styles::wrap(style, &body, false, Some("Term Paper"));

    let out = "/tmp/userdoc-converted.typ";
    std::fs::write(out, &main).unwrap();
    println!("wrote {} bytes to {}", main.len(), out);

    // Also try compiling so we see the same diagnostic the user saw.
    let req = ExportRequest {
        markdown: md,
        style_id: "formal".into(),
        include_citations: false,
        references: vec![],
        images: vec![],
        title: Some("Term Paper".into()),
    };
    match hush_lib::typst_export::render_pdf(&req) {
        Ok(b) => {
            std::fs::write("/tmp/userdoc-rendered.pdf", &b).unwrap();
            println!("rendered {} bytes of PDF → /tmp/userdoc-rendered.pdf", b.len());
        }
        Err(e) => println!("PDF render error:\n{}", e),
    }
}
