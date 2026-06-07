/**
 * Pull-only Google Docs comment sync.
 *
 * Google comments are annotations anchored to a *range* of text, stored
 * separately from the document body via the Drive Comments API. On pull we
 * fetch them and weave them into the markdown as Hush comment anchors (see
 * `editor/comment-syntax.js`):
 *
 *   inside the text {>it looks like<ab} more
 *   [>ab]: Jane Doe: interesting, i love this thought
 *
 * The anchor is placed by matching the comment's `quotedFileContent`
 * against the pulled text. When the quoted text can't be located (the
 * document changed since the comment was made, or the formatting differs),
 * the note is still appended — unanchored, with the quote echoed inline —
 * so the comment is never silently dropped.
 *
 * We never write comments back, so Google's own anchor stays authoritative
 * and pushing the document body can't lose a comment's selection range.
 */
import { listComments } from "./api.js";
import { COMMENT_ANCHOR_RE } from "../editor/comment-syntax.js";

/** Fetch the linked doc's comments and weave them into `md`. Best-effort:
 *  any API failure leaves the markdown unchanged. */
export async function fetchAndWeaveComments(docId, md) {
  if (!docId) return md;
  let comments = [];
  try {
    comments = await listComments(docId);
  } catch (e) {
    console.warn("[google-docs] comment pull failed:", e);
    return md;
  }
  return weaveComments(md, comments);
}

/** Pure transform: given markdown and a list of Drive comment resources,
 *  return markdown with comment anchors + definitions woven in. */
export function weaveComments(md, comments) {
  if (!Array.isArray(comments) || comments.length === 0) return md || "";
  let body = String(md || "");
  const usedIds = collectExistingIds(body);
  const defs = [];
  let counter = 0;

  for (const c of comments) {
    // Resolved comments are conversational history in Google — skip them
    // so the imported document only carries open notes.
    if (c?.resolved) continue;
    const note = buildNote(c);
    if (!note) continue;

    let id;
    do { id = shortId(counter++); } while (usedIds.has(id));
    usedIds.add(id);

    const quoted = (c?.quotedFileContent?.value || "").trim();
    const at = quoted ? findAnchorable(body, quoted) : -1;
    if (at !== -1) {
      body =
        body.slice(0, at) +
        `{>${body.slice(at, at + quoted.length)}<${id}}` +
        body.slice(at + quoted.length);
      defs.push(`[>${id}]: ${note}`);
    } else {
      // Couldn't locate the range — keep the note, echo the quote so the
      // user can still tell what it referred to.
      const echo = quoted ? ` (re: “${oneLine(quoted)}”)` : "";
      defs.push(`[>${id}]: ${note}${echo}`);
    }
  }

  if (defs.length === 0) return body;
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  return body + sep + defs.join("\n") + "\n";
}

// Flatten a comment + its replies into a single-line note. Author names
// prefix each segment so margin notes attribute who said what.
function buildNote(c) {
  const segments = [];
  const author = c?.author?.displayName;
  const content = oneLine(c?.content || "");
  if (content) segments.push(author ? `${author}: ${content}` : content);
  for (const r of c?.replies || []) {
    const rc = oneLine(r?.content || "");
    if (!rc) continue;
    const ra = r?.author?.displayName;
    segments.push(`↳ ${ra ? `${ra}: ${rc}` : rc}`);
  }
  return segments.join(" ");
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Find the first occurrence of `quoted` that doesn't already sit inside a
// comment anchor (so two comments quoting overlapping text don't nest).
function findAnchorable(body, quoted) {
  const spans = anchorSpans(body);
  let from = 0;
  for (;;) {
    const idx = body.indexOf(quoted, from);
    if (idx === -1) return -1;
    const end = idx + quoted.length;
    const inside = spans.some((s) => idx < s.to && end > s.from);
    if (!inside) return idx;
    from = idx + 1;
  }
}

function anchorSpans(body) {
  const spans = [];
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(body)) !== null) {
    spans.push({ from: m.index, to: m.index + m[0].length });
  }
  return spans;
}

function collectExistingIds(body) {
  const ids = new Set();
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(body)) !== null) ids.add(m[2]);
  return ids;
}

// Short base-26 ids: a, b, … z, aa, ab, … — compact and editor-friendly.
function shortId(n) {
  let s = "";
  n += 1;
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
