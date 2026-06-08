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
 * against the pulled text. When the same word recurs, the inline marker
 * positions Google's HTML export embeds (recovered by
 * `extractCommentMarkers`) break the tie so the comment lands on the
 * instance it was actually attached to — not the first occurrence. When
 * the quoted text can't be located at all (the document changed since the
 * comment was made), the note is still appended unanchored, with the quote
 * echoed inline, so the comment is never silently dropped.
 *
 * Comment *content* is never written back, so Google's own anchor stays
 * authoritative and pushing the body can't lose a selection range. The one
 * write-back is resolving (`resolveMarkedComments`).
 */
import { listComments, resolveComment } from "./api.js";
import { COMMENT_MARKER_SENTINEL } from "../editor/google-docs/html-to-markdown.js";
import {
  COMMENT_ANCHOR_RE, COMMENT_DEF_RE, formatCommentMeta, parseCommentDefinitions,
} from "../editor/comment-syntax.js";

/**
 * Remove every locally-resolved comment from the markdown: unwrap its
 * `{>text<id}` anchor to the bare text and drop its `[>id]:` definition
 * (plus continuations). Unresolved comments are left untouched. Called
 * after a push so a resolved comment disappears immediately instead of
 * lingering until the next pull.
 */
export function stripResolvedComments(md) {
  if (typeof md !== "string" || !md) return md || "";
  const defs = parseCommentDefinitions(md);
  const resolved = new Set();
  for (const [id, info] of defs) if (info.resolved) resolved.add(id);
  if (resolved.size === 0) return md;

  const unwrapped = md.replace(COMMENT_ANCHOR_RE, (full, text, id) =>
    resolved.has(id) ? text : full
  );
  const kept = [];
  let dropping = false;
  for (const line of unwrapped.split("\n")) {
    const m = line.match(COMMENT_DEF_RE);
    if (m) {
      dropping = resolved.has(m[1]);
      if (dropping) continue;
    } else if (dropping && /^  \S/.test(line)) {
      continue;
    } else {
      dropping = false;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Pull out the inline comment-position sentinels the HTML converter left
 * in `md` (pull path), returning the cleaned markdown plus the character
 * offsets where Google's comment markers sat. Those offsets disambiguate
 * which occurrence of a quoted word a comment anchors to.
 */
export function extractCommentMarkers(md) {
  const s = String(md || "");
  if (s.indexOf(COMMENT_MARKER_SENTINEL) === -1) return { clean: s, positions: [] };
  let clean = "";
  const positions = [];
  for (const ch of s) {
    if (ch === COMMENT_MARKER_SENTINEL) positions.push(clean.length);
    else clean += ch;
  }
  return { clean, positions };
}

/** Fetch the linked doc's comments and weave them into `md`. Best-effort:
 *  any API failure leaves the markdown unchanged. `markerPositions` are the
 *  offsets recovered by `extractCommentMarkers` (empty for the Docs-API
 *  multi-tab path, which has no marker info). */
export async function fetchAndWeaveComments(docId, md, markerPositions = []) {
  if (!docId) return md;
  let comments = [];
  try {
    comments = await listComments(docId);
  } catch (e) {
    console.warn("[google-docs] comment pull failed:", e);
    return md;
  }
  return weaveComments(md, comments, markerPositions);
}

/**
 * Resolve, in Google, every comment the user flagged resolved locally
 * (a `resolved` token in the `[>id]:` definition's `%%cmnt …%%` metadata).
 * Called on push, before the comment scaffolding is stripped. Idempotent —
 * a comment already resolved in Google just no-ops. Returns
 * `{ resolved, failed }` counts so the caller can surface them.
 */
export async function resolveMarkedComments(docId, md) {
  const result = { resolved: 0, failed: 0, noId: 0 };
  if (!docId) return result;
  const defs = parseCommentDefinitions(md);
  const tasks = [];
  for (const info of defs.values()) {
    if (!info.resolved) continue;
    if (!info.gid) {
      // Marked resolved locally but no Google comment id is stored — the
      // comment was imported before id capture shipped, so we can't reach
      // it via the API. A re-pull will re-attach the id.
      result.noId++;
      continue;
    }
    tasks.push(
      resolveComment(docId, info.gid)
        .then(() => { result.resolved++; })
        .catch((e) => {
          result.failed++;
          console.warn("[google-docs] resolve comment failed:", info.gid, e);
        })
    );
  }
  await Promise.all(tasks);
  return result;
}

/** Pure transform: given markdown, a list of Drive comment resources, and
 *  the marker offsets, return markdown with comment anchors + definitions
 *  woven in. */
export function weaveComments(md, comments, markerPositions = []) {
  if (!Array.isArray(comments) || comments.length === 0) return md || "";
  const body = String(md || "");
  const usedIds = collectExistingIds(body);
  const markers = (markerPositions || []).slice().sort((a, b) => a - b);
  const occupied = anchorSpans(body); // pre-existing anchors (usually none)
  const placements = [];
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

    // Carry Google's comment id as hidden metadata so a later Resolve
    // can reach the right comment via the Drive API.
    const meta = formatCommentMeta(c?.id || null, false);
    const quoted = (c?.quotedFileContent?.value || "").trim();
    const target = quoted ? chooseOccurrence(body, quoted, markers, occupied) : null;
    if (target) {
      occupied.push({ from: target.start, to: target.end });
      placements.push({ start: target.start, end: target.end, id });
      defs.push(`[>${id}]: ${note}${meta}`);
    } else {
      // Couldn't locate the range — keep the note, echo the quote so the
      // user can still tell what it referred to.
      const echo = quoted ? ` (re: “${oneLine(quoted)}”)` : "";
      defs.push(`[>${id}]: ${note}${echo}${meta}`);
    }
  }

  // Apply anchors from the end backwards so earlier offsets stay valid.
  let out = body;
  placements.sort((a, b) => b.start - a.start);
  for (const p of placements) {
    out = out.slice(0, p.start) + "{>" + out.slice(p.start, p.end) + "<" + p.id + "}" + out.slice(p.end);
  }

  if (defs.length === 0) return out;
  const sep = out.endsWith("\n") ? "\n" : "\n\n";
  return out + sep + defs.join("\n") + "\n";
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

// Choose which occurrence of `quoted` a comment anchors to. The strongest
// signal is the inline marker Google places at the *end* of the commented
// range: when the text immediately before a marker equals the quote, that
// marker is unambiguously this comment's — so a comment on a single "."
// lands on the marked period, not the first one in the document. Failing an
// exact match we fall back to the occurrence nearest a marker, then (no
// markers — the multi-tab path) the first free occurrence. Returns
// `{ start, end }` or null. Consumes the marker it uses.
function chooseOccurrence(body, quoted, markers, occupied) {
  const free = (start, end) => !occupied.some((s) => start < s.to && end > s.from);

  // 1. Exact: a marker whose preceding text is the quote.
  for (let mi = 0; mi < markers.length; mi++) {
    const end = markers[mi];
    const start = end - quoted.length;
    if (start >= 0 && body.slice(start, end) === quoted && free(start, end)) {
      markers.splice(mi, 1);
      return { start, end };
    }
  }

  // 2. Gather free occurrences.
  const occ = [];
  let from = 0;
  for (;;) {
    const idx = body.indexOf(quoted, from);
    if (idx === -1) break;
    const end = idx + quoted.length;
    if (free(idx, end)) occ.push({ start: idx, end });
    from = idx + 1;
  }
  if (occ.length === 0) return null;
  if (occ.length === 1 || markers.length === 0) return occ[0];

  // 3. Nearest remaining marker.
  let best = null;
  for (const o of occ) {
    for (let mi = 0; mi < markers.length; mi++) {
      const d = Math.abs(o.end - markers[mi]);
      if (!best || d < best.d) best = { o, mi, d };
    }
  }
  markers.splice(best.mi, 1);
  return best.o;
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
