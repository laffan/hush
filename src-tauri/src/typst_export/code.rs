/*!
Code blocks and inline code.

Both are Typst *raw* spans, and raw closes at the first matching run of
backticks — exactly like CommonMark. That makes the delimiter a function
of the content, which is the whole reason this module exists: a
three-backtick fence around a snippet that itself contains three
backticks (a document *about* markdown, a nested fence) closes early, and
everything after it is parsed as Typst markup. The damage lands nowhere
near the cause — prose becomes code, so an ordinary `#tag` paragraphs
later comes back as "unknown variable: tag" and the export is lost.
`typst_raw_closes_at_the_first_matching_run` in `mod.rs` pins the
behaviour these rules are built on.
*/

use super::markdown::escape_string;

/// Longest run of consecutive backticks anywhere in `s`.
pub(super) fn longest_backtick_run(s: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    for ch in s.chars() {
        if ch == '`' {
            run += 1;
            if run > best { best = run; }
        } else {
            run = 0;
        }
    }
    best
}

/// A fenced code block, fenced long enough to hold its own content.
///
/// Typst's raw blocks close on the first matching backtick run, exactly
/// like CommonMark's — so a three-backtick fence around content that
/// itself contains three backticks (a document *about* markdown, a
/// snippet with a nested fence) closes early, and **everything after it
/// is parsed as Typst markup**. That is not a mangled code block; it is
/// a compile failure somewhere else entirely, reported against a line
/// the author can't connect to the cause: prose after the break becomes
/// code, so an ordinary `#tag` in a later paragraph comes back as
/// "unknown variable: tag" and the whole export is lost.
///
/// So the fence is one backtick longer than the longest run inside, the
/// same rule CommonMark uses, with three as the floor.
pub(super) fn emit_code_block(content: &str, lang: &str) -> String {
    let fence = "`".repeat(longest_backtick_run(content).max(2) + 1);
    let mut out = String::with_capacity(content.len() + 2 * fence.len() + 8);
    out.push_str(&fence);
    out.push_str(&sanitize_lang(lang));
    out.push('\n');
    out.push_str(content);
    if !content.ends_with('\n') { out.push('\n'); }
    out.push_str(&fence);
    out
}

/// Inline code. Typst reads a *three*-backtick span as a block raw whose
/// first word is a language, and has no two-backtick form at all, so the
/// fence trick that works for blocks doesn't work here: content carrying
/// a backtick goes through `raw()` instead, where the delimiter problem
/// doesn't exist because the content is a string argument.
pub(super) fn emit_inline_code(content: &str) -> String {
    if !content.contains('`') {
        return format!("`{}`", content);
    }
    format!("#raw(\"{}\")", escape_string(content))
}

/// Keep an info string to something Typst will accept as a language: one
/// bare word. `rust,ignore` and `js title="x"` are both common in the
/// wild, and either would break the fence line.
fn sanitize_lang(lang: &str) -> String {
    lang.split_whitespace()
        .next()
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '#'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_fence_grows_past_its_content() {
        // Clean content keeps the ordinary three-backtick fence.
        assert_eq!(emit_code_block("let x = 1;\n", "rust"), "```rust\nlet x = 1;\n```");
        // Content holding a three-run gets a four-backtick fence.
        let out = emit_code_block("see ``` here\n", "");
        assert!(out.starts_with("````\n") && out.ends_with("````"), "got: {out}");
        // …and a four-run gets five.
        let out = emit_code_block("````\n", "");
        assert!(out.starts_with("`````") && out.ends_with("`````"), "got: {out}");
    }

    #[test]
    fn info_string_reduced_to_one_word() {
        assert_eq!(sanitize_lang("rust,ignore"), "rust");
        assert_eq!(sanitize_lang("js title=\"x\""), "js");
        assert_eq!(sanitize_lang("c++"), "c++");
        assert_eq!(sanitize_lang(""), "");
    }

    #[test]
    fn inline_code_with_a_backtick_uses_raw() {
        assert_eq!(emit_inline_code("plain"), "`plain`");
        assert_eq!(emit_inline_code("a`b"), "#raw(\"a`b\")");
    }
}
