/*!
Note-sentinel expansion — the final pass of the markdown → Typst
pipeline.

`preprocess.rs` collapses Hush's footnotes (`[^id]` + `[^id]:`) and
imported Google-Docs comments (`{>text<id}` + `[>id]:`) into
sentinel-wrapped bodies so they survive pulldown and the markup-escape
pass untouched. After `markdown::to_typst` has converted everything else,
this module swaps those sentinels for real Typst:

  - footnotes  → `#footnote[…]` (numbered, collected at the page foot)
  - comments   → `#hush-comment[…]` (a numbered margin note; the function
                 is defined in the style preamble, see `styles::wrap`)

By the time we run, citations and links inside a note body have already
been expanded to balanced Typst code, so the wrapping brackets close
cleanly.
*/

use super::preprocess::{COMMENT_NOTE_CLOSE, COMMENT_NOTE_OPEN, FOOTNOTE_CLOSE, FOOTNOTE_OPEN};

/// Swap each `FOOTNOTE_OPEN…FOOTNOTE_CLOSE` run for a real Typst footnote.
/// An empty body falls back to a single space so `#footnote[]` (which
/// Typst rejects) never reaches the compiler.
pub fn expand_footnote_sentinels(s: &str) -> String {
    expand(s, FOOTNOTE_OPEN, FOOTNOTE_CLOSE, |body, out| {
        out.push_str("#footnote[");
        out.push_str(if body.trim().is_empty() { " " } else { body });
        out.push(']');
    })
}

/// Swap each `COMMENT_NOTE_OPEN…COMMENT_NOTE_CLOSE` run for a margin note
/// via the preamble's `#hush-comment` helper.
pub fn expand_comment_sentinels(s: &str) -> String {
    expand(s, COMMENT_NOTE_OPEN, COMMENT_NOTE_CLOSE, |body, out| {
        out.push_str("#hush-comment[");
        out.push_str(body);
        out.push(']');
    })
}

/// Walk `s`, handing each `open…close` bracketed body to `emit` and
/// copying everything else verbatim.
fn expand(s: &str, open: char, close: char, emit: impl Fn(&str, &mut String)) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != open {
            out.push(c);
            continue;
        }
        let mut body = String::new();
        for k in chars.by_ref() {
            if k == close {
                break;
            }
            body.push(k);
        }
        emit(&body, &mut out);
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
    fn comment_sentinel_becomes_margin_note() {
        let src = format!("span{}a note{}", COMMENT_NOTE_OPEN, COMMENT_NOTE_CLOSE);
        let out = expand_comment_sentinels(&src);
        assert_eq!(out, "span#hush-comment[a note]");
    }

    #[test]
    fn text_without_sentinels_is_unchanged() {
        let src = "ordinary text with [brackets] and #funcs";
        assert_eq!(expand_footnote_sentinels(src), src);
        assert_eq!(expand_comment_sentinels(src), src);
    }
}
