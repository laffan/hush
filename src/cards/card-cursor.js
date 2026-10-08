/**
 * Where "insert at cursor" puts a card's words when the card isn't in a
 * Doc of its own — a card on a canvas has no caret beside it. It goes to
 * the last document surface that held the keyboard (the main editor, a
 * pane, a stack column), provided that surface is still on screen; a
 * card's own editor never counts.
 */
import { EditorView } from "@codemirror/view";
import { insideCard } from "./card-facet.js";
import { linkReturn } from "./card-return.js";

let last = null; // WeakRef<EditorView>

export const noteHostView = EditorView.updateListener.of((update) => {
  if (!update.focusChanged || !update.view.hasFocus) return;
  if (update.state.facet(insideCard)) return;
  last = typeof WeakRef === "function" ? new WeakRef(update.view) : { deref: () => update.view };
});

/** The remembered document view, if it is still showing. */
export function rememberedHostView() {
  const view = last?.deref?.();
  if (!view || !view.dom.isConnected) return null;
  if (!view.dom.getClientRects().length) return null; // hidden behind a canvas
  return view;
}

/** Where insert-at-cursor would put a canvas card's words: the
 *  remembered view's caret, or null. */
export function rememberedInsertPoint() {
  const view = rememberedHostView();
  return view ? { view, pos: view.state.selection.main.head } : null;
}

/** Insert `text` at the remembered caret. False when there is none.
 *  `back` (card-return.js) puts the card back where it came from when
 *  the insertion is undone. */
export function insertAtRememberedCursor(text, back = null) {
  const view = rememberedHostView();
  if (!view) return false;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: "input.card",
  });
  linkReturn(view, head, head + text.length, back);
  view.focus();
  return true;
}
