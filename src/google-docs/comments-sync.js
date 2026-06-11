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

/** Fetch the linked doc's *open* (unresolved) comments. Best-effort: any
 *  API failure reads as "no comments" so a pull is never blocked on the
 *  Comments endpoint. */
export async function fetchOpenComments(docId) {
  if (!docId) return [];
  try {
    const comments = await listComments(docId);
    return (comments || []).filter((c) => !c?.resolved);
  } catch (e) {
    console.warn("[google-docs] comment pull failed:", e);
    return [];
  }
}

/** Fetch the linked doc's comments and weave them into `md`. Best-effort:
 *  any API failure leaves the markdown unchanged. `markerPositions` are the
 *  offsets recovered by `extractCommentMarkers` (empty for the Docs-API
 *  multi-tab path, which has no marker info). */
export async function fetchAndWeaveComments(docId, md, markerPositions = []) {
  if (!docId) return md;
  const comments = await fetchOpenComments(docId);
  return weaveComments(md, comments, markerPositions);
}

/**
 * Resolve a single comment in Google right away — used by the Resolve
 * button (editor tooltip / comments panel), which strips the comment's
 * local syntax immediately. Best-effort: the local removal stands even if
 * the API call fails (the outcome lands in the sync log either way).
 */
export async function resolveCommentInGoogle(state, gid) {
  if (!gid || !state) return;
  const { getLink, appendLog } = await import("./link-store.js");
  const link = getLink(state, state.currentFileId);
  if (!link?.docId) return;
  try {
    await resolveComment(link.docId, gid);
    appendLog(state, `Resolved a comment in "${link.title}"`);
  } catch (e) {
    console.warn("[google-docs] resolve comment failed:", gid, e);
    appendLog(state, `Failed to resolve a comment in "${link.title}" (see console)`);
  }
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

  // Resolved comments are conversational history in Google — skip them
  // so the imported document only carries open notes. Place comments with
  // the *longest* quoted text first: a specific quote binds its marker
  // before a generic one (a single "." or a recurring word) can steal a
  // marker that merely happens to be preceded by the same characters.
  const open = comments
    .filter((c) => !c?.resolved)
    .map((c) => ({ c, quoted: (c?.quotedFileContent?.value || "").trim() }))
    .sort((a, b) => b.quoted.length - a.quoted.length);

  for (const { c, quoted } of open) {
    const note = buildNote(c);
    if (!note) continue;

    let id;
    do { id = shortId(counter++); } while (usedIds.has(id));
    usedIds.add(id);

    // A Google Docs *suggested edit* arrives through the Comments API as a
    // thread whose content is the auto-generated description ("Replace: …
    // with …", "Delete: …", "Insert: …"). Flag it so the editor can tint
    // it differently, and strike the affected text for delete/replace so
    // the markdown mirrors what the Google Doc shows.
    const kind = suggestionKind(c?.content);
    const strike = kind === "replace" || kind === "delete";

    // Carry Google's comment id as hidden metadata so a later Resolve
    // can reach the right comment via the Drive API.
    const meta = formatCommentMeta(c?.id || null, false, !!kind);
    const target = quoted ? chooseOccurrence(body, quoted, markers, occupied) : null;
    if (target) {
      occupied.push({ from: target.start, to: target.end });
      placements.push({ start: target.start, end: target.end, id, strike });
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
    let inner = out.slice(p.start, p.end);
    if (p.strike && shouldStrike(out, p.start, p.end, inner)) {
      inner = "~~" + inner + "~~";
    }
    out = out.slice(0, p.start) + "{>" + inner + "<" + p.id + "}" + out.slice(p.end);
  }

  if (defs.length === 0) return out;
  const sep = out.endsWith("\n") ? "\n" : "\n\n";
  return out + sep + defs.join("\n") + "\n";
}

// Identify a suggested-edit thread by its auto-generated description.
// Returns "replace" | "delete" | "insert" | null.
function suggestionKind(content) {
  const m = oneLine(content).match(/^(replace|delete|insert)\s*:/i);
  return m ? m[1].toLowerCase() : null;
}

// Wrap a suggestion's affected text in `~~…~~` only when it isn't struck
// already (Drive's export styles suggested deletions with line-through,
// which the HTML converter may have turned into `~~` on its own) and the
// run is single-line (markdown strikethrough doesn't span paragraphs).
function shouldStrike(body, start, end, inner) {
  if (!inner.trim() || inner.includes("\n")) return false;
  if (/^~~[\s\S]*~~$/.test(inner)) return false;
  if (body.slice(Math.max(0, start - 2), start) === "~~") return false;
  if (body.slice(end, end + 2) === "~~") return false;
  return true;
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

// The Drive API returns comment content "with HTML formatting" — drop any
// tags and decode the common entities so notes read as plain prose instead
// of mangled markup.
function oneLine(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Choose which occurrence of `quoted` a comment anchors to. The strongest
// signal is the inline marker Google places at the *end* of the commented
// range: an occurrence whose end lands on a marker (or a few characters
// shy of one, when the gap is just markdown syntax the converter inserted
// — a closing `**`, `~~`, `==`, a quote mark) is unambiguously this
// comment's — so a comment on a single "." lands on the marked period, not
// the first one in the document. Failing that we fall back to the
// occurrence nearest a marker (preferring text that *ends before* the
// marker, since Google places markers after the commented range), then
// (no markers — the multi-tab path) the first free occurrence. Returns
// `{ start, end }` or null. Consumes the marker it uses.
const MARKER_GAP_MAX = 6;
const MARKER_GAP_SYNTAX_RE = /^[*~=_`"'”’)\]\s]*$/;

function chooseOccurrence(body, quoted, markers, occupied) {
  const free = (start, end) => !occupied.some((s) => start < s.to && end > s.from);

  // 1. Gather free occurrences.
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

  // 2. Marker-anchored: an occurrence whose end coincides with a marker,
  //    allowing a small all-syntax gap. Smallest gap wins; ties go to the
  //    earliest occurrence so repeated identical quotes pair off with
  //    their markers in document order.
  let best = null;
  for (const o of occ) {
    for (let mi = 0; mi < markers.length; mi++) {
      const gap = markers[mi] - o.end;
      if (gap < 0 || gap > MARKER_GAP_MAX) continue;
      if (gap > 0 && !MARKER_GAP_SYNTAX_RE.test(body.slice(o.end, markers[mi]))) continue;
      if (!best || gap < best.gap || (gap === best.gap && o.start < best.o.start)) {
        best = { o, mi, gap };
      }
    }
  }
  if (best) {
    markers.splice(best.mi, 1);
    return best.o;
  }

  if (occ.length === 1 || markers.length === 0) return occ[0];

  // 3. Nearest remaining marker — text ending at or before a marker beats
  //    text that starts after it, because the marker trails its range.
  for (const o of occ) {
    for (let mi = 0; mi < markers.length; mi++) {
      const after = o.end > markers[mi] + 2; // small slack for converter drift
      const d = Math.abs(o.end - markers[mi]) + (after ? 1000 : 0);
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
