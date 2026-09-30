/**
 * Where a card lands when it is let go at a screen point — shared by the
 * header drag (card-drag.js) and a card row dragged out of the sidebar
 * (sidebar/files-panel-cards.js).
 *
 *   - a Doc (any editor surface — main, pane, stack column, Zen): over
 *     the text, beside the line under the pointer; over the margin,
 *     where it was let go (card-doc-float.js#docPlacement);
 *   - a canvas: the pointer, with the spot the card was held by under it;
 *   - a document or notebook row in the sidebar: the end of the document
 *     or the middle of the notebook's view (card-transfer.js).
 *
 * A card, and the editor inside one, is never a target itself — what it
 * sits on is.
 */

import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { liveNotebookCanvases } from "../pane/text-drag.js";
import { cardEdit, insideCard } from "./card-facet.js";
import { serializeCard, cardInsertion, withoutPosition } from "./card-model.ts";
import { deliverCardToFile, screenToWorld } from "./card-transfer.js";
import { docPlacement } from "./card-doc-float.js";

/** What is under the pointer that a card can land on, or null. */
export function resolveCardTarget(appState, x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof Element)) continue;
    const row = el.closest("#panel-overlay .sl-item[data-file-id]");
    if (row) {
      const node = findNodeByFileId(appState.fileTree, row.dataset.fileId);
      if (node && (node.type === "document" || node.type === "notebook")) {
        return { kind: "row", el: row, fileId: node.fileId, type: node.type, name: node.name };
      }
      return null;
    }
    if (el.closest("#panel-overlay")) return null;
    for (const entry of liveNotebookCanvases()) {
      if (entry.canvasEl === el || entry.canvasEl.contains(el)) return { kind: "nb", canvasEl: entry.canvasEl, state: entry.state };
    }
    if (el.closest(".hush-card")) continue;
    const cm = el.closest(".cm-editor");
    if (cm) {
      const view = EditorView.findFromDOM(cm);
      if (view && !view.state.facet(insideCard)) return { kind: "cm", view };
    }
  }
  return null;
}

export function canvasWorld(nbState, canvasEl, x, y) {
  const r = canvasEl.getBoundingClientRect();
  return screenToWorld(nbState.camera, x - r.left, y - r.top);
}

/**
 * Land `cards` ({ body, meta, dx?, dy? }, the first the one held, the
 * rest placed from it) on `target` at screen point (x, y). `grab` is
 * where on the held card the pointer is, in card pixels. Resolves true
 * once they have landed.
 */
export async function landCards(appState, target, cards, x, y, grab = { x: 16, y: 12 }) {
  if (!target || !cards.length) return false;
  if (target.kind === "cm") {
    // All beside the one line, where the held card goes; the float layer
    // stacks them.
    const place = docPlacement(target.view, x, y, grab, cards[0].meta);
    const at = { xPos: place.meta.xPos, yPos: place.meta.yPos };
    const text = cards.map((c) => serializeCard(c.body, { ...withoutPosition(c.meta), ...at })).join("\n");
    target.view.dispatch({
      changes: cardInsertion(target.view.state.doc, place.pos, text),
      annotations: [cardEdit.of(true), Transaction.userEvent.of("move.card")],
    });
    return true;
  }
  if (target.kind === "nb") {
    const { addCardShape } = await import("../notebook/card-shape.ts");
    const s = target.state;
    const w = canvasWorld(s, target.canvasEl, x, y);
    const ids = cards.map((c) => addCardShape(s, c.body, c.meta, {
      x: w.x - grab.x + (c.dx || 0), y: w.y - grab.y + (c.dy || 0),
    }, { select: false }).id);
    s.selectedIds = new Set(ids);
    s.notify("selectedIds");
    return true;
  }
  if (target.kind === "row") {
    let name = "";
    for (const c of cards) name = await deliverCardToFile(appState, target.fileId, c.body, c.meta);
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(cards.length > 1 ? `${cards.length} cards moved to ${name}` : `Card moved to ${name}`, "info");
    return true;
  }
  return false;
}

/** Land one card ({ body, meta }); see `landCards`. */
export function landCard(appState, target, card, x, y, grab) {
  return landCards(appState, target, [card], x, y, grab);
}

/** Resolve and land in one — a card row let go outside the sidebar. */
export async function dropCardAt(appState, card, x, y) {
  return landCard(appState, resolveCardTarget(appState, x, y), card, x, y);
}
