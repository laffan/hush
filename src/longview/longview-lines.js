/**
 * Outline View line helpers — tokenizing document text into outline
 * paragraph lines, and rendering those lines with Google-Docs comment
 * runs highlighted. Split out of `longview.js` to keep that file under
 * the line budget.
 */
import { sanitizeLine } from "./longview-parser.js";
import { parseTabMarkerLine } from "../editor/tabs.js";

/**
 * Paint a sanitized outline line into `p`, rendering Google-Docs comment
 * anchors as highlighted runs. `{>text<id}` highlights `text`; the
 * dangling halves of a multi-line anchor highlight to the end of the line
 * (after a lone `{>`) or from its start (before a lone `<id}`). The marker
 * characters themselves never render.
 */
export function renderLineWithCommentHighlights(p, line) {
  if (!line.includes("{>") && !/<[A-Za-z0-9]{1,4}\}/.test(line)) {
    p.textContent = line;
    return;
  }
  const segments = []; // { text, hi }
  let buf = "";
  let hi = false;
  const push = () => { if (buf) { segments.push({ text: buf, hi }); buf = ""; } };
  for (let i = 0; i < line.length; ) {
    if (line.startsWith("{>", i)) { push(); hi = true; i += 2; continue; }
    const m = /^<[A-Za-z0-9]{1,4}\}/.exec(line.slice(i));
    if (m) {
      if (!hi) {
        // Tail of an anchor opened on a previous line — everything up to
        // here was inside the comment.
        for (const s of segments) s.hi = true;
        hi = true;
      }
      push();
      hi = false;
      i += m[0].length;
      continue;
    }
    buf += line[i++];
  }
  push();
  for (const s of segments) {
    if (s.hi) {
      const span = document.createElement("span");
      span.className = "longview-comment-highlight";
      span.textContent = s.text;
      p.appendChild(span);
    } else {
      p.appendChild(document.createTextNode(s.text));
    }
  }
}

/**
 * Split text into trimmed, sanitized outline lines, preserving each
 * surviving line's start offset (in the original document) so the
 * outline can highlight the paragraph nearest the cursor. Comment
 * anchors survive sanitization so the renderer can paint the commented
 * runs as highlights (see `renderLineWithCommentHighlights`).
 */
export function tokenizeLinesWithOffsets(text, baseOffset) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const out = [];
  let cursor = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#") && parseTabMarkerLine(trimmed) == null && trimmed !== "---hush-separator---") {
      const clean = sanitizeLine(trimmed, { keepComments: true });
      if (clean.length > 0) out.push({ line: clean, offset: baseOffset + cursor });
    }
    cursor += raw.length + 1; // +1 for the \n we split on
  }
  return out;
}
