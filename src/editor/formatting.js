/**
 * Markdown formatting toggle commands for CodeMirror 6.
 * Supports bold, italic, highlight (==), and Obsidian-style comments (%%).
 */
import { EditorSelection } from "@codemirror/state";
import { bypassRatchet } from "./ratchet.js";

/** `annotations` rides on every dispatch this makes — strikethrough
 *  passes the ratchet bypass so it stays the one edit a ratcheted
 *  selection is allowed to make. */
function toggleWrap(view, marker, annotations) {
  const sel = view.state.selection.main;
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

/** Toggle ~~strikethrough~~ on the selection, trimming any leading or
 *  trailing whitespace / line breaks so the markers sit flush against
 *  the first and last non-blank characters. Matches what users expect
 *  when they drag a selection that overshoots the words they want
 *  struck through.
 *
 *  Every dispatch carries `bypassRatchet`: under a Desk Ratchet the
 *  user can select committed text, and striking it through is the one
 *  revision the mode allows (see editor/ratchet.js). */
export function toggleStrikethrough(view) {
  const strike = [bypassRatchet.of(true)];
  const sel = view.state.selection.main;
  if (sel.empty) return toggleWrap(view, "~~", strike);
  const text = view.state.doc.sliceString(sel.from, sel.to);
  const leading = text.match(/^\s*/)[0].length;
  const trailing = text.match(/\s*$/)[0].length;
  // All whitespace, or no whitespace to trim — defer to the normal path.
  if (leading + trailing >= text.length || (leading === 0 && trailing === 0)) {
    return toggleWrap(view, "~~", strike);
  }
  const innerFrom = sel.from + leading;
  const innerTo = sel.to - trailing;
  view.dispatch({
    selection: EditorSelection.range(innerFrom, innerTo),
  });
  return toggleWrap(view, "~~", strike);
}
