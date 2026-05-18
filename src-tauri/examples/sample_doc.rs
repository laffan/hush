// Renders a sample document through the same pipeline the export
// command uses, writes it to /tmp/hush-sample.pdf, so the formal style
// can be eyeballed without spinning up the whole app.
//
// Run with:  cargo run --release --example sample_doc

use hush_lib::typst_export::{render_pdf, ExportRequest, ZoteroRef};

fn main() {
    let markdown = r#"# On Memory and Place

The relationship between memory and place is a recurring theme in
twentieth-century sociology. As [@halbwachs1992] argues, memory is
fundamentally social — and the spaces in which it is *practiced* shape
its contours.

## A second section

> Memory is a complex of the past and the present, where each colors
> the other in turn.

A list of considerations:

- Personal recollection is always mediated.
- Architectural form anchors the recollection.
- Without anchors, the recollection erodes.

The bracket form [@ricoeur2004](zotero://select/library/items/QNP2GZAQ)
should resolve identically to the bare bracket form, even when the
optional Zotero deep link is present.

A code block, just to test:

```rust
fn main() {
    println!("hello, typst");
}
```

A trailing paragraph with a regular [external link](https://typst.app)
and some _emphasis_ for good measure.
"#;

    let refs = vec![
        ZoteroRef {
            key: "K1".into(),
            citekey: "halbwachs1992".into(),
            title: "On Collective Memory".into(),
            authors: "Halbwachs, M; Coser, L".into(),
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

    let req = ExportRequest {
        markdown: markdown.into(),
        style_id: "formal".into(),
        include_citations: true,
        citation_style: "numbered".into(),
        strip_comments: true,
        strip_flags: true,
        number_headings: false,
        page_numbers: true,
        references: refs,
        images: vec![],
    };

    let pdf = render_pdf(&req).expect("render failed");
    let out_path = "/tmp/hush-sample.pdf";
    std::fs::write(out_path, &pdf).expect("write failed");
    println!("wrote {} bytes to {}", pdf.len(), out_path);
}
