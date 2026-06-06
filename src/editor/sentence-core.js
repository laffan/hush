/**
 * Low-level sentence/position helpers shared by the sentence-navigation
 * commands (`sentence-navigator.js`). Extracted so the navigator file
 * stays under the repo's 700-line cap.
 *
 * Sentence boundaries are detected within individual lines (matching
 * Obsidian/markdown paragraph semantics).
 */
import { EditorSelection } from "@codemirror/state";

// ===== Helpers bridging Obsidian line/ch positions to CM6 offsets =====

export function getLine(doc, lineNum) {
  if (lineNum < 0 || lineNum >= doc.lines) return "";
  return doc.line(lineNum + 1).text;
}

export function posToOffset(doc, pos) {
  const n = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(n);
  return line.from + Math.min(pos.ch, line.length);
}

export function offsetToPos(doc, offset) {
  const clamped = Math.max(0, Math.min(doc.length, offset));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, ch: clamped - line.from };
}

export function selBounds(doc, sel) {
  return { from: offsetToPos(doc, sel.from), to: offsetToPos(doc, sel.to) };
}

// ===== Core sentence-boundary detection (ported as-is) =====

export function findSentenceStart(doc, pos) {
  const { line } = pos;
  let ch = pos.ch;
  const content = getLine(doc, line);

  while (ch > 0) {
    if (/\s/.test(content.charAt(ch - 1))) {
      let lb = ch - 1;
      while (lb > 0 && /\s/.test(content.charAt(lb - 1))) lb--;
      while (lb > 0 && /["')\]}*_`]/.test(content.charAt(lb - 1))) lb--;
      if (lb > 0 && /[.!?]/.test(content.charAt(lb - 1))) {
        while (ch < content.length && /\s/.test(content.charAt(ch))) ch++;
        return { line, ch };
      }
    }
    ch--;
  }
  return { line, ch: 0 };
}

export function findSentenceEnd(doc, pos) {
  const { line } = pos;
  let ch = pos.ch;
  const content = getLine(doc, line);

  while (ch < content.length) {
    if (/[.!?]/.test(content.charAt(ch))) {
      ch++;
      while (ch < content.length && /["')\]}*_`]/.test(content.charAt(ch))) ch++;
      while (ch < content.length && /[ \t]/.test(content.charAt(ch))) ch++;
      return { line, ch };
    }
    ch++;
  }
  return { line, ch: content.length };
}

// ===== Selection dispatch =====

export function dispatch(view, fromPos, toPos) {
  const doc = view.state.doc;
  view.dispatch({
    selection: EditorSelection.single(posToOffset(doc, fromPos), posToOffset(doc, toPos)),
  });
}
