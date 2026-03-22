/**
 * Focus Mode — dims all text except the current sentence to 50% opacity.
 * Uses the same sentence-boundary detection as sentence-navigator.js.
 */
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// ===== Sentence boundary detection (mirrors sentence-navigator.js) =====

function getLine(doc, lineNum) {
  if (lineNum < 0 || lineNum >= doc.lines) return "";
  return doc.line(lineNum + 1).text;
}

function posToOffset(doc, pos) {
  const n = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(n);
  return line.from + Math.min(pos.ch, line.length);
}

function offsetToPos(doc, offset) {
  const clamped = Math.max(0, Math.min(doc.length, offset));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, ch: clamped - line.from };
}

function findSentenceStart(doc, pos) {
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

function findSentenceEnd(doc, pos) {
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

// ===== Decoration marks =====

const dimMark = Decoration.mark({ class: "focus-mode-dim" });

// ===== ViewPlugin =====

export function createFocusModePlugin(state) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.lastFocusMode = state.focusMode;
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        const focusChanged = state.focusMode !== this.lastFocusMode;
        this.lastFocusMode = state.focusMode;
        if (
          focusChanged ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view) {
        if (!state.focusMode) return Decoration.none;

        const doc = view.state.doc;
        if (doc.length === 0) return Decoration.none;

        const head = view.state.selection.main.head;
        const cursorPos = offsetToPos(doc, head);
        const lineContent = getLine(doc, cursorPos.line);

        // If cursor is on an empty line, highlight nothing (dim everything)
        let sentStart, sentEnd;
        if (lineContent.trim().length === 0) {
          sentStart = head;
          sentEnd = head;
        } else {
          const ss = findSentenceStart(doc, cursorPos);
          const se = findSentenceEnd(doc, cursorPos);
          sentStart = posToOffset(doc, ss);
          sentEnd = posToOffset(doc, se);
        }

        const builder = new RangeSetBuilder();

        // Dim everything before the current sentence
        if (sentStart > 0) {
          builder.add(0, sentStart, dimMark);
        }
        // Dim everything after the current sentence
        if (sentEnd < doc.length) {
          builder.add(sentEnd, doc.length, dimMark);
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
