//! Words added between two versions of a document, by section.
//!
//! The writing-progress tally (`progress.rs`) compares a document as it
//! stood at the start of a day with how it stood at the end, and needs
//! the words that are *new* — not the net change, which a morning of
//! rewriting would show as zero. So this is a diff, done in two levels
//! to stay cheap on a long document:
//!
//! 1. **Lines.** The two texts' non-empty lines are matched by an LCS
//!    (after trimming the common head and tail, which is nearly the
//!    whole document on an ordinary day). A line that left one place
//!    and turned up unchanged in another is a move, not new writing.
//! 2. **Words**, inside each changed stretch: the old stretch's words
//!    against the new stretch's, so editing one word of a paragraph adds
//!    one word rather than the paragraph.
//!
//! Either level falls back to a word-bag difference when its table
//! would be too large to fill, which overcounts only reordering.
//!
//! What counts as a word follows the editor's word count
//! (`word-count.js#countWords`): frontmatter, `%% comments %%`, image
//! references and card fences are not words. Every added word is
//! credited to the section it sits in — the nearest heading above it in
//! the newer text, or the untitled stretch before the first heading.

use std::collections::HashMap;

/// Largest LCS table filled at either level (cells). Beyond it the
/// stretch falls back to the word-bag difference.
const MAX_CELLS: usize = 4_000_000;

/// One non-empty line, as words, with the section it belongs to.
struct Line {
    words: Vec<String>,
    section: usize,
}

/// A document reduced to what the tally reads: its non-empty lines and
/// its section titles (index 0 is the stretch before the first heading,
/// titled "").
struct Prepared {
    lines: Vec<Line>,
    sections: Vec<String>,
}

/// Words added from `old` to `new`, by section of `new`, in the order
/// the sections appear. Sections with nothing added are left out.
pub fn added_by_section(old: &str, new: &str) -> Vec<(String, u64)> {
    let a = prepare(old);
    let b = prepare(new);
    let mut added = vec![0u64; b.sections.len()];

    let a_keys: Vec<&[String]> = a.lines.iter().map(|l| l.words.as_slice()).collect();
    let b_keys: Vec<&[String]> = b.lines.iter().map(|l| l.words.as_slice()).collect();
    match lcs_pairs(&a_keys, &b_keys) {
        Some(pairs) => {
            // Lines either side of a matched pair are a changed stretch.
            let mut b_moved = vec![false; b.lines.len()];
            mark_moves(&a, &b, &pairs, &mut b_moved);
            let mut prev = (0usize, 0usize);
            let mut anchors = pairs.clone();
            anchors.push((a.lines.len(), b.lines.len()));
            for (ai, bi) in anchors {
                let old_words: Vec<&str> = a.lines[prev.0..ai]
                    .iter()
                    .flat_map(|l| l.words.iter().map(|w| w.as_str()))
                    .collect();
                let new_words: Vec<(&str, usize)> = b.lines[prev.1..bi]
                    .iter()
                    .zip(&b_moved[prev.1..bi])
                    .filter(|(_, moved)| !**moved)
                    .flat_map(|(l, _)| l.words.iter().map(move |w| (w.as_str(), l.section)))
                    .collect();
                credit_words(&old_words, &new_words, &mut added);
                prev = (ai + 1, bi + 1);
            }
        }
        None => {
            let old_words: Vec<&str> = a.lines.iter().flat_map(|l| l.words.iter().map(|w| w.as_str())).collect();
            let new_words: Vec<(&str, usize)> = b
                .lines
                .iter()
                .flat_map(|l| l.words.iter().map(move |w| (w.as_str(), l.section)))
                .collect();
            bag_credit(&old_words, &new_words, &mut added);
        }
    }

    b.sections
        .into_iter()
        .zip(added)
        .filter(|(_, n)| *n > 0)
        .collect()
}

/// Total words added from `old` to `new`.
pub fn words_added(old: &str, new: &str) -> u64 {
    added_by_section(old, new).iter().map(|(_, n)| n).sum()
}

/// An unmatched new line identical to an unmatched old one is the same
/// text moved, not new writing.
fn mark_moves(a: &Prepared, b: &Prepared, pairs: &[(usize, usize)], b_moved: &mut [bool]) {
    let mut a_matched = vec![false; a.lines.len()];
    let mut b_matched = vec![false; b.lines.len()];
    for &(i, j) in pairs {
        a_matched[i] = true;
        b_matched[j] = true;
    }
    let mut pool: HashMap<&[String], usize> = HashMap::new();
    for (i, l) in a.lines.iter().enumerate() {
        if !a_matched[i] {
            *pool.entry(l.words.as_slice()).or_default() += 1;
        }
    }
    for (j, l) in b.lines.iter().enumerate() {
        if b_matched[j] {
            continue;
        }
        if let Some(n) = pool.get_mut(l.words.as_slice()) {
            if *n > 0 {
                *n -= 1;
                b_moved[j] = true;
            }
        }
    }
}

/// Credit the words of `new` that the word-level LCS can't find in `old`.
fn credit_words(old: &[&str], new: &[(&str, usize)], added: &mut [u64]) {
    if new.is_empty() {
        return;
    }
    if old.is_empty() {
        for (_, s) in new {
            added[*s] += 1;
        }
        return;
    }
    let new_keys: Vec<&str> = new.iter().map(|(w, _)| *w).collect();
    match lcs_pairs(old, &new_keys) {
        Some(pairs) => {
            let mut matched = vec![false; new.len()];
            for (_, j) in pairs {
                matched[j] = true;
            }
            for (j, (_, s)) in new.iter().enumerate() {
                if !matched[j] {
                    added[*s] += 1;
                }
            }
        }
        None => bag_credit(old, new, added),
    }
}

/// The fallback: a word of `new` is added when `old` has run out of that
/// word. Blind to order, so it undercounts nothing but a rearrangement.
fn bag_credit(old: &[&str], new: &[(&str, usize)], added: &mut [u64]) {
    let mut bag: HashMap<&str, usize> = HashMap::new();
    for w in old {
        *bag.entry(*w).or_default() += 1;
    }
    for (w, s) in new {
        match bag.get_mut(w) {
            Some(n) if *n > 0 => *n -= 1,
            _ => added[*s] += 1,
        }
    }
}

/// Matched index pairs of a longest common subsequence, ascending, or
/// None when the table would exceed `MAX_CELLS`. The common head and
/// tail are matched before the table is built.
fn lcs_pairs<T: PartialEq>(a: &[T], b: &[T]) -> Option<Vec<(usize, usize)>> {
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    let am = &a[head..a.len() - tail];
    let bm = &b[head..b.len() - tail];
    let (n, m) = (am.len(), bm.len());
    let mut pairs: Vec<(usize, usize)> = (0..head).map(|i| (i, i)).collect();
    if n > 0 && m > 0 {
        if (n + 1).saturating_mul(m + 1) > MAX_CELLS {
            return None;
        }
        // dp[i][j] = LCS length of am[i..] and bm[j..].
        let w = m + 1;
        let mut dp = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                dp[i * w + j] = if am[i] == bm[j] {
                    dp[(i + 1) * w + j + 1] + 1
                } else {
                    dp[(i + 1) * w + j].max(dp[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if am[i] == bm[j] {
                pairs.push((head + i, head + j));
                i += 1;
                j += 1;
            } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    for k in 0..tail {
        pairs.push((a.len() - tail + k, b.len() - tail + k));
    }
    Some(pairs)
}

/// Lines and sections of a document, with everything that isn't a word
/// taken out.
fn prepare(text: &str) -> Prepared {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let body = strip_frontmatter(&text);
    let body = blank_comments(body);
    let mut sections = vec![String::new()];
    let mut lines = Vec::new();
    let mut in_fence = false;
    for raw in body.split('\n') {
        let t = raw.trim();
        // Card fences are markup (cards/card-model.ts).
        if t == "<<<" || t == ">>>" {
            continue;
        }
        if t.starts_with("```") {
            in_fence = !in_fence;
        }
        // A heading opens a section; its words count, its `#`s don't.
        let mut words_of = t.to_string();
        if !in_fence {
            if let Some(title) = heading_title(t) {
                words_of = title.clone();
                sections.push(title);
            }
        }
        let words: Vec<String> = strip_images(&words_of).split_whitespace().map(str::to_string).collect();
        if !words.is_empty() {
            lines.push(Line { words, section: sections.len() - 1 });
        }
    }
    Prepared { lines, sections }
}

/// `## Title ##` → `Title`; None when the line isn't an ATX heading.
fn heading_title(line: &str) -> Option<String> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim();
    Some(title.to_string())
}

/// The text after a leading YAML block (`---` … `---` / `...`), as the
/// editor's `findFrontmatterRange` finds it; the whole text otherwise.
fn strip_frontmatter(text: &str) -> &str {
    let mut lines = text.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return text,
    }
    let mut pos = text.find('\n').map(|i| i + 1).unwrap_or(text.len());
    for line in lines {
        let t = line.trim_end();
        pos += line.len();
        if t == "---" || t == "..." {
            return &text[pos.min(text.len())..];
        }
    }
    text
}

/// `%% … %%` (possibly across lines) blanked to spaces, newlines kept so
/// the line structure — and with it the sections — is undisturbed.
fn blank_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("%%") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("%%") {
            Some(end) => {
                for c in rest[start..start + 2 + end + 2].chars() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `![alt](target)` taken out of a line — an image reference isn't words.
fn strip_images(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("![") {
        let after = &rest[start..];
        let close = after.find("](").and_then(|mid| after[mid..].find(')').map(|e| mid + e + 1));
        match close {
            Some(end) => {
                out.push_str(&rest[..start]);
                out.push(' ');
                rest = &after[end..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_new_words_not_net_change() {
        // A sentence rewritten: three words out, four in.
        let old = "The cat sat down.\n";
        let new = "The dog lay quietly down.\n";
        assert_eq!(words_added(old, new), 3);
    }

    #[test]
    fn credits_sections_of_the_new_text() {
        let old = "# One\n\nalpha beta\n\n# Two\n\ngamma\n";
        let new = "# One\n\nalpha beta delta\n\n# Two\n\ngamma\n\nmore words here\n";
        assert_eq!(
            added_by_section(old, new),
            vec![("One".to_string(), 1), ("Two".to_string(), 3)]
        );
    }

    #[test]
    fn a_new_heading_is_a_section_of_its_own() {
        let old = "intro text\n";
        let new = "intro text\n\n## Results\n\nfour new words here\n";
        assert_eq!(added_by_section(old, new), vec![("Results".to_string(), 5)]);
    }

    #[test]
    fn moved_paragraph_adds_nothing() {
        let old = "first paragraph here\n\nsecond paragraph there\n";
        let new = "second paragraph there\n\nfirst paragraph here\n";
        assert_eq!(words_added(old, new), 0);
    }

    #[test]
    fn frontmatter_comments_images_and_fences_are_not_words() {
        let old = "---\ntags: a\n---\nbody\n";
        let new = "---\ntags: a b c\n---\nbody %% a note to self %% ![img](x.png)\n<<<\ncard words\n>>>\n";
        assert_eq!(words_added(old, new), 2);
    }

    #[test]
    fn crlf_and_empty_frontmatter() {
        let new = "---\r\n---\r\n\r\n## Intro\r\n\r\nhello there\r\n";
        assert_eq!(added_by_section("", new), vec![("Intro".to_string(), 3)]);
    }

    #[test]
    fn from_nothing_everything_is_added() {
        assert_eq!(words_added("", "one two three"), 3);
    }
}
