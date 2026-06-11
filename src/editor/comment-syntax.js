/**
 * Pure, dependency-free helpers for Hush's Google-Docs comment syntax.
 *
 * A Google Doc comment is an annotation anchored to a *range* of text. We
 * represent it in markdown as an anchored span plus a footnote-style
 * definition, so the commented range survives editing and round-trips:
 *
 *   inside the text {>it looks like<ab} more
 *
 *   [>ab]: Jane Doe: interesting, i love this thought %%cmnt id=AAAB123%%
 *
 * `{>...<id}` wraps the commented text (the range Google had selected);
 * `[>id]: ...` carries the note. The two are linked by the short id. A
 * trailing `%%cmnt ...%%` segment carries machine metadata the user never
 * sees (the editor hides the whole definition line): `id=` is the Google
 * comment id (so a Resolve action can reach the right comment via the
 * Drive API), and a bare `resolved` token marks a comment the user has
 * resolved locally — applied to Google on the next push.
 *
 * Comment content sync is pull-only (Hush imports comments, never edits
 * their text in Google), so the authoritative range always lives in
 * Google's own comment anchor — pushing the document body never has to
 * recompute it. On push we strip the scaffolding and keep the commented
 * prose intact (see `stripCommentSyntax`). The one write-back is resolving.
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

// Trailing machine metadata on a definition body: `%%cmnt id=… resolved%%`.
export const COMMENT_META_RE = /\s*%%\s*cmnt\b([^%]*)%%\s*$/;

/**
 * Split a definition body into its human note and machine metadata.
 * Returns `{ note, gid, resolved, sug, sugKind }` — `gid` is the Google
 * comment id (or null), `resolved` whether the user has flagged it
 * resolved, `sug` whether the entry is a Google Docs *suggested edit*
 * rather than a plain comment, and `sugKind` which side of the edit the
 * anchor wraps: `"del"` (text pending deletion) or `"ins"` (proposed
 * insertion); null for plain comments or legacy `sug` tokens.
 */
export function parseCommentMeta(body) {
  const s = String(body || "");
  const m = s.match(COMMENT_META_RE);
  if (!m) return { note: s.trim(), gid: null, resolved: false, sug: false, sugKind: null };
  const meta = m[1] || "";
  const gid = (meta.match(/id=([^\s%]+)/) || [])[1] || null;
  const resolved = /\bresolved\b/.test(meta);
  const sm = meta.match(/\bsug(?:=(\w+))?\b/);
  const sug = !!sm;
  const sugKind = sm?.[1] === "del" || sm?.[1] === "ins" ? sm[1] : null;
  return { note: s.slice(0, m.index).trim(), gid, resolved, sug, sugKind };
}

/** Render the `%%cmnt …%%` metadata suffix (empty when there's nothing to
 *  record). Inverse of `parseCommentMeta`. `sug` may be `true` or a kind
 *  string (`"del"` / `"ins"`). */
export function formatCommentMeta(gid, resolved, sug = false) {
  if (!gid && !resolved && !sug) return "";
  const parts = [];
  if (gid) parts.push(`id=${gid}`);
  if (sug) parts.push(typeof sug === "string" ? `sug=${sug}` : "sug");
  if (resolved) parts.push("resolved");
  return ` %%cmnt ${parts.join(" ")}%%`;
}

/**
 * Parse `[>id]: body` definition lines (with two-space-indented
 * continuations) into a Map of id → `{ note, gid, resolved }`.
 */
export function parseCommentDefinitions(text) {
  const defs = new Map();
  const lines = String(text || "").split("\n");
  let id = null;
  let buf = "";
  const flush = () => { if (id !== null) defs.set(id, parseCommentMeta(buf.trim())); };
  for (const line of lines) {
    const m = line.match(COMMENT_DEF_RE);
    if (m) {
      flush();
      id = m[1];
      buf = m[2];
    } else if (id !== null && /^  /.test(line)) {
      buf += " " + line.trim();
    } else if (id !== null) {
      flush();
      id = null;
      buf = "";
    }
  }
  flush();
  return defs;
}

/**
 * Split a flattened note into its individual comment segments. Imported
 * notes pack a whole thread into one line — the top comment plus each
 * reply prefixed with `↳ ` (see `comments-sync.js#buildNote`). Each
 * segment is split into its author (the `Name:` prefix Google supplies)
 * and the comment text so UI surfaces can format the two distinctly.
 * Returns `[{ author, text }]` — `author` is null when no prefix exists.
 */
export function splitNoteSegments(note) {
  const segments = String(note || "").split(/\s*↳\s*/).map((s) => s.trim()).filter(Boolean);
  return segments.map((seg) => {
    const m = seg.match(/^([^:]{1,80}?):\s+([\s\S]*)$/);
    if (m) return { author: m[1].trim(), text: m[2].trim() };
    return { author: null, text: seg };
  });
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
