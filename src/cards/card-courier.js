/**
 * Courier's **Card**: the note becomes a card in a notebook named CARDS
 * in the active desk's Inbox — made on the spot, with the card already in
 * it, the first time one is sent. Successive cards form a grid: each
 * lands in the first slot of a four-wide grid of default-sized cards
 * that nothing already covers (notebook/card-shape.ts#freeCardSlot), so
 * a card moved away frees its slot for the next.
 *
 * The notebook is written the way every card delivery is
 * (card-transfer.js): through the canvas showing it, if one is, else
 * through its file.
 */

import { findNode } from "../state/tree-helpers.js";
import { addCardToNotebook } from "./card-transfer.js";
import { publishNotebookCards } from "./card-index.js";

export const CARDS_NOTEBOOK = "CARDS";
/** Where the grid starts: clear of the canvas toolbar at the default view. */
const GRID_ORIGIN = { x: 80, y: 90 };

function findCardsNotebook(state) {
  const inbox = findNode(state.fileTree, state.getInboxId());
  return (inbox?.children || []).find((n) => n.type === "notebook" && n.name === CARDS_NOTEBOOK && n.fileId) || null;
}

/** Send a card to CARDS. Returns the notebook's name, for the toast. */
export async function sendCardToInbox(state, body, meta) {
  const existing = findCardsNotebook(state);
  if (existing) {
    await addCardToNotebook(state, existing.fileId, body, meta, { place: "grid", origin: GRID_ORIGIN });
    return existing.name;
  }
  const { makeCardShape, cardIndexOf } = await import("../notebook/card-shape.ts");
  const shape = makeCardShape(body, meta, { ...GRID_ORIGIN });
  const envelope = { format: "hushnote", version: 1, shapes: [shape] };
  const made = await state.createNotebook(CARDS_NOTEBOOK, state.getInboxId(), {
    openImmediately: false,
    initialContent: JSON.stringify(envelope),
  });
  if (!made?.fileId) throw new Error("Couldn't make the CARDS notebook");
  publishNotebookCards(made.fileId, cardIndexOf(envelope.shapes));
  return made.name;
}
