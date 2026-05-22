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
  - `---Tab name---` / `---Parent---/---Child---` — Hush's Google Docs
    tab marker syntax. With `include_tabs` true, the line is wrapped in
    a sentinel that survives pulldown + the Typst escape pass; the
    markdown converter expands it into a centred pill block. With
    `include_tabs` false, the line is dropped entirely (no marker, no
    label).

Implementation note: hand-written scanners rather than regex so the
crate's dependency list stays small — these patterns are simple
enough that a regex engine would be overkill.
*/

const COMMENT_AFTER_LINE: &str = "---%";
const SEPARATOR_LINE: &str = "---hush-separator---";

/// Sentinel chars that bracket a tab marker's path label through
/// pulldown and the markup-escape pass in `markdown.rs`. Picked from the
/// ASCII control range so the escape table leaves them alone.
pub const TAB_MARKER_OPEN: char = '\x1D';
pub const TAB_MARKER_CLOSE: char = '\x1C';

pub fn run(src: &str, strip_comments: bool, strip_flags: bool, include_tabs: bool) -> String {
    let mut out = src.to_string();
    if strip_comments {
        out = strip_comment_after(&out);
        out = strip_double_percent(&out);
    }
    if strip_flags {
        out = strip_double_equals(&out);
    }
    out = process_tabs(&out, include_tabs);
    out
}

/// Walk the source line by line, transforming each tab marker line
/// either into a sentinel-wrapped label (when `include` is true) or
/// dropping it entirely (when false). Non-marker lines pass through.
fn process_tabs(s: &str, include: bool) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in s.split('\n') {
        if let Some(path) = parse_tab_marker_path(line) {
            if include {
                out.push(format!(
                    "{}{}{}",
                    TAB_MARKER_OPEN,
                    path.join(" / "),
                    TAB_MARKER_CLOSE
                ));
            }
            // else: drop the line so it doesn't appear in the PDF.
        } else {
            out.push(line.to_string());
        }
    }
    out.join("\n")
}

/// Detect a tab marker line. Mirrors `parseTabMarkerPath` in
/// `src/editor/tabs.js` — each `/`-separated segment must match
/// `---name---` with a non-empty, non-all-dash inner name.
///
/// `---hush-separator---` is reserved for project-doc joins and is
/// stripped further down the pipeline by `markdown::to_typst`; we
/// refuse to recognise it as a tab marker so a project export's
/// separator lines don't disappear (or render as pills) when tab
/// processing is enabled.
fn parse_tab_marker_path(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == SEPARATOR_LINE {
        return None;
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.is_empty() {
        return None;
    }
    let mut path = Vec::new();
    for seg in segments {
        let seg = seg.trim();
        if !seg.starts_with("---") || !seg.ends_with("---") || seg.len() < 7 {
            return None;
        }
        let inner = seg[3..seg.len() - 3].trim();
        if inner.is_empty() {
            return None;
        }
        if inner.chars().all(|c| c == '-') {
            return None;
        }
        path.push(inner.to_string());
    }
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
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
        let out = run("before %% note %% after", true, false, false);
        assert_eq!(out, "before  after");
    }

    #[test]
    fn strips_multiline_comment() {
        let out = run("alpha\n%% spans\nseveral lines %%\nbeta", true, false, false);
        assert!(!out.contains("spans"));
        assert!(out.contains("alpha"));
        assert!(out.contains("beta"));
    }

    #[test]
    fn strips_to_end_of_section() {
        let src = "keep\n---% drafty\nthis goes\nso does this\n---hush-separator---\nkeep too";
        let out = run(src, true, false, false);
        assert!(out.contains("keep"));
        assert!(out.contains("keep too"));
        assert!(!out.contains("drafty"));
        assert!(!out.contains("goes"));
        // Separator survives so project doc boundaries don't get lost.
        assert!(out.contains("---hush-separator---"));
    }

    #[test]
    fn strips_named_flag() {
        let out = run("text ==MISSING: a thing== more", false, true, false);
        assert_eq!(out, "text more");
    }

    #[test]
    fn strips_bare_highlight() {
        let out = run("text ==important== more", false, true, false);
        assert_eq!(out, "text more");
    }

    #[test]
    fn flags_with_trailing_space_inside_braces() {
        // The user's term paper had `==MISSING: foo ==` with the space
        // before the closing `==`. Make sure that shape also goes.
        let out = run("a ==MISSING: foo == b", false, true, false);
        assert!(!out.contains("MISSING"), "got: {}", out);
    }

    #[test]
    fn off_passes_through() {
        let src = "x %% y %% z ==Q==";
        let out = run(src, false, false, true);
        assert_eq!(out, src);
    }

    #[test]
    fn triple_percent_is_not_a_comment() {
        let out = run("a %%% literal", true, false, false);
        assert!(out.contains("%"), "got: {}", out);
        assert!(out.contains("literal"));
    }

    #[test]
    fn tab_markers_dropped_when_off() {
        let src = "before\n---Intro---\nbody\n---Parent---/---Child---\nmore";
        let out = run(src, false, false, false);
        assert!(!out.contains("Intro"), "got: {}", out);
        assert!(!out.contains("Parent"), "got: {}", out);
        assert!(!out.contains("Child"), "got: {}", out);
        assert!(out.contains("before"));
        assert!(out.contains("body"));
        assert!(out.contains("more"));
    }

    #[test]
    fn tab_markers_wrapped_when_on() {
        let src = "---Intro---\nbody";
        let out = run(src, false, false, true);
        let expected = format!("{}Intro{}", TAB_MARKER_OPEN, TAB_MARKER_CLOSE);
        assert!(out.contains(&expected), "got: {:?}", out);
        assert!(out.contains("body"));
    }

    #[test]
    fn nested_tab_marker_path_joined() {
        let src = "---Parent---/---Child---\nbody";
        let out = run(src, false, false, true);
        let expected = format!("{}Parent / Child{}", TAB_MARKER_OPEN, TAB_MARKER_CLOSE);
        assert!(out.contains(&expected), "got: {:?}", out);
    }

    #[test]
    fn plain_hr_not_a_tab_marker() {
        // `---` alone is a thematic break and must pass through unchanged.
        let out = run("para\n\n---\n\npara2", false, false, false);
        assert!(out.contains("---"), "got: {}", out);
    }

    #[test]
    fn comment_after_marker_still_recognised_with_tabs_on() {
        // `---%` looks tab-marker-shaped but must keep its end-of-doc
        // meaning even when tab processing is enabled.
        let src = "keep\n---% drafty\ngone\n---hush-separator---\nkeep too";
        let out = run(src, true, false, true);
        assert!(out.contains("keep"));
        assert!(out.contains("keep too"));
        assert!(!out.contains("drafty"));
    }
}
