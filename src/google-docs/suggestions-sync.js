/**
 * Suggested-edit sync — pulls Google Docs *suggestions* (Suggesting-mode
 * edits) into Hush as green-tinted comment anchors.
 *
 * The Drive Comments API doesn't reliably expose suggestions, so this
 * rides the Docs API instead: `documents.get` with
 * `suggestionsViewMode=SUGGESTIONS_INLINE` returns the body with pending
 * edits inline, each text run flagged with `suggestedInsertionIds` /
 * `suggestedDeletionIds`. That's exact and locale-independent.
 *
 * Each suggestion segment lands in the markdown as a comment anchor with
 * a `sug` metadata flag (see `editor/comment-syntax.js`):
 *
 *   deletion:   {>~~the removed text~~<a}      (struck, mirrors the GDoc)
 *   insertion:  {>the proposed text<a}
 *   [>a]: Suggested deletion %%cmnt sug%%
 *
 * When the pulled markdown doesn't contain the suggested text (the HTML
 * export rendered the other side of the suggestion), it's re-inserted at
 * the position located via the segment's surrounding context, so the
 * Hush doc mirrors what the Google Doc shows in Suggesting mode either
 * way. Resolve removes the anchor (and the `~~` we added) locally — Hush
 * can't accept/reject suggestions in Google; do that in the GDoc.
 */
import { getDocumentWithTabs } from "./api.js";
import { anchorSpans, collectExistingIds, shortId } from "./comments-sync.js";

const CONTEXT_LEN = 48;

/** Fetch the linked doc's pending suggestions. Best-effort: any API
 *  failure reads as "no suggestions" so a pull is never blocked. */
export async function fetchSuggestions(docId) {
  if (!docId) return [];
  try {
    const doc = await getDocumentWithTabs(docId, { suggestionsInline: true });
    return collectSuggestions(doc);
  } catch (e) {
    console.warn("[google-docs] suggestion pull failed:", e);
    return [];
  }
}

/**
 * Walk a Docs API document (SUGGESTIONS_INLINE view) and collect pending
 * suggestion segments: `{ kind: "insert"|"delete", text, before, after }`
 * — `before` / `after` are plain-text context around the segment for
 * locating it in the pulled markdown. Multi-paragraph suggestions split
 * into one segment per line (markdown strikethrough can't span lines).
 */
export function collectSuggestions(doc) {
  const runs = [];
  const walkTabs = (tabs) => {
    for (const t of tabs || []) {
      walkBody(t.documentTab?.body?.content, runs);
      walkTabs(t.childTabs);
    }
  };
  if (Array.isArray(doc?.tabs) && doc.tabs.length) walkTabs(doc.tabs);
  else walkBody(doc?.body?.content, runs);
  return segmentsFromRuns(runs);
}

function walkBody(content, runs) {
  for (const elem of content || []) {
    if (elem.paragraph) {
      for (const e of elem.paragraph.elements || []) {
        const tr = e.textRun;
        if (!tr || !tr.content) continue;
        const kind = tr.suggestedDeletionIds?.length ? "delete"
          : tr.suggestedInsertionIds?.length ? "insert" : null;
        runs.push({ text: tr.content, kind });
      }
    } else if (elem.table) {
      for (const row of elem.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          walkBody(cell.content, runs);
        }
      }
    }
  }
}

// Coalesce the run stream into suggestion segments with surrounding
// plain-text context. Consecutive same-kind runs merge into one segment
// (which may span lines — a deleted paragraph keeps its `\n`s).
// `ownLine` marks a segment that occupied whole paragraph(s) of its own,
// so a re-insertion can land as its own paragraph too.
function segmentsFromRuns(runs) {
  const out = [];
  let plain = ""; // running non-suggested text (context source)
  let i = 0;
  while (i < runs.length) {
    const r = runs[i];
    if (!r.kind) {
      plain += r.text;
      i++;
      continue;
    }
    let raw = "";
    let j = i;
    while (j < runs.length && runs[j].kind === r.kind) {
      raw += runs[j].text;
      j++;
    }
    const text = raw.replace(/^\n+|\n+$/g, "").trim();
    if (text) {
      out.push({
        kind: r.kind,
        text,
        ownLine: /(^|\n)\s*$/.test(plain) && /\n\s*$/.test(raw),
        before: plain.slice(-CONTEXT_LEN),
        after: collectAfterContext(runs, j),
      });
    }
    // Inserted text is part of the inline view's body — it counts as
    // context for any suggestion that follows it (deletions don't:
    // the export may not carry them).
    if (r.kind === "insert") plain += raw;
    i = j;
  }
  return out;
}

function collectAfterContext(runs, from) {
  let s = "";
  for (let k = from; k < runs.length && s.length < CONTEXT_LEN; k++) {
    if (!runs[k].kind) s += runs[k].text;
  }
  return s.slice(0, CONTEXT_LEN);
}

/**
 * Pure transform: weave suggestion segments into markdown as `sug`
 * anchors. Segments whose text exists in the body are wrapped in place;
 * segments the export omitted are re-inserted at the context position.
 * Existing anchors (woven comments) are never overlapped.
 */
export function weaveSuggestions(md, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return md || "";
  let body = String(md || "");
  const usedIds = collectExistingIds(body);
  let counter = 0;
  const nextId = () => {
    let id;
    do { id = shortId(counter++); } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  const defs = [];
  let placed = 0;

  for (const seg of segments) {
    const occupied = anchorSpans(body);
    const free = (start, end) => !occupied.some((s) => start < s.to && end > s.from);
    const id = nextId();
    const label = seg.kind === "delete" ? "Suggested deletion" : "Suggested insertion";
    const target = findSegment(body, seg, free);
    if (target) {
      const inner = body.slice(target.start, target.end);
      const wrapped = `{>${seg.kind === "delete" ? strikeLines(inner) : inner}<${id}}`;
      body = body.slice(0, target.start) + wrapped + body.slice(target.end);
      defs.push(`[>${id}]: ${label} %%cmnt sug%%`);
      placed++;
      continue;
    }
    // The export rendered the other side of this suggestion — re-insert
    // the text at the context position so the doc mirrors Suggesting mode.
    const at = findInsertionPoint(body, seg, occupied);
    if (at == null) {
      defs.push(`[>${id}]: ${label} (re: “${normalizeWs(seg.text)}”) %%cmnt sug%%`);
      continue;
    }
    // A segment that owned its paragraph(s) lands as its own paragraph;
    // inline segments pick up a space when butted against a word.
    const inner = seg.kind === "delete" ? strikeLines(seg.text, true) : seg.text;
    let insert = `{>${inner}<${id}}`;
    if (seg.ownLine) {
      if (body.slice(Math.max(0, at - 2), at) !== "\n\n") insert = "\n\n" + insert;
      if (body[at] !== "\n") insert += "\n\n";
    } else {
      const alnum = (ch) => !!ch && /[A-Za-z0-9]/.test(ch);
      if (alnum(body[at - 1])) insert = " " + insert;
      if (alnum(body[at])) insert += " ";
    }
    body = body.slice(0, at) + insert + body.slice(at);
    defs.push(`[>${id}]: ${label} %%cmnt sug%%`);
    placed++;
  }

  console.log(`[google-docs] weaving ${segments.length} suggestion(s): ${placed} placed`);
  if (defs.length === 0) return body;
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  return body + sep + defs.join("\n") + "\n";
}

/** Fetch + weave in one step (pull path). */
export async function fetchAndWeaveSuggestions(docId, md) {
  const segments = await fetchSuggestions(docId);
  if (segments.length === 0) return md;
  return weaveSuggestions(md, segments);
}

// Markdown strikethrough can't span lines — strike each line of a
// multi-paragraph run separately. `asParagraphs` re-joins with blank
// lines (for re-inserted whole paragraphs).
function strikeLines(text, asParagraphs = false) {
  const lines = String(text).split("\n").map((l) => {
    const t = l.trim();
    return t && !/^~~[\s\S]*~~$/.test(t) ? l.replace(t, `~~${t}~~`) : l;
  });
  return asParagraphs ? lines.filter((l) => l.trim()).join("\n\n") : lines.join("\n");
}

// Find the segment's text in the body, using before-context to pick
// among multiple occurrences. A multi-paragraph segment is also tried
// with its single `\n`s widened to the markdown's `\n\n` paragraph gaps.
function findSegment(body, seg, free) {
  const variants = seg.text.includes("\n")
    ? [seg.text, seg.text.split("\n").filter((l) => l.trim()).join("\n\n")]
    : [seg.text];
  for (const needle of variants) {
    const occ = [];
    let from = 0;
    for (;;) {
      const idx = body.indexOf(needle, from);
      if (idx === -1) break;
      if (free(idx, idx + needle.length)) occ.push(idx);
      from = idx + 1;
    }
    if (occ.length === 0) continue;
    let bestIdx = occ[0];
    if (occ.length > 1 && seg.before) {
      let bestScore = -1;
      for (const idx of occ) {
        const score = contextScore(body.slice(Math.max(0, idx - CONTEXT_LEN), idx), seg.before);
        if (score > bestScore) { bestScore = score; bestIdx = idx; }
      }
    }
    return { start: bestIdx, end: bestIdx + needle.length };
  }
  return null;
}

// Locate where omitted suggestion text belongs: directly after the
// longest tail of the before-context that exists in the body (outside
// existing anchors), falling back to before the after-context's head.
function findInsertionPoint(body, seg, occupied) {
  const inside = (pos) => occupied.some((s) => pos > s.from && pos < s.to);
  const before = normalizeWs(seg.before);
  for (let len = Math.min(before.length, CONTEXT_LEN); len >= 4; len = Math.floor(len / 2)) {
    const tail = before.slice(-len).trim();
    if (tail.length < 4) break;
    const idx = body.lastIndexOf(tail);
    if (idx !== -1 && !inside(idx + tail.length)) return idx + tail.length;
  }
  const after = normalizeWs(seg.after);
  for (let len = Math.min(after.length, CONTEXT_LEN); len >= 4; len = Math.floor(len / 2)) {
    const head = after.slice(0, len).trim();
    if (head.length < 4) break;
    const idx = body.indexOf(head);
    if (idx !== -1 && !inside(idx)) return idx;
  }
  return null;
}

// How much of the wanted context's tail matches the actual text before
// an occurrence (whitespace-normalized, case-insensitive).
function contextScore(actualBefore, wantedBefore) {
  const a = normalizeWs(actualBefore).toLowerCase();
  const w = normalizeWs(wantedBefore).toLowerCase();
  let n = 0;
  while (n < a.length && n < w.length && a[a.length - 1 - n] === w[w.length - 1 - n]) n++;
  return n;
}

function normalizeWs(s) {
  return String(s || "").replace(/\s+/g, " ");
}
