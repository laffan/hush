// Verifies the export pipeline copes with the project-view shape of
// the editor buffer: several docs concatenated with the
// `---hush-separator---` marker. The modal pre-strips those markers
// to blank lines, and the markdown converter has a belt-and-braces
// pass that drops any that sneak through — both should leave the
// joined stream reading as one continuous document.

use hush_lib::typst_export::{render_pdf, ExportRequest};

fn main() {
    // Two child docs, each with their own opening heading. After the
    // sidebar's separator-stripping pass these become a single doc
    // with both sections in order.
    let joined = "\
# Chapter one

The first child doc lives here. It opens with its own heading because
inside a project each file owns its slice of the outline.

A second paragraph for body weight.

---hush-separator---

# Chapter two

Second child doc. The line above is the project view's per-file
separator — the sidebar replaces it with two blank lines before the
markdown converter ever sees it. If both stripping passes worked, this
PDF will show chapter one and chapter two flowing into each other with
nothing weird in between.

A `==FLAG==` inline that the strip pass should remove.

%% an inline note the strip pass should also remove %%
";

    // Match the path the sidebar takes when it exports a project: it
    // replaces `\\n---hush-separator---\\n` with `\\n\\n` before
    // handing the content to the modal.
    let cleaned = joined.replace("\n---hush-separator---\n", "\n\n");

    let req = ExportRequest {
        markdown: cleaned,
        style_id: "formal".into(),
        include_citations: false,
        strip_comments: true,
        strip_flags: true,
        number_headings: true,
        page_numbers: true,
        references: vec![],
        images: vec![],
    };
    let pdf = render_pdf(&req).expect("render");
    let out = "/tmp/project-demo.pdf";
    std::fs::write(out, &pdf).unwrap();
    println!("wrote {} bytes to {}", pdf.len(), out);
}
