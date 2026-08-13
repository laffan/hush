/*!
Image references in the export pipeline.

Two jobs: turn a markdown image URL into the virtual path the
`ExportWorld` keys its files by, and decide what a given reference
renders as.

The second one is the load-bearing part. Typst treats a missing file as
a hard compile error, so a single stale `![](old-diagram.png)` used to
take the whole export down — no PDF, no preview, just a "file not found"
diagnostic. A reference we can't serve bytes for therefore renders as the
markdown the author wrote, in red, exactly like an unresolvable citation
does (`citations::missing_cite_marker`). The gap is visible on the page
and everything around it still prints.
*/

use std::collections::HashSet;

use super::markdown::{escape_string, escape_typst_text};

/// One image reference, mid-conversion.
pub struct ImageRef<'a> {
    /// Virtual path resolved by `resolve_path` — the lookup key.
    pub path: &'a str,
    /// The URL exactly as the author wrote it, for the red fallback.
    pub raw_url: &'a str,
    /// Markdown title (`![alt](url "title")`) — wins as the caption.
    pub title: &'a str,
    /// Bracket contents (`alt` or Hush's `alt|caption`), raw.
    pub alt: &'a str,
}

/// Normalize a filename to the `/<name>` form `ExportWorld` registers
/// its virtual files under, so availability sets and reference sites
/// agree on spelling.
pub fn normalize_path(name: &str) -> String {
    format!("/{}", name.trim_start_matches('/'))
}

/// Markdown URL → virtual path. `http(s)` URLs are returned untouched
/// and will never match an availability set: the World has no network,
/// so a remote image is as unreadable as a missing local one.
pub fn resolve_path(dest_url: &str) -> String {
    if dest_url.starts_with("http://") || dest_url.starts_with("https://") {
        return dest_url.to_string();
    }
    let trimmed = dest_url.trim_start_matches("./");
    let trimmed = trimmed.trim_start_matches("images/");
    normalize_path(trimmed)
}

/// Typst source for one image reference — a figure when the World can
/// serve it, the red markdown fallback when it can't.
pub fn emit(img: &ImageRef, available: &HashSet<String>) -> String {
    if !available.contains(img.path) {
        return missing_marker(img);
    }
    // Caption precedence: an explicit markdown title wins; otherwise the
    // text after the first `|` in the alt (Hush's `![alt|caption](url)`
    // form). A bare alt with no caption shows no caption at all — the
    // alt is typically just the image id/filename.
    let caption_text = if !img.title.is_empty() {
        img.title.to_string()
    } else if let Some(idx) = img.alt.find('|') {
        img.alt[idx + 1..].trim().to_string()
    } else {
        String::new()
    };
    let caption = if caption_text.is_empty() {
        String::new()
    } else {
        format!(", caption: [{}]", escape_typst_text(&caption_text))
    };
    format!(
        "\n#figure(image(\"{}\", width: 80%){})\n\n",
        escape_string(img.path),
        caption
    )
}

/// The markdown the author wrote, in red. The alt keeps the
/// `alt|caption` form it was written in; both halves are escaped, and
/// the brackets around them are emitted pre-escaped so they can't close
/// the content block they sit in.
fn missing_marker(img: &ImageRef) -> String {
    format!(
        "#text(fill: rgb(\"#c0392b\"))[!\\[{}\\]({})]",
        escape_typst_text(img.alt),
        escape_typst_text(img.raw_url),
    )
}

#[cfg(test)]
mod tests {
    use super::super::markdown::{to_typst, CitationMode};
    use super::*;

    fn available(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| normalize_path(n)).collect()
    }

    #[test]
    fn resolves_relative_and_prefixed_urls() {
        assert_eq!(resolve_path("pic.png"), "/pic.png");
        assert_eq!(resolve_path("./pic.png"), "/pic.png");
        assert_eq!(resolve_path("images/pic.png"), "/pic.png");
        assert_eq!(resolve_path("/pic.png"), "/pic.png");
        assert_eq!(resolve_path("https://x/pic.png"), "https://x/pic.png");
    }

    #[test]
    fn present_image_renders_as_figure() {
        let out = to_typst(
            "![diagram|The ecosystem](ecosystem-diagram.png)",
            CitationMode::Strip,
            &available(&["ecosystem-diagram.png"]),
        );
        assert!(out.contains("#figure(image(\"/ecosystem-diagram.png\""), "got: {}", out);
        assert!(out.contains("caption: [The ecosystem]"), "got: {}", out);
    }

    /// Regression: a reference to an image the store can't produce used
    /// to reach Typst as `image("/missing.png")`, which fails the whole
    /// compile ("file not found") and lost the user their export.
    #[test]
    fn missing_image_renders_as_red_markdown() {
        let out = to_typst(
            "Before\n\n![ecosystem-diagram.png](ecosystem-diagram.png)\n\nAfter",
            CitationMode::Strip,
            &available(&["other.png"]),
        );
        assert!(!out.contains("#figure"), "got: {}", out);
        assert!(!out.contains("image(\""), "got: {}", out);
        assert!(out.contains("#text(fill: rgb(\"#c0392b\"))"), "got: {}", out);
        assert!(out.contains("ecosystem-diagram.png"), "got: {}", out);
        // The surrounding prose still renders.
        assert!(out.contains("Before") && out.contains("After"), "got: {}", out);
    }

    /// The World has no network, so a remote image is as unreadable as
    /// a missing local one.
    #[test]
    fn remote_image_renders_as_red_markdown() {
        let out = to_typst(
            "![alt](https://example.com/pic.png)",
            CitationMode::Strip,
            &HashSet::new(),
        );
        assert!(out.contains("#text(fill: rgb(\"#c0392b\"))"), "got: {}", out);
        assert!(!out.contains("#figure"), "got: {}", out);
    }

    /// A missing image whose alt text carries Typst markup characters
    /// must not break out of the marker's content block.
    #[test]
    fn missing_image_escapes_alt_and_url() {
        let out = to_typst("![a]b#c](weird[name].png)", CitationMode::Strip, &HashSet::new());
        assert!(!out.contains("[a]b#c]"), "unescaped alt in: {}", out);
        assert!(out.contains("\\#c"), "got: {}", out);
    }
}
