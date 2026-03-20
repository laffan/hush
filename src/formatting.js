/**
 * Markdown formatting toggle commands for CodeMirror 6.
 * Supports bold, italic, highlight (==), and Obsidian-style comments (%%).
 */
import { EditorSelection } from "@codemirror/state";

function toggleWrap(view, marker) {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const mLen = marker.length;

  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.head, insert: marker + marker },
      selection: EditorSelection.cursor(sel.head + mLen),
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
