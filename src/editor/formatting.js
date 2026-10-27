/**
 * Markdown formatting toggle commands for CodeMirror 6.
 * Supports bold, italic, highlight (==), strikethrough (~~) and
 * Obsidian-style comments (%%). Each wraps the selection less any
 * whitespace at its ends (`trimmedSelection`). Blockquote (`> `) works
 * by line instead: every line the selection touches.
 */
import { EditorSelection } from "@codemirror/state";
import { bypassRatchet } from "./ratchet.js";

/** The selection with any leading / trailing whitespace and line breaks
 *  left out, so markers sit flush against the first and last non-blank
 *  characters: `** word**` is not bold to a markdown parser, and a
 *  selection made by dragging or double-clicking often overshoots into
 *  the space beside a word. A selection that is all whitespace is left
 *  as it is. */
function trimmedSelection(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return sel;
  const text = view.state.doc.sliceString(sel.from, sel.to);
  const leading = text.match(/^\s*/)[0].length;
  const trailing = text.match(/\s*$/)[0].length;
  if (leading + trailing >= text.length) return sel;
  return EditorSelection.range(sel.from + leading, sel.to - trailing);
}

/** `annotations` rides on every dispatch this makes — strikethrough
 *  passes the ratchet bypass so it stays the one edit a ratcheted
 *  selection is allowed to make. */
function toggleWrap(view, marker, annotations) {
  const sel = trimmedSelection(view);
  const doc = view.state.doc;
  const mLen = marker.length;

  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.head, insert: marker + marker },
      selection: EditorSelection.cursor(sel.head + mLen),
      annotations,
    });
    return true;
  }

  const text = doc.sliceString(sel.from, sel.to);

  // Case 1: selection itself includes the markers
  if (text.startsWith(marker) && text.endsWith(marker) && text.length >= mLen * 2) {
    const inner = text.slice(mLen, -mLen);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: inner },
      selection: EditorSelection.single(sel.from, sel.from + inner.length),
      annotations,
    });
    return true;
  }

  // Case 2: markers sit immediately outside the selection
  const before = doc.sliceString(Math.max(0, sel.from - mLen), sel.from);
  const after = doc.sliceString(sel.to, Math.min(doc.length, sel.to + mLen));

  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: sel.from - mLen, to: sel.from },
        { from: sel.to, to: sel.to + mLen },
      ],
      selection: EditorSelection.single(sel.from - mLen, sel.to - mLen),
      annotations,
    });
    return true;
  }

  // Case 3: wrap the selection
  view.dispatch({
    changes: [
      { from: sel.from, insert: marker },
      { from: sel.to, insert: marker },
    ],
    selection: EditorSelection.single(sel.from + mLen, sel.to + mLen),
    annotations,
  });
  return true;
}

/** Toggle **bold** on the selection. */
export function toggleBold(view) {
  return toggleWrap(view, "**");
}

/** Toggle *italic* on the selection. */
export function toggleItalic(view) {
  return toggleWrap(view, "*");
}

/** Toggle ==highlight== on the selection. */
export function toggleHighlight(view) {
  return toggleWrap(view, "==");
}

/** Toggle %%comment%% on the selection (Obsidian-flavored markdown). */
export function toggleComment(view) {
  return toggleWrap(view, "%%");
}

/** Toggle ~~strikethrough~~ on the selection.
 *
 *  Every dispatch carries `bypassRatchet`: under a Desk Ratchet the
 *  user can select committed text, and striking it through is the one
 *  revision the mode allows (see editor/ratchet.js). */
export function toggleStrikethrough(view) {
  return toggleWrap(view, "~~", [bypassRatchet.of(true)]);
}

/** Toggle `> ` blockquote on every line the selection touches (the
 *  caret's line when nothing is selected). Off when every non-blank line
 *  is already quoted, on otherwise — blank lines inside a quoted run take
 *  a bare `>` so the quote stays one block. The selection maps through. */
export function toggleBlockquote(view) {
  const { state } = view;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  // A selection ending at the very start of a line doesn't take that line.
  let last = state.doc.lineAt(sel.to).number;
  if (last > first && sel.to === state.doc.line(last).from) last--;
  const lines = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
  const filled = lines.filter((l) => l.text.trim());
  const quoted = filled.length > 0 && filled.every((l) => /^\s*>/.test(l.text));
  const changes = [];
  for (const line of lines) {
    if (quoted) {
      const m = /^(\s*)> ?/.exec(line.text);
      if (m) changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: "" });
    } else if (!/^\s*>/.test(line.text)) {
      changes.push({ from: line.from, insert: line.text.trim() || lines.length === 1 ? "> " : ">" });
    }
  }
  if (!changes.length) return true;
  view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
  return true;
}
