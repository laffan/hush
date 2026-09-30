/**
 * The CARDS notebook: a container's common home for cards — a notebook
 * named CARDS (a reserved name, state/tree-helpers.js) in an Inbox or a
 * project, made on the spot, with the card already in it, the first time
 * one is sent. Courier's **Card** sends to the active desk's Inbox; a
 * card dropped on an Inbox's or a project's row in the sidebar goes to
 * that container's; the palette's Send Cards to Inbox (card-inbox.js)
 * to the Inbox's. Successive cards form a grid: each lands in the first
 * slot of a four-wide grid of default-sized cards that nothing already
 * covers (notebook/card-shape.ts#freeCardSlot), so a card moved away
 * frees its slot for the next.
 *
 * The notebook is written the way every card delivery is
 * (card-transfer.js): through the canvas showing it, if one is, else
 * through its file.
 */

import { findNode, isCardsHome, CARDS_HOME_NAME } from "../state/tree-helpers.js";
import { addCardToNotebook, cardsGridOrigin as gridOrigin } from "./card-transfer.js";
import { publishNotebookCards } from "./card-index.js";

/** The CARDS notebook in container `containerId` (an Inbox or a project;
 *  the active desk's Inbox by default). */
export function findCardsNotebook(state, containerId = state.getInboxId()) {
  const container = findNode(state.fileTree, containerId);
  return (container?.children || []).find((n) => isCardsHome(n) && n.fileId) || null;
}

/** Send a card to the CARDS notebook in `containerId`, making it if it
 *  isn't there. Returns the notebook's name, for the toast. */
export async function sendCardToHome(state, body, meta, containerId = state.getInboxId()) {
  const existing = findCardsNotebook(state, containerId);
  if (existing) {
    await addCardToNotebook(state, existing.fileId, body, meta, { place: "grid", origin: gridOrigin() });
    return existing.name;
  }
  const { makeCardShape, cardIndexOf } = await import("../notebook/card-shape.ts");
  const shape = makeCardShape(body, meta, gridOrigin());
  const envelope = { format: "hushnote", version: 1, shapes: [shape] };
  const made = await state.createNotebook(CARDS_HOME_NAME, containerId, {
    openImmediately: false,
    initialContent: JSON.stringify(envelope),
    cardsHome: true,
  });
  if (!made?.fileId) throw new Error("Couldn't make the CARDS notebook");
  publishNotebookCards(made.fileId, cardIndexOf(envelope.shapes));
  return made.name;
}

/** Courier's Card, and anything else aimed at the Inbox. */
export function sendCardToInbox(state, body, meta, inboxId = state.getInboxId()) {
  return sendCardToHome(state, body, meta, inboxId);
}
