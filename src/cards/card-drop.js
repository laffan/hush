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
 *     or the middle of the notebook's view (card-transfer.js);
 *   - an Inbox's or a project's row in the sidebar: that container's
 *     CARDS notebook, made if it isn't there yet (card-courier.js).
 *
 * A card, and the editor inside one, is never a target itself — what it
 * sits on is.
 *
 * **Let go with ⌘ held, a card lands as text** — what its insert-at-
 * cursor button does, at the spot under the pointer instead of the
 * caret: in a Doc its words go in at the character there, on a canvas
 * they become a plain text shape there, and the card itself is gone.
 * (On a sidebar row it is still a card: a row has no spot to put words.)
 */

import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { liveNotebookCanvases } from "../pane/text-drag.js";
import { cardEdit, insideCard } from "./card-facet.js";
import { serializeCard, cardInsertion, withoutPosition, findCardsInDoc } from "./card-model.ts";
import { deliverCardToFile, screenToWorld } from "./card-transfer.js";
import { sendCardToHome } from "./card-courier.js";
import { docPlacement } from "./card-doc-float.js";

/** Whether a release lands cards as text: ⌘ (or Ctrl, or the touch
 *  bar's ⌘ pill) held. */
export function dropsAsText(e) {
  return !!e && (e.metaKey || e.ctrlKey || !!window.__hushCmdHeld);
}

/** Where a card's words would go in a Doc dropped at (x, y): the
 *  character under the pointer, else the nearest one. */
export function textDropPos(view, x, y) {
  const pos = view.posAtCoords({ x, y }) ?? view.posAtCoords({ x, y }, false);
  return pos ?? view.state.selection.main.head;
}

/** The change that puts `text` into a Doc at `pos`, kept off the fence
 *  lines of the cards in it: at a card's edge the words get a line of
 *  their own, as typing there does (card-doc-plugin.js, the boundary
 *  guard — which a `cardEdit` change doesn't pass through). */
export function cardTextInsertion(doc, pos, text) {
  const cards = findCardsInDoc(doc);
  for (const c of cards) if (pos > c.from && pos < c.to) pos = c.to;
  let insert = text;
  for (const c of cards) {
    if (pos === c.from) insert = `${insert}\n`;
    if (pos === c.to) insert = `\n${insert}`;
  }
  return { from: pos, insert };
}

/** What is under the pointer that a card can land on, or null. */
export function resolveCardTarget(appState, x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof Element)) continue;
    // An Inbox's or a project's own row (not the files inside it).
    const home = el.closest("#panel-overlay .sl-item-content")?.parentElement;
    if (home?.dataset.type === "project") return { kind: "home", el: home, containerId: home.dataset.id };
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
  if (target.kind === "row" || target.kind === "home") {
    let name = "";
    for (const c of cards) {
      name = target.kind === "row" ? await deliverCardToFile(appState, target.fileId, c.body, c.meta)
        : await sendCardToHome(appState, c.body, c.meta, target.containerId);
    }
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(cards.length > 1 ? `${cards.length} cards moved to ${name}` : `Card moved to ${name}`, "info");
    return true;
  }
  return false;
}

/**
 * Land `cards` on `target` as text (⌘ held — see above), in the order
 * given, a blank line between two. Over a sidebar row they land as cards
 * after all. Resolves true once they have landed.
 */
export async function landCardsAsText(appState, target, cards, x, y) {
  if (!target || !cards.length) return false;
  const text = cards.map((c) => c.body).join("\n\n");
  if (target.kind === "cm") {
    const view = target.view;
    const { from, insert } = cardTextInsertion(view.state.doc, textDropPos(view, x, y), text);
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from + insert.length },
      annotations: [cardEdit.of(true), Transaction.userEvent.of("input.drop")],
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }
  if (target.kind === "nb") {
    target.state.addTextShapeAtPosition(text, canvasWorld(target.state, target.canvasEl, x, y));
    return true;
  }
  return landCards(appState, target, cards, x, y);
}

/** Land one card ({ body, meta }); see `landCards`. */
export function landCard(appState, target, card, x, y, grab) {
  return landCards(appState, target, [card], x, y, grab);
}

/** Resolve and land in one — a card row let go outside the sidebar;
 *  `asText` lands it as words (⌘ held). */
export async function dropCardAt(appState, card, x, y, asText = false) {
  const target = resolveCardTarget(appState, x, y);
  return asText ? landCardsAsText(appState, target, [card], x, y) : landCard(appState, target, card, x, y);
}
