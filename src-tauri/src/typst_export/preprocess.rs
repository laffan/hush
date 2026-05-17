/*!
Pre-conversion hygiene passes on the markdown source.

These run before pulldown-cmark sees the text so the markup converter
only deals with the "publish" view of the document. Each pass is
controlled by its own flag in `ExportRequest`, so the user can choose
to keep their author notes visible in the PDF if they want.

What we recognise:

  - `%% inline comment %%` — same shape the inline editor plugin
    dims. Stripped wholesale, including the surrounding markers.
  - Multi-line `%% ... %%` — same delimiters, content spans newlines.
  - `---%` lines — Hush's "comment to end" marker. Drops everything
    from that line through to the next `---hush-separator---` (project
    docs) or end of file (single docs).
  - `==FLAG==` / `==FLAG: body==` — any double-equals run that isn't
    a Typst-style empty pair. These are author flags (TODO, MISSING,
    REWRITE, …) and we drop them entirely so the printed page doesn't
    surface the editorial scaffolding.

Implementation note: hand-written scanners rather than regex so the
crate's dependency list stays small — these patterns are simple
enough that a regex engine would be overkill.
*/

const COMMENT_AFTER_LINE: &str = "---%";
const SEPARATOR_LINE: &str = "---hush-separator---";

pub fn run(src: &str, strip_comments: bool, strip_flags: bool) -> String {
    let mut out = src.to_string();
    if strip_comments {
        out = strip_comment_after(&out);
        out = strip_double_percent(&out);
    }
    if strip_flags {
        out = strip_double_equals(&out);
    }
    out
}

/// Remove every `%% ... %%` pair, single- or multi-line. Non-greedy
/// pairing — the first closing `%%` after an opening pair wins,
/// matching what the editor highlights.
fn strip_double_percent(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'%' && bytes[i + 1] == b'%' {
            // `%%%` (three or more) is the editor's "not a comment"
            // escape hatch; honor it by emitting one percent and
            // shifting past it so the remaining `%%` can still pair.
            if bytes.get(i + 2) == Some(&b'%') {
                out.push('%');
                i += 1;
                continue;
            }
            // Find the closing `%%` from i+2 onward.
            if let Some(rel) = find_double_percent(&bytes[i + 2..]) {
                i = i + 2 + rel + 2;
                continue;
            }
            // Unmatched opener — leave it as-is so the user notices.
            out.push_str(&s[i..]);
            return out;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn find_double_percent(bytes: &[u8]) -> Option<usize> {
    let mut j = 0;
    while j + 1 < bytes.len() {
        if bytes[j] == b'%' && bytes[j + 1] == b'%' {
            // Same `%%%` escape on the closing side.
            if bytes.get(j + 2) != Some(&b'%') && (j == 0 || bytes[j - 1] != b'%') {
                return Some(j);
            }
            j += 1;
        }
        j += 1;
    }
    None
}

/// Drop every line from the first one containing `---%` (inclusive)
/// through to the next `---hush-separator---` or end of file. Mirrors
/// the editor's `createCommentAfterPlugin` scope.
///
/// We `split('\n')` rather than `lines()` so a source that ends
/// without a trailing newline round-trips unchanged when no comment
/// region was present.
fn strip_comment_after(s: &str) -> String {
    let mut kept = Vec::new();
    let mut skipping = false;
    for line in s.split('\n') {
        let trimmed = line.trim();
        if !skipping {
            if line.contains(COMMENT_AFTER_LINE) {
                skipping = true;
                continue;
            }
            kept.push(line);
        } else if trimmed == SEPARATOR_LINE {
            // Re-emit the separator so project-export boundaries
            // survive; the markdown converter strips it later.
            skipping = false;
            kept.push(line);
        }
        // Else: still inside the commented region, drop the line.
    }
    kept.join("\n")
}

/// Remove `==FLAG==` and `==FLAG: body==` runs. We match any
/// `==<at-least-one-non-equals>==` so plain `==highlight==` markers
/// are also pulled — the editor treats them all the same.
fn strip_double_equals(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'=' && bytes[i + 1] == b'=' {
            if let Some(rel) = find_double_equals(&bytes[i + 2..]) {
                if rel > 0 {
                    // Skip the whole `==...==` run — and one trailing
                    // space if present, so we don't leave a double
                    // space behind.
                    let mut next = i + 2 + rel + 2;
                    if bytes.get(next) == Some(&b' ') {
                        next += 1;
                    }
                    i = next;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn find_double_equals(bytes: &[u8]) -> Option<usize> {
    let mut j = 0;
    while j + 1 < bytes.len() {
        // Newlines bound a flag — the editor regex `==[^=]+==` already
        // refuses to cross `=`, and a multi-line span would suggest a
        // user typing `==` in plain prose rather than a flag.
        if bytes[j] == b'\n' {
            return None;
        }
        if bytes[j] == b'=' && bytes[j + 1] == b'=' {
            return Some(j);
        }
        j += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inline_comment() {
        let out = run("before %% note %% after", true, false);
        assert_eq!(out, "before  after");
    }

    #[test]
    fn strips_multiline_comment() {
        let out = run("alpha\n%% spans\nseveral lines %%\nbeta", true, false);
        assert!(!out.contains("spans"));
        assert!(out.contains("alpha"));
        assert!(out.contains("beta"));
    }

    #[test]
    fn strips_to_end_of_section() {
        let src = "keep\n---% drafty\nthis goes\nso does this\n---hush-separator---\nkeep too";
        let out = run(src, true, false);
        assert!(out.contains("keep"));
        assert!(out.contains("keep too"));
        assert!(!out.contains("drafty"));
        assert!(!out.contains("goes"));
        // Separator survives so project doc boundaries don't get lost.
        assert!(out.contains("---hush-separator---"));
    }

    #[test]
    fn strips_named_flag() {
        let out = run("text ==MISSING: a thing== more", false, true);
        assert_eq!(out, "text more");
    }

    #[test]
    fn strips_bare_highlight() {
        let out = run("text ==important== more", false, true);
        assert_eq!(out, "text more");
    }

    #[test]
    fn flags_with_trailing_space_inside_braces() {
        // The user's term paper had `==MISSING: foo ==` with the space
        // before the closing `==`. Make sure that shape also goes.
        let out = run("a ==MISSING: foo == b", false, true);
        assert!(!out.contains("MISSING"), "got: {}", out);
    }

    #[test]
    fn off_passes_through() {
        let src = "x %% y %% z ==Q==";
        let out = run(src, false, false);
        assert_eq!(out, src);
    }

    #[test]
    fn triple_percent_is_not_a_comment() {
        let out = run("a %%% literal", true, false);
        assert!(out.contains("%"), "got: {}", out);
        assert!(out.contains("literal"));
    }
}
