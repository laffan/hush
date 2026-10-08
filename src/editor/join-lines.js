/**
 * Join lines — ⌘J pulls the line below up onto the caret's line, ⌘⇧J
 * pulls the caret's line up onto the one above. The break and any
 * indentation it carried become one space (none when the pulled line is
 * blank).
 *
 * **A card in between is passed over.** In a Doc a card's markdown is
 * lines of the text that can't be seen (cards/card-doc-plugin.js): it
 * sits between the line above it and the line it is drawn beside. The
 * line "below" the caret was the `<<<` fence, and the join would have
 * put text on it — which the card's boundary guard refuses, so the keys
 * did nothing next to a card. The join now takes the two lines either
 * side of the card (or of a run of stacked cards) as the lines the
 * reader sees, and moves the cards' markdown up to just before the
 * joined line, so they stay beside the same words — what Backspace
 * across a card does.
 */
import { EditorSelection } from "@codemirror/state";
import { findCardsInDoc } from "../cards/card-model.ts";

/** The run of cards whose markdown starts right at `pos` (`dir` 1) or
 *  ends right at it (`dir` -1), as `{ from, to }`; null when none does. */
function cardRunAt(doc, pos, dir) {
  const probe = doc.lineAt(Math.min(Math.max(pos, 0), doc.length)).text;
  if (probe !== (dir > 0 ? "<<<" : ">>>")) return null;
  const cards = findCardsInDoc(doc);
  let run = null;
  for (let grew = true; grew;) {
    grew = false;
    for (const c of cards) {
      if (!run && (dir > 0 ? c.from === pos : c.to === pos)) { run = { from: c.from, to: c.to }; grew = true; }
      else if (run && dir > 0 && c.from === run.to + 1) { run.to = c.to; grew = true; }
      else if (run && dir < 0 && c.to === run.from - 1) { run.from = c.from; grew = true; }
    }
  }
  return run;
}

/** The line the caret is on as the reader sees it. The caret can stand
 *  at either end of a card's markdown — the edges of its zero-height
 *  block — which count as the end of the line above and the start of
 *  the line the card sits beside. */
function caretLine(doc, head) {
  const line = doc.lineAt(head);
  if (head === line.from && head > 0 && cardRunAt(doc, head, 1)) return doc.lineAt(head - 1);
  if (head === line.to && head < doc.length && cardRunAt(doc, head, -1)) return doc.lineAt(head + 1);
  return line;
}

/** Join line `upper` with line `lower`, the cards between them (if any)
 *  moved up before the joined line; the caret goes to the seam. */
function join(view, upper, lower, run) {
  const leadingWs = lower.text.match(/^\s*/)[0].length;
  const insert = lower.text.trim().length > 0 ? " " : "";
  if (!run) {
    view.dispatch({
      changes: { from: upper.to, to: lower.from + leadingWs, insert },
      selection: EditorSelection.cursor(upper.to + insert.length),
    });
    return true;
  }
  const doc = view.state.doc;
  const cards = doc.sliceString(run.from, run.to);
  const joined = upper.text + insert + lower.text.slice(leadingWs);
  view.dispatch({
    changes: { from: upper.from, to: lower.to, insert: `${cards}\n${joined}` },
    selection: EditorSelection.cursor(upper.from + cards.length + 1 + upper.text.length + insert.length),
  });
  return true;
}

/** Remove the next line break, joining the current line with the line below. */
export function joinLines(view) {
  const doc = view.state.doc;
  const line = caretLine(doc, view.state.selection.main.head);
  if (line.number >= doc.lines) return true; // already last line
  const run = cardRunAt(doc, line.to + 1, 1);
  if (run && run.to >= doc.length) return true; // nothing below the cards
  const lower = run ? doc.lineAt(run.to + 1) : doc.line(line.number + 1);
  return join(view, line, lower, run);
}

/** Remove the previous line break, joining the current line with the line above. */
export function joinLinesUp(view) {
  const doc = view.state.doc;
  const line = caretLine(doc, view.state.selection.main.head);
  if (line.number <= 1) return true; // already first line
  const run = cardRunAt(doc, line.from - 1, -1);
  if (run && run.from <= 0) return true; // nothing above the cards
  const upper = run ? doc.lineAt(run.from - 1) : doc.line(line.number - 1);
  return join(view, upper, line, run);
}
