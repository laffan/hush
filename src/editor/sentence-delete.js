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
 *
 * A caret inside a parenthetical takes the parenthetical first, the way
 * ⌘L selects it first (sentence-parenthetical.js): "He left (tired) and
 * slept." reads "He left and slept.", and the next press takes that.
 */
import { EditorSelection } from "@codemirror/state";
import {
  getLine, posToOffset, offsetToPos, findSentenceStart, findSentenceEnd, sentenceEndingAt,
} from "./sentence-core.js";
import { parentheticalAt } from "./sentence-parenthetical.js";

/** A parenthetical plus the one run of spaces that would otherwise be
 *  left doubled: the space before it, unless it starts the line's text
 *  (then the space after it) or butts against a word after it
 *  ("left (tired)and" keeps its space). */
function parentheticalDeletion(paren) {
  const { line } = paren;
  let { from, to } = paren;
  const before = line.text.slice(0, from - line.from);
  const after = line.text.slice(to - line.from);
  const lead = before.match(/[ \t]*$/)[0].length;
  if (lead === before.length) to += after.match(/^[ \t]*/)[0].length;
  else if (lead && !/^[\p{L}\p{N}]/u.test(after)) from -= lead;
  return { from, to };
}

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

  const paren = parentheticalAt(doc, sel.head);
  if (paren) {
    const cut = parentheticalDeletion(paren);
    view.dispatch({ changes: cut, selection: EditorSelection.cursor(cut.from), userEvent: "delete", scrollIntoView: true });
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

/** What opens a line's text — a list marker (with its checkbox), a
 *  heading's hashes, a quote's `>` — which deleting back to a sentence
 *  start leaves in place. */
const LINE_PREFIX = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+|>[ \t]?)/;

/**
 * Delete to sentence start (⌘⇧⌫ by default) — the delete half of ⌘⇧←,
 * which selects the same span: from the caret back to the start of the
 * sentence it is in, and no further. A line's list marker, heading hashes
 * or quote mark stay. With the caret already at a sentence's start it
 * takes the sentence before it on the line; at the start of the line's
 * text it joins the line to the one above, as Backspace would. With a
 * selection, the selection is what goes.
 */
export function deleteToSentenceStart(view) {
  // Same guard as deleteSentence: the window-level fallback hands over
  // the main editor even when a canvas is in front of it.
  if (!view.hasFocus) return false;
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  if (!sel.empty) {
    view.dispatch({ changes: { from: sel.from, to: sel.to }, selection: EditorSelection.cursor(sel.from), userEvent: "delete" });
    return true;
  }
  const head = sel.head;
  const line = doc.lineAt(head);
  const ch = head - line.from;
  const prefix = (line.text.match(LINE_PREFIX) || [""])[0].length;
  let from;
  if (ch <= prefix) {
    // Nothing of the sentence behind the caret on this line: join up.
    if (line.number === 1) return true;
    from = line.from - 1;
  } else {
    const pos = { line: line.number - 1, ch };
    from = posToOffset(doc, findSentenceStart(doc, pos));
    if (from >= head) {
      // At a sentence's start: step back over the space and the closing
      // marks before it and take the previous sentence.
      let back = ch;
      while (back > prefix && /\s/.test(line.text.charAt(back - 1))) back--;
      from = back > prefix ? posToOffset(doc, findSentenceStart(doc, { line: pos.line, ch: back })) : line.from + prefix;
    }
    from = Math.max(from, line.from + prefix);
  }
  if (from >= head) return true;
  view.dispatch({
    changes: { from, to: head },
    selection: EditorSelection.cursor(from),
    userEvent: "delete",
    scrollIntoView: true,
  });
  return true;
}
