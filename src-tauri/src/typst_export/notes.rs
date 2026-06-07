/*!
Footnote-sentinel expansion — the final pass of the markdown → Typst
pipeline.

`preprocess.rs` collapses Hush's footnotes (`[^id]` + `[^id]:`) into a
sentinel-wrapped body so the definition text survives pulldown and the
markup-escape pass untouched. After `markdown::to_typst` has converted
everything else, this swaps each sentinel for a real Typst `#footnote[…]`
(numbered, collected at the page foot).

By the time we run, citations and links inside a note body have already
been expanded to balanced Typst code, so the wrapping brackets close
cleanly.

(Imported Google-Docs comments are *not* rendered in the PDF — they're an
editing aid stripped to plain prose by `preprocess::process_comments`.)
*/

use super::preprocess::{FOOTNOTE_CLOSE, FOOTNOTE_OPEN};

/// Swap each `FOOTNOTE_OPEN…FOOTNOTE_CLOSE` run for a real Typst footnote.
/// An empty body falls back to a single space so `#footnote[]` (which
/// Typst rejects) never reaches the compiler.
pub fn expand_footnote_sentinels(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != FOOTNOTE_OPEN {
            out.push(c);
            continue;
        }
        let mut body = String::new();
        for k in chars.by_ref() {
            if k == FOOTNOTE_CLOSE {
                break;
            }
            body.push(k);
        }
        out.push_str("#footnote[");
        out.push_str(if body.trim().is_empty() { " " } else { &body });
        out.push(']');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn footnote_sentinel_becomes_typst_footnote() {
        let src = format!("text{}the body{} end", FOOTNOTE_OPEN, FOOTNOTE_CLOSE);
        let out = expand_footnote_sentinels(&src);
        assert_eq!(out, "text#footnote[the body] end");
    }

    #[test]
    fn empty_footnote_body_gets_a_space() {
        let src = format!("x{}{}", FOOTNOTE_OPEN, FOOTNOTE_CLOSE);
        let out = expand_footnote_sentinels(&src);
        assert_eq!(out, "x#footnote[ ]");
    }

    #[test]
    fn text_without_sentinels_is_unchanged() {
        let src = "ordinary text with [brackets] and #funcs";
        assert_eq!(expand_footnote_sentinels(src), src);
    }
}
