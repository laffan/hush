// Renders the same body+refs under each registered citation style so
// we know every option actually compiles to a real PDF. Useful both
// as a smoke test and as a quick visual reference for the dropdown.

use hush_lib::typst_export::{csl, render_pdf, ExportRequest, ZoteroRef};

fn main() {
    let body = "\
# A short demonstration

A claim worth citing [@halbwachs1992], plus a second one
[@ricoeur2004]. Both references appear in the bibliography section
that the chosen CSL controls.
";

    let refs = vec![
        ZoteroRef {
            key: "K1".into(),
            citekey: "halbwachs1992".into(),
            title: "On Collective Memory".into(),
            authors: "Halbwachs, M".into(),
            year: "1992".into(),
            item_type: "book".into(),
        },
        ZoteroRef {
            key: "K2".into(),
            citekey: "ricoeur2004".into(),
            title: "Memory, History, Forgetting".into(),
            authors: "Ricoeur, P".into(),
            year: "2004".into(),
            item_type: "book".into(),
        },
    ];

    for (id, _name) in csl::list() {
        let req = ExportRequest {
            markdown: body.into(),
            style_id: "formal".into(),
            include_citations: true,
            citation_style: (*id).into(),
            strip_comments: true,
            strip_flags: true,
            number_headings: false,
            page_numbers: true,
        include_tabs: true,
        line_spacing: 1.5,
        header_scale: 1.0,
            references: refs.clone(),
            images: vec![],
        };
        match render_pdf(&req) {
            Ok(pdf) => {
                let out = format!("/tmp/cite-{}.pdf", id);
                std::fs::write(&out, &pdf).unwrap();
                println!("ok   {:10} → {} ({} bytes)", id, out, pdf.len());
            }
            Err(e) => println!("FAIL {:10} → {}", id, e.lines().next().unwrap_or("")),
        }
    }
}

