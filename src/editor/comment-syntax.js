/**
 * Pure, dependency-free helpers for Hush's Google-Docs comment syntax.
 *
 * A Google Doc comment is an annotation anchored to a *range* of text. We
 * represent it in markdown as an anchored span plus a footnote-style
 * definition, so the commented range survives editing and round-trips:
 *
 *   inside the text {>it looks like<ab} more
 *
 *   [>ab]: Jane Doe: interesting, i love this thought
 *
 * `{>...<id}` wraps the commented text (the range Google had selected);
 * `[>id]: ...` carries the note body. The two are linked by the short id.
 *
 * Comment sync is pull-only: Hush imports comments from Google for viewing
 * and PDF export but never writes them back, so the authoritative range
 * always lives in Google's own comment anchor — pushing the document body
 * never has to recompute it. On push we simply strip the scaffolding and
 * keep the commented prose intact (see `stripCommentSyntax`).
 *
 * Kept free of any CodeMirror / editor imports so the clipboard copy path
 * and the HTML converters can use it without pulling in the editor tree.
 */

// Anchored range: `{>text<id}`. The text may span lines (a comment over a
// whole paragraph), so the inner group is `[\s\S]`-lazy. The id is the
// short alphanumeric handle shared with the definition.
export const COMMENT_ANCHOR_RE = /\{>([\s\S]*?)<([A-Za-z0-9]+)\}/g;

// Definition line: `[>id]: body`. Anchored at line start like a footnote
// definition; continuation lines are indented two spaces.
export const COMMENT_DEF_RE = /^\[>([A-Za-z0-9]+)\]:\s?(.*)$/;

/**
 * Parse `[>id]: body` definition lines (with two-space-indented
 * continuations) into a Map of id → note text.
 */
export function parseCommentDefinitions(text) {
  const defs = new Map();
  const lines = String(text || "").split("\n");
  let id = null;
  let buf = "";
  for (const line of lines) {
    const m = line.match(COMMENT_DEF_RE);
    if (m) {
      if (id !== null) defs.set(id, buf.trim());
      id = m[1];
      buf = m[2];
    } else if (id !== null && /^  /.test(line)) {
      buf += " " + line.trim();
    } else if (id !== null) {
      defs.set(id, buf.trim());
      id = null;
      buf = "";
    }
  }
  if (id !== null) defs.set(id, buf.trim());
  return defs;
}

/**
 * Remove all comment scaffolding from a markdown string, keeping the
 * commented prose. Used on push / clipboard copy so the target document
 * shows clean text — the anchors are unwrapped to their inner text and
 * the `[>id]:` definition block (plus indented continuations) is dropped.
 */
export function stripCommentSyntax(md) {
  if (typeof md !== "string" || !md) return md || "";
  // 1. Unwrap anchors → inner commented text.
  const unwrapped = md.replace(COMMENT_ANCHOR_RE, (_, text) => text);
  // 2. Drop definition lines and their indented continuations.
  const lines = unwrapped.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    if (COMMENT_DEF_RE.test(line)) {
      dropping = true;
      continue;
    }
    if (dropping && /^  \S/.test(line)) continue;
    dropping = false;
    kept.push(line);
  }
  return kept.join("\n");
}
