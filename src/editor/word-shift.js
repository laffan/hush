/**
 * Sub-sentence word shifting for CodeMirror 6.
 *
 * When the user has a partial (less-than-a-sentence) selection, the
 * "move sentence forward / back" commands shuttle the selected word(s)
 * past the adjacent word on the same line instead of swapping whole
 * sentences. The whitespace gap between the block and its neighbour is
 * preserved verbatim and moved with the swap, so words never conjoin and
 * no stray space is introduced.
 */
import { EditorSelection } from "@codemirror/state";

/** Trim a selection's whitespace edges down to the word block it covers.
 *  Returns `{ from, to }` offsets, or null when the selection is empty or
 *  all whitespace. */
function trimSelection(doc, sel) {
  if (sel.empty) return null;
  let from = sel.from;
  let to = sel.to;
  const text = doc.sliceString(from, to);
  from += text.match(/^\s*/)[0].length;
  to -= text.match(/\s*$/)[0].length;
  if (to <= from) return null;
  return { from, to };
}

/** Shift the selected word(s) forward past the next word on the same line. */
export function moveWordsForward(view) {
  const doc = view.state.doc;
  const block = trimSelection(doc, view.state.selection.main);
  if (!block) return true;
  const { from, to } = block;
  const line = doc.lineAt(to);
  const after = doc.sliceString(to, line.to);
  const m = after.match(/^([ \t]+)(\S+)/);
  if (!m) return true; // no following word on this line
  const [, gap, word] = m;
  const blockText = doc.sliceString(from, to);
  const regionTo = to + gap.length + word.length;
  const newFrom = from + word.length + gap.length;
  view.dispatch({
    changes: { from, to: regionTo, insert: word + gap + blockText },
    selection: EditorSelection.single(newFrom, newFrom + blockText.length),
    scrollIntoView: true,
  });
  return true;
}

/** Mirror of `moveWordsForward` — shift the selected word(s) back past the
 *  previous word on the same line, preserving the whitespace gap. */
export function moveWordsBack(view) {
  const doc = view.state.doc;
  const block = trimSelection(doc, view.state.selection.main);
  if (!block) return true;
  const { from, to } = block;
  const line = doc.lineAt(from);
  const before = doc.sliceString(line.from, from);
  const m = before.match(/(\S+)([ \t]+)$/);
  if (!m) return true; // no preceding word on this line
  const [, word, gap] = m;
  const blockText = doc.sliceString(from, to);
  const regionFrom = from - gap.length - word.length;
  view.dispatch({
    changes: { from: regionFrom, to, insert: blockText + gap + word },
    selection: EditorSelection.single(regionFrom, regionFrom + blockText.length),
    scrollIntoView: true,
  });
  return true;
}
