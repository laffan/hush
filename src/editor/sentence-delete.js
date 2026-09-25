/**
 * Delete sentence (⌘⌫ by default) — the delete half of Select sentence
 * (⌘L): it removes exactly the sentence ⌘L would select from a bare
 * caret. A caret at the end of a paragraph, past its final period, takes
 * that final sentence (`sentenceEndingAt`); a caret on a blank line takes
 * the line. With a selection, the selection is what goes.
 *
 * The space the sentence leaves behind goes with it, so "One. Two.
 * Three." with Two deleted reads "One. Three." — the whitespace after it
 * when the sentence was followed by more text, the whitespace before it
 * when it was the last on its line (trailing spaces, a markdown hard
 * break, are left where they are).
 */
import { EditorSelection } from "@codemirror/state";
import {
  getLine, posToOffset, offsetToPos, findSentenceStart, findSentenceEnd, sentenceEndingAt,
} from "./sentence-core.js";

/** The sentence under a bare caret, as offsets — the range `selectSentence`
 *  selects when there is no selection. */
function sentenceAtCaret(doc, head) {
  const pos = offsetToPos(doc, head);
  const content = getLine(doc, pos.line);
  if (content.trim().length === 0) {
    const from = posToOffset(doc, { line: pos.line, ch: 0 });
    const to = pos.line + 1 < doc.lines ? posToOffset(doc, { line: pos.line + 1, ch: 0 }) : doc.line(pos.line + 1).to;
    return { from, to, blank: true };
  }
  const tail = sentenceEndingAt(doc, pos);
  if (tail) return { from: posToOffset(doc, tail.start), to: posToOffset(doc, tail.end) };
  let sp = pos;
  if (/^\s*$/.test(content.substring(0, pos.ch))) {
    const fw = content.search(/\S/);
    if (fw !== -1) sp = { line: pos.line, ch: fw };
  }
  return {
    from: posToOffset(doc, findSentenceStart(doc, sp)),
    to: posToOffset(doc, findSentenceEnd(doc, sp)),
  };
}

export function deleteSentence(view) {
  // Reached through the window-level fallback, `view` is the main editor
  // whether or not it has focus; don't rewrite a document hidden behind a
  // canvas (README-TECHNICAL: window-level fallback).
  if (!view.hasFocus) return false;
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  if (!sel.empty) {
    view.dispatch({ changes: { from: sel.from, to: sel.to }, selection: EditorSelection.cursor(sel.from), userEvent: "delete" });
    return true;
  }

  let { from, to, blank } = sentenceAtCaret(doc, sel.head);
  if (to <= from) return true;
  if (blank) {
    view.dispatch({ changes: { from, to }, selection: EditorSelection.cursor(from), userEvent: "delete" });
    return true;
  }

  // Trim the range to the sentence itself (`findSentenceEnd` can run on
  // over the space after it), then take one side's separating
  // whitespace, within the line: after the sentence if more text follows
  // it, else before it.
  const span = doc.sliceString(from, to);
  from += span.length - span.trimStart().length;
  to -= span.length - span.trimEnd().length;
  if (to <= from) return true;
  const line = doc.lineAt(from);
  const after = doc.sliceString(to, line.to);
  const trailing = after.match(/^[ \t]*/)[0].length;
  if (trailing && trailing < after.length) {
    to += trailing;
  } else {
    // The last sentence on its line: the space before it goes, and any
    // trailing spaces stay — two of them are markdown's hard break.
    const before = doc.sliceString(line.from, from);
    from -= before.match(/[ \t]*$/)[0].length;
  }

  view.dispatch({
    changes: { from, to },
    selection: EditorSelection.cursor(from),
    userEvent: "delete",
    scrollIntoView: true,
  });
  return true;
}
