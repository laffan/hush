/**
 * ⌘⇧, (`shortcutMakeCard`): make a card of what is selected — or, with
 * nothing selected, an empty card to type into. ⌘⇧. (`shortcutCopyCard`)
 * is its pair, `<` and `>`: the card is made from a copy of the
 * selection and the text stays as it was — a draft line kept while a
 * revision is tried in the margin. With nothing selected it, too, makes
 * an empty card.
 *
 *   - **In a Doc** the selection is fenced as a card where it stands —
 *     `<<<` and `>>>` on lines of their own, so a selection in the middle
 *     of a line splits the line around the card. With no selection an
 *     empty card goes in beside the caret's line — its markdown on lines
 *     of its own above that line, the text untouched — and its editor
 *     takes the keyboard.
 *   - **On a canvas** each selected text shape becomes a card in place.
 *     With no text shape selected an empty card lands under the pointer
 *     (the middle of the view when the pointer is elsewhere), focused.
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
import { focusCardWhenBound } from "./card-doc-plugin.js";
import { confirmLongCard } from "./card-confirm.js";
import { serializeCard, isFenceLine, cardInsertion } from "./card-model.ts";

async function toast(message) {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, "info");
}

/** An empty card beside the caret's line in a Doc, its editor focused.
 *  The text is left exactly as it was: a Doc card sits beside the line
 *  after its markdown, so the markdown goes in on lines of its own just
 *  above the caret's line (`cardInsertion`, which also steps out of
 *  frontmatter and code blocks) rather than splitting the line or
 *  adding a blank one. */
export function insertEmptyCard(view) {
  if (view.state.facet(insideCard)) return false;
  const doc = view.state.doc;
  const pos = view.state.selection.main.head;
  const { from, insert } = cardInsertion(doc, doc.lineAt(pos).from, serializeCard("", null));
  // `insert` is the card's lines plus their break, or — appended at the
  // very end of the document — a break and then the card's lines.
  const cardFrom = insert.startsWith("\n") ? from + 1 : from;
  focusCardWhenBound(view, cardFrom);
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from <= pos ? pos + insert.length : pos },
    annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
    scrollIntoView: true,
  });
  return true;
}

/** A card holding a copy of a Doc's selection, beside the selection's
 *  first line; the text is left exactly as it was. */
export function copySelectionToCard(view) {
  if (view.state.facet(insideCard)) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return insertEmptyCard(view);
  const doc = view.state.doc;
  const text = doc.sliceString(sel.from, sel.to).replace(/\n+$/, "").trim();
  if (!text) return false;
  if (text.split("\n").some(isFenceLine)) {
    void toast("A card can't hold another card");
    return true;
  }
  const make = () => {
    if (view.state.doc !== doc) return; // changed while the question was up
    const { from, insert } = cardInsertion(doc, doc.lineAt(sel.from).from, serializeCard(text, null));
    const changes = view.state.changes({ from, insert });
    view.dispatch({
      changes,
      // The selection stays on the words it was on.
      selection: view.state.selection.map(changes, 1),
      annotations: [cardEdit.of(true), Transaction.userEvent.of("input.card")],
      scrollIntoView: true,
    });
    view.focus();
  };
  void confirmLongCard(text).then((ok) => { if (ok) make(); else view.focus(); });
  return true;
}

/** Fence a Doc's selection as a card. */
export function makeCardFromSelection(view) {
  if (view.state.facet(insideCard)) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return insertEmptyCard(view);
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

// Where the pointer last was, so a canvas card can land under it.
let lastPointer = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
}

/** An empty card under the pointer — or in the middle of the view when
 *  the pointer isn't over the canvas — focused for typing. */
async function addEmptyCardOnCanvas(st, cs) {
  const { viewCentreWorld, screenToWorld } = await import("./card-transfer.js");
  const r = st.canvasEl.getBoundingClientRect();
  const p = lastPointer;
  const over = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  const at = over ? screenToWorld(st.camera, p.x - r.left, p.y - r.top) : viewCentreWorld(st);
  const shape = cs.addCardShapeCentred(st, "", null, at);
  st.focusCardId = shape.id;
  st.notify("shapes");
}

/** Turn a canvas's selected text shapes into cards — or, with `copy`,
 *  add a card holding each one's words beside it and leave the shape be;
 *  with none selected, add an empty card. */
async function makeCardsOnCanvas(copy) {
  const st = await activeCanvasState();
  if (!st) return;
  const cs = await import("../notebook/card-shape.ts");
  const picked = cs.convertibleToCards(st);
  if (!picked.length) {
    if (!st.selectedIds?.size) await addEmptyCardOnCanvas(st, cs);
    return;
  }
  const longest = picked.reduce((a, s) => (s.text.length > a.length ? s.text : a), "");
  if (!(await confirmLongCard(longest))) return;
  if (copy) cs.copyShapesToCards(st, picked.map((s) => s.id));
  else cs.convertShapesToCards(st, picked.map((s) => s.id));
}

function canvasCommand(copy) {
  const canvasShowing = document.body.classList.contains("notebook-mode") || !!document.querySelector(".floating-pane.active canvas");
  if (!canvasShowing) return false;
  void makeCardsOnCanvas(copy);
  return true;
}

/** The command behind ⌘⇧, (editor/commands.js). */
export function makeCardCommand(state, view) {
  if (view && view.hasFocus) return makeCardFromSelection(view);
  return canvasCommand(false);
}

/** The command behind ⌘⇧. — the same, from a copy of the selection. */
export function copyCardCommand(state, view) {
  if (view && view.hasFocus) return copySelectionToCard(view);
  return canvasCommand(true);
}
