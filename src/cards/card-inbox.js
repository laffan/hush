/**
 * Send Cards to Inbox (the command palette): every card in the document
 * or notebook in front of the user goes to the CARDS notebook in the
 * active desk's Inbox — the common home Courier's cards go to
 * (card-courier.js) — and leaves where it was, one undo step there.
 *
 * "In front of the user" is the active pane's file if a pane has the
 * focus, else the main surface's. Hidden when that file has no cards, and
 * for the CARDS notebook itself.
 */

import { Transaction } from "@codemirror/state";
import { panes } from "../pane/pane-state.js";
import { getActivePaneId } from "../pane/pane-manager.js";
import { cardField } from "./card-doc-plugin.js";
import { cardEdit } from "./card-facet.js";
import { cardRemovalRange, withoutPosition } from "./card-model.ts";
import { notebookCards } from "./card-index.js";
import { findCardsNotebook, sendCardToInbox } from "./card-courier.js";
import { liveNotebook } from "./card-transfer.js";

/** `{ kind: "doc", view, fileId } | { kind: "nb", fileId } | null` */
function cardSurface(state) {
  const pane = panes.get(getActivePaneId());
  if (pane && !pane.localSync) {
    if (pane.fileType === "document" && pane.editor?.view) return { kind: "doc", view: pane.editor.view, fileId: pane.fileId };
    if (pane.fileType === "notebook") return { kind: "nb", fileId: pane.fileId };
  }
  if (state.currentNotebookFileId) return { kind: "nb", fileId: state.currentNotebookFileId };
  if (state.editor?.view && state.currentFileId && !state.currentProjectId && !state.currentPdfFileId && !state.currentStackFileId) {
    return { kind: "doc", view: state.editor.view, fileId: state.currentFileId };
  }
  return null;
}

function docCards(view) {
  return view.state.field(cardField, false)?.cards || [];
}

/** Whether the palette entry shows. */
export function hasCardsToSend(state) {
  const s = cardSurface(state);
  if (!s || s.fileId === findCardsNotebook(state)?.fileId) return false;
  return s.kind === "doc" ? docCards(s.view).length > 0 : notebookCards(s.fileId).length > 0;
}

/** Each card's removal range, merged where two meet (the last card's
 *  range reaches back into the one before it). */
function removals(doc, cards) {
  const out = [];
  for (const r of cards.map((c) => cardRemovalRange(doc, c)).sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r, insert: "" });
  }
  return out;
}

async function toast(message, kind = "info") {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, kind);
}

export async function sendSurfaceCardsToInbox(state) {
  const s = cardSurface(state);
  if (!s) return;
  try {
    let name = "";
    let count = 0;
    if (s.kind === "doc") {
      const cards = docCards(s.view);
      for (const c of cards) name = await sendCardToInbox(state, c.body, withoutPosition(c.meta));
      // Taken out together, from the document as it stands now.
      const now = docCards(s.view).filter((c) => cards.some((x) => x.body === c.body));
      s.view.dispatch({
        changes: removals(s.view.state.doc, now),
        annotations: [cardEdit.of(true), Transaction.userEvent.of("delete.card")],
      });
      count = cards.length;
    } else {
      const live = liveNotebook(s.fileId);
      if (!live) throw new Error("Open that notebook to send its cards");
      const shapes = live.state.shapes.filter((x) => x.type === "text" && x.card);
      for (const x of shapes) name = await sendCardToInbox(state, x.text, x.cardMeta || {});
      const { removeCardShapes } = await import("../notebook/card-shape.ts");
      removeCardShapes(live.state, shapes.map((x) => x.id));
      count = shapes.length;
    }
    if (count) await toast(count > 1 ? `${count} cards sent to ${name}` : `Card sent to ${name}`);
  } catch (e) {
    await toast(e?.message || "The cards couldn't be sent", "error");
  }
}
