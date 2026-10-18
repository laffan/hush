/**
 * Option-↑ / Option-↓ — move the caret's line (or every line the
 * selection touches) up or down past its neighbour, as in a code editor.
 *
 * CodeMirror's `moveLineUp` / `moveLineDown` do this one raw line at a
 * time, which is right everywhere but beside a card. In a Doc a card's
 * markdown is lines of the text that can't be seen (cards/
 * card-doc-plugin.js), drawn beside the line after it — so a raw move
 * either swapped a line with a fence (refused by the card's boundary
 * guard: the keys did nothing next to a card) or walked a line into the
 * card. Here a line travels with the cards drawn beside it, and steps
 * over the cards beside its neighbour, so every card stays beside the
 * words it was beside. With no card in the document the stock commands
 * run unchanged.
 *
 * Outlines bind the same keys at `Prec.high` (outline-view.js) and move
 * an item with its children; outside an outline they claim nothing and
 * these run.
 */
import { EditorSelection } from "@codemirror/state";
import { moveLineUp, moveLineDown } from "@codemirror/commands";
import { findCardsInDoc } from "../cards/card-model.ts";

/** Per line number, the card covering it (null for a visible line). */
function cardLineMap(doc, cards) {
  const covered = new Map();
  for (const c of cards) {
    const a = doc.lineAt(c.from).number;
    const b = doc.lineAt(c.to).number;
    for (let n = a; n <= b; n++) covered.set(n, c);
  }
  return covered;
}

/** First line of the run of cards stacked directly above line `n` —
 *  the cards drawn beside it — or `n` itself when there are none. */
function unitStart(doc, covered, n) {
  let start = n;
  while (start > 1 && covered.has(start - 1)) {
    start = doc.lineAt(covered.get(start - 1).from).number;
  }
  return start;
}

/** The visible line a selection edge stands on. A caret can sit at
 *  either end of a card's markdown (the edges of its zero-height block),
 *  which read as the end of the line above and the start of the line the
 *  card is drawn beside. */
function visibleLine(doc, covered, pos, dir) {
  let n = doc.lineAt(pos).number;
  while (covered.has(n)) {
    const c = covered.get(n);
    n = dir < 0 && pos <= c.from
      ? doc.lineAt(c.from).number - 1
      : doc.lineAt(c.to).number + 1;
    if (n < 1) return 1;
    if (n > doc.lines) return doc.lines;
  }
  return n;
}

function moveLines(view, dir) {
  const { state } = view;
  const doc = state.doc;
  const cards = findCardsInDoc(doc);
  if (!cards.length || state.selection.ranges.length > 1) {
    return dir < 0 ? moveLineUp(view) : moveLineDown(view);
  }
  const covered = cardLineMap(doc, cards);
  const sel = state.selection.main;
  let toPos = sel.to;
  // A selection that ends at the start of a line doesn't take that line
  // (CodeMirror's rule too).
  if (!sel.empty && toPos === doc.lineAt(toPos).from && toPos > sel.from) toPos -= 1;
  const first = visibleLine(doc, covered, sel.from, -1);
  const last = sel.empty ? first : Math.max(first, visibleLine(doc, covered, toPos, 1));
  const blockStart = unitStart(doc, covered, first);
  const from = doc.line(blockStart).from;
  const to = doc.line(last).to;
  const block = doc.sliceString(from, to);

  let changes;
  let shift;
  if (dir < 0) {
    if (blockStart <= 1) return true;
    const prev = blockStart - 1;
    const prevFrom = doc.line(unitStart(doc, covered, prev)).from;
    const prevText = doc.sliceString(prevFrom, doc.line(prev).to);
    changes = { from: prevFrom, to, insert: `${block}\n${prevText}` };
    shift = -(prevText.length + 1);
  } else {
    if (last >= doc.lines) return true;
    // The neighbour below, with the cards drawn beside it.
    let next = last + 1;
    while (next < doc.lines && covered.has(next)) next = doc.lineAt(covered.get(next).to).number + 1;
    if (covered.has(next)) return true; // only cards below — nothing to pass
    const nextText = doc.sliceString(doc.line(last + 1).from, doc.line(next).to);
    changes = { from, to: doc.line(next).to, insert: `${nextText}\n${block}` };
    shift = nextText.length + 1;
  }
  // A caret parked on a card's edge reads as the end or start of the
  // neighbouring line; it travels with the line it was read as.
  const carry = (p) => Math.min(Math.max(p, from), to) + shift;
  view.dispatch({
    changes,
    selection: EditorSelection.range(carry(sel.anchor), carry(sel.head)),
    scrollIntoView: true,
    userEvent: "move.line",
  });
  return true;
}

export const moveLineKeymap = [
  { key: "Alt-ArrowUp", run: (view) => moveLines(view, -1) },
  { key: "Alt-ArrowDown", run: (view) => moveLines(view, 1) },
];
