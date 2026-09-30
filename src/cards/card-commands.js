/**
 * ⌘⇧, (`shortcutMakeCard`): make a card of what is selected.
 *
 *   - **In a Doc** the selection is fenced as a card where it stands —
 *     `<<<` and `>>>` on lines of their own, so a selection in the middle
 *     of a line splits the line around the card.
 *   - **On a canvas** each selected text shape becomes a card in place.
 *
 * More than `CARD_CONFIRM_WORDS` words asks first, as a card typed or
 * pasted into existence does. Which surface the key is meant for is the
 * focus's call: the CodeMirror keymap hands this the view that has it,
 * and the window-level fallback hands it the main editor whether or not
 * that is focused (README-TECHNICAL: a command reached that way must not
 * rewrite the document hidden behind a canvas) — so an unfocused view
 * means "try the canvas".
 */

import { Transaction } from "@codemirror/state";
import { cardEdit, insideCard } from "./card-facet.js";
import { confirmLongCard } from "./card-confirm.js";
import { serializeCard, isFenceLine } from "./card-model.ts";

async function toast(message) {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, "info");
}

/** Fence a Doc's selection as a card. */
export function makeCardFromSelection(view) {
  if (view.state.facet(insideCard)) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const doc = view.state.doc;
  const raw = doc.sliceString(sel.from, sel.to);
  // Whole lines selected with their trailing break: the break stays in
  // the text, the card takes the lines.
  const to = raw.endsWith("\n") ? sel.to - 1 : sel.to;
  const text = doc.sliceString(sel.from, to);
  if (!text.trim()) return false;
  if (text.split("\n").some(isFenceLine)) {
    void toast("A card can't hold another card");
    return true;
  }
  const make = () => {
    if (view.state.doc !== doc) return; // changed while the question was up
    // Cut out of the middle of a line, the spaces either side of the cut
    // would be left hanging on the two halves.
    let from = sel.from;
    let end = to;
    const first = doc.lineAt(from);
    const last = doc.lineAt(end);
    while (from > first.from && /[ \t]/.test(doc.sliceString(from - 1, from))) from--;
    while (end < last.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
    const atStart = first.from === from;
    const atEnd = last.to === end;
    // At the very end of the document the card gets a line after it, so
    // the caret has somewhere to go that isn't the card's edge.
    const insert = (atStart ? "" : "\n") + serializeCard(text, null) + (atEnd && end < doc.length ? "" : "\n");
    view.dispatch({
      changes: { from, to: end, insert },
      // The caret lands after the card, at the start of the line below.
      selection: { anchor: from + insert.length + (atEnd && end < doc.length ? 1 : 0) },
      annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
      scrollIntoView: true,
    });
    view.focus();
  };
  void confirmLongCard(text).then((ok) => { if (ok) make(); else view.focus(); });
  return true;
}

/** The canvas the keyboard is on, if one is showing. */
async function activeCanvasState() {
  const { getActiveNotebookState } = await import("../notebook/notes-canvas.ts");
  const st = getActiveNotebookState();
  return st?.canvasEl?.isConnected && st.canvasEl.getClientRects().length ? st : null;
}

/** Turn a canvas's selected text shapes into cards. */
async function makeCardsOnCanvas() {
  const st = await activeCanvasState();
  if (!st) return;
  const cs = await import("../notebook/card-shape.ts");
  const picked = cs.convertibleToCards(st);
  if (!picked.length) return;
  const longest = picked.reduce((a, s) => (s.text.length > a.length ? s.text : a), "");
  if (!(await confirmLongCard(longest))) return;
  cs.convertShapesToCards(st, picked.map((s) => s.id));
}

/** The command behind the shortcut (editor/commands.js). */
export function makeCardCommand(state, view) {
  if (view && view.hasFocus) return makeCardFromSelection(view);
  const canvasShowing = document.body.classList.contains("notebook-mode") || !!document.querySelector(".floating-pane.active canvas");
  if (!canvasShowing) return false;
  void makeCardsOnCanvas();
  return true;
}
