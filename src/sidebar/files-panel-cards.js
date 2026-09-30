/**
 * Cards in the files sidebar — each document and notebook lists the
 * cards inside it as sub-documents, named by the first three words of
 * the card's first line.
 *
 * Like tab markers and heading rows (files-panel-tabs.js), the rows are
 * synthetic: injected just before SortableList builds the DOM, stripped
 * before any tree write. Unlike them they can be dragged, the way a
 * document can:
 *
 *   - onto a document's or notebook's row: the card moves there — to the
 *     end of the document, or the middle of the notebook's view;
 *   - out of the panel onto an editor or a canvas: it lands under the
 *     pointer (the line boundary in a Doc, the point on a canvas).
 *
 * Either way it leaves the file it was in (cards/card-transfer.js does
 * the reading and writing, live surface first, disk last). A click opens
 * the file at the card.
 *
 * A document's cards are read from its text, like its tab markers. A
 * notebook's come from the per-device index its canvases publish
 * (cards/card-index.js), so they appear once the notebook has been open
 * on this device.
 */

import { findCards, cardTitle } from "../cards/card-model.ts";
import { notebookCards, CARD_INDEX_EVENT } from "../cards/card-index.js";
import { readDocContent, openDocAtTab } from "./files-panel-tabs.js";
import { findNodeByFileId } from "../state/tree-helpers.js";

export function isCardItem(item) {
  return item?.type === "card";
}

function cardRowsFor(state, node) {
  if (node.type === "document" && node.fileId && !node.gutter) {
    return findCards(readDocContent(state, node.fileId)).map((c) => ({
      id: `card:${node.id}:${c.index}`,
      type: "card",
      name: cardTitle(c.body),
      fileId: node.fileId,
      cardRef: { fileId: node.fileId, kind: "doc", index: c.index, body: c.body },
      bgColor: typeof c.meta.bgColor === "string" ? c.meta.bgColor : "",
      children: [],
    }));
  }
  if (node.type === "notebook" && node.fileId) {
    return notebookCards(node.fileId).map((c) => ({
      id: `card:${node.id}:${c.id}`,
      type: "card",
      name: c.title,
      fileId: node.fileId,
      cardRef: { fileId: node.fileId, kind: "nb", shapeId: c.id },
      bgColor: c.bgColor || "",
      children: [],
    }));
  }
  return [];
}

/** Append card rows under every document and notebook. Pure. */
export function augmentTreeWithCards(state, tree) {
  if (!Array.isArray(tree)) return tree;
  return tree.map((node) => augmentNode(state, node));
}

function augmentNode(state, node) {
  if (!node || typeof node !== "object") return node;
  let children = node.children;
  if (Array.isArray(node.children) && node.children.length) {
    children = node.children.map((child) => augmentNode(state, child));
  }
  const rows = cardRowsFor(state, node);
  if (rows.length) return { ...node, children: [...(Array.isArray(children) ? children : []), ...rows] };
  return children !== node.children ? { ...node, children } : node;
}

export function stripCardsFromTree(tree) {
  if (!Array.isArray(tree)) return tree;
  const out = [];
  for (const node of tree) {
    if (isCardItem(node)) continue;
    out.push(Array.isArray(node?.children) && node.children.length
      ? { ...node, children: stripCardsFromTree(node.children) }
      : node);
  }
  return out;
}

export function renderCardRow(item) {
  const row = document.createElement("span");
  row.className = "tree-item-row tree-card-row";
  const icon = document.createElement("span");
  icon.className = "tree-card-icon";
  if (item.bgColor) icon.style.setProperty("--card-accent", item.bgColor);
  const name = document.createElement("span");
  name.className = "tree-item-name tree-card-name";
  name.textContent = item.name || "";
  row.append(icon, name);
  return row;
}

/** Open the card's file with the card in view. */
export async function openCard(state, item) {
  const ref = item.cardRef;
  if (ref.kind === "doc") {
    const cards = findCards(readDocContent(state, ref.fileId));
    const c = cards[ref.index]?.body === ref.body ? cards[ref.index] : cards.find((x) => x.body === ref.body);
    await openDocAtTab(state, ref.fileId, c ? c.from : 0);
    return;
  }
  const { openNotebookAtCard } = await import("../notebook/bookmark-links.js");
  await openNotebookAtCard(state, ref.fileId, ref.shapeId);
}

async function toast(message, kind = "info") {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, kind);
}

/** Move the card a row stands for: read it, land it, then take it out
 *  of where it was — in that order, so a failed landing loses nothing. */
async function moveCard(state, ref, land) {
  const { readCardRef, removeCardRef } = await import("../cards/card-transfer.js");
  const card = await readCardRef(state, ref);
  if (!card) { await toast("That card has moved — try again", "error"); return; }
  await land(card);
  await removeCardRef(state, ref);
}

/** A card row released over a document or notebook row. Returns true
 *  when the drop was the card's (SortableList's `onDropExternal`). */
export function dropCardOnRow(state, item, ev) {
  if (!isCardItem(item)) return false;
  const row = document.elementsFromPoint(ev.clientX, ev.clientY)
    .map((el) => el.closest?.(".sl-item[data-file-id]"))
    .find(Boolean);
  const node = row ? findNodeByFileId(state.fileTree, row.dataset.fileId) : null;
  // Released anywhere else in the panel: the card stays where it is.
  if (!node || (node.type !== "document" && node.type !== "notebook") || node.fileId === item.cardRef.fileId) return true;
  void moveCard(state, item.cardRef, async (card) => {
    const { deliverCardToFile } = await import("../cards/card-transfer.js");
    const name = await deliverCardToFile(state, node.fileId, card.body, card.meta);
    await toast(`Card moved to ${name}`);
  }).catch((e) => toast(e?.message || "The card couldn't be moved", "error"));
  return true;
}

/** A card row dragged out of the panel onto an editor or a canvas. */
export function dropCardOutside(state, item, x, y) {
  void moveCard(state, item.cardRef, async (card) => {
    const { dropCardAt } = await import("../cards/card-drop.js");
    if (!(await dropCardAt(state, card, x, y))) throw new Error("Drop a card on a document or a canvas");
  }).catch((e) => toast(e?.message || "The card couldn't be moved", "error"));
}

/** While a card row is dragged, outline the document / notebook row it
 *  would land in. Returns the stop function. */
export function trackCardRowHover() {
  let hovered = null;
  const move = (e) => {
    const row = document.elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest?.("#panel-overlay .sl-item[data-file-id]:not([data-type='card'])"))
      .find(Boolean) || null;
    if (row === hovered) return;
    hovered?.classList.remove("sl-drop-target-item");
    hovered = row;
    hovered?.classList.add("sl-drop-target-item");
  };
  window.addEventListener("pointermove", move, true);
  return () => {
    window.removeEventListener("pointermove", move, true);
    hovered?.classList.remove("sl-drop-target-item");
  };
}

/** Re-render when a notebook publishes a change to its cards. */
export function onCardIndexChange(fn) {
  window.addEventListener(CARD_INDEX_EVENT, fn);
}
