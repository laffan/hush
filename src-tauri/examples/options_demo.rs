// Renders /tmp/options-demo.md with the new toggles on (strip
// comments, strip flags, number headings, page numbers) so the
// formatting result can be eyeballed quickly.

use hush_lib::typst_export::{render_pdf, ExportRequest};

fn main() {
    let md = std::fs::read_to_string("/tmp/options-demo.md").expect("/tmp/options-demo.md");
    let req = ExportRequest {
        markdown: md,
        style_id: "formal".into(),
        include_citations: false,
        strip_comments: true,
        strip_flags: true,
        number_headings: true,
        page_numbers: true,
        references: vec![],
        images: vec![],
        title: Some("Options Demo".into()),
    };
    let pdf = render_pdf(&req).expect("render");
    let out = "/tmp/options-demo.pdf";
    std::fs::write(out, &pdf).unwrap();
    println!("wrote {} bytes to {}", pdf.len(), out);
}
