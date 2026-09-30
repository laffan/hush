/**
 * Dragging a card by its header — within a surface and across them.
 *
 * **On a canvas** the card moves like any other object: pressing the
 * header selects it (keeping a selection it was already part of) and the
 * whole selection travels with the pointer through `DrawingState`'s
 * external-move API, one undo step for the drag.
 *
 * **In a Doc** the text can't be seen to move, so the UI masks it: the
 * card lifts off as a ghost; over the text a line shows the boundary it
 * will land on in the flow, and over the margin the ghost is where it
 * will float (card-doc-float.js#docPlacement). The release moves the
 * card's markdown to its new place — or its new anchor line — in one
 * transaction (one undo step).
 *
 * **Across surfaces** the hand-off is seamless in both directions, the
 * way a ⌘-drag of selected text is: the moment the pointer leaves the
 * canvas a card came from (or the Doc), the ghost takes over; back over
 * its own canvas it is the card again. Released over another Doc, a
 * canvas, or a document / notebook row in the sidebar, the card lands
 * there and leaves where it was — a Doc takes it in the flow or in its
 * margin as above, a canvas at the pointer, a sidebar row at the end of
 * the document or the middle of the notebook's view. Escape cancels.
 */

import { Transaction } from "@codemirror/state";
import { cardGhost } from "./card-element.js";
import { cardEdit } from "./card-facet.js";
import { serializeCard } from "./card-model.ts";
import { resolveCardTarget, canvasWorld, landCard } from "./card-drop.js";
import { docPlacement } from "./card-doc-float.js";

const MOVE_THRESHOLD = 4;
let active = null;

/**
 * @param {object} o
 * @param {object} o.appState
 * @param {string} o.body
 * @param {object} o.meta
 * @param {PointerEvent} o.initialEvent
 * @param {{kind:"doc", view, wrap, locate} | {kind:"nb", state, shapeId, element}} o.source
 */
export function startCardDrag({ appState, body, meta, initialEvent, source }) {
  if (active) return;
  const cardEl = source.kind === "doc" ? source.wrap.querySelector(".hush-card") : source.element;
  if (!cardEl) return;
  const rect = cardEl.getBoundingClientRect();
  const scale = source.kind === "nb" ? source.state.camera.zoom || 1 : 1;
  // Where on the card the pointer took hold, in the card's own pixels,
  // so the card lands with that spot under the pointer.
  const grab = { x: (initialEvent.clientX - rect.left) / scale, y: (initialEvent.clientY - rect.top) / scale };
  const start = { x: initialEvent.clientX, y: initialEvent.clientY };
  const src = source.kind === "nb" ? source.state : null;
  const srcCanvas = src?.canvasEl || null;
  const startWorld = src && srcCanvas ? canvasWorld(src, srcCanvas, start.x, start.y) : null;

  let moved = false;
  let ghost = null;
  let dropLine = null;
  let hoverRow = null;
  let target = null;
  let liveMoving = false;
  const sourceBox = source.kind === "doc" ? source.wrap : cardEl;

  function setGhost(on, x, y) {
    if (on && !ghost) {
      ghost = cardGhost(body, meta);
      document.documentElement.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.display = on ? "" : "none";
      if (on) ghost.style.transform = `translate(${x - grab.x}px, ${y - grab.y}px)`;
    }
    sourceBox.classList.toggle("dragging-source", on);
  }

  function setDropLine(view, point) {
    if (!view) { dropLine?.remove(); dropLine = null; return; }
    if (!dropLine) {
      dropLine = document.createElement("div");
      dropLine.className = "hush-card-drop-line";
      document.body.appendChild(dropLine);
    }
    const r = view.contentDOM.getBoundingClientRect();
    Object.assign(dropLine.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${point.lineY - 1}px` });
  }

  function setHoverRow(row) {
    if (row === hoverRow) return;
    hoverRow?.classList.remove("sl-drop-target-item");
    hoverRow = row;
    hoverRow?.classList.add("sl-drop-target-item");
  }

  function track(x, y) {
    target = resolveCardTarget(appState, x, y);
    const overOwnCanvas = !!src && target?.kind === "nb" && target.state === src;
    if (src && startWorld) {
      if (overOwnCanvas) {
        const w = canvasWorld(src, srcCanvas, x, y);
        src.updateExternalMove(w.x - startWorld.x, w.y - startWorld.y);
      } else {
        // Off its canvas the card waits where it was; the ghost goes on.
        src.updateExternalMove(0, 0);
      }
    }
    setGhost(!overOwnCanvas, x, y);
    // Over a Doc's text the line shows where the card goes into the flow;
    // over its margin the ghost already shows where it will float.
    const place = target?.kind === "cm" ? docPlacement(target.view, x, y, grab, meta) : null;
    setDropLine(place && !place.float ? target.view : null, place);
    setHoverRow(target?.kind === "row" ? target.el : null);
  }

  function begin() {
    moved = true;
    document.body.classList.add("text-drag-active");
    if (src) {
      if (!src.selectedIds.has(source.shapeId)) {
        src.selectedIds = new Set([source.shapeId]);
        src.notify("selectedIds");
      }
      src.beginExternalMove();
      liveMoving = true;
    }
  }

  function onMove(e) {
    if (!moved) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
      begin();
    }
    e.preventDefault();
    track(e.clientX, e.clientY);
  }

  function cleanup() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    ghost?.remove();
    setDropLine(null);
    setHoverRow(null);
    sourceBox.classList.remove("dragging-source");
    document.body.classList.remove("text-drag-active");
    active = null;
  }

  function cancel() {
    if (liveMoving) src.endExternalMove(true);
    cleanup();
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  }

  function onCancel() { cancel(); }

  function onUp(e) {
    if (!moved) { cleanup(); return; }
    track(e.clientX, e.clientY);
    const t = target;
    const place = t?.kind === "cm" ? docPlacement(t.view, e.clientX, e.clientY, grab, meta) : null;
    const overOwnCanvas = !!src && t?.kind === "nb" && t.state === src;
    if (liveMoving) src.endExternalMove(!overOwnCanvas);
    cleanup();
    if (!t || overOwnCanvas) return;
    if (source.kind === "doc" && t.kind === "cm" && t.view === source.view) {
      moveWithinDoc(source, place);
      return;
    }
    void landCard(appState, t, { body, meta }, e.clientX, e.clientY, grab).then((ok) => { if (ok) removeFromSource(); }).catch(async (err) => {
      console.error("Card drop failed:", err);
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast(err?.message || "The card couldn't be moved", "error");
    });
  }

  function removeFromSource() {
    if (source.kind === "nb") {
      void import("../notebook/card-shape.ts").then(({ removeCardShape }) => removeCardShape(source.state, source.shapeId));
      return;
    }
    const span = source.locate();
    if (!span) return;
    const doc = source.view.state.doc;
    const range = span.to < doc.length ? { from: span.from, to: span.to + 1 }
      : { from: Math.max(0, span.from - 1), to: span.to };
    source.view.dispatch({
      changes: { ...range, insert: "" },
      annotations: [cardEdit.of(true), Transaction.userEvent.of("delete.card")],
    });
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  active = { cancel };
}

/** A card dropped elsewhere in its own Doc: its markdown moves to the
 *  new place — in the flow, or anchored beside the line it now floats by
 *  — in one transaction. */
function moveWithinDoc(source, place) {
  const view = source.view;
  const span = source.locate();
  if (!span || !place) return;
  const doc = view.state.doc;
  const removal = span.to < doc.length ? { from: span.from, to: span.to + 1 }
    : { from: Math.max(0, span.from - 1), to: span.to };
  const text = serializeCard(span.body, place.meta);
  const annotations = [cardEdit.of(true), Transaction.userEvent.of("move.card")];
  if (place.pos >= removal.from && place.pos <= removal.to) {
    // Same anchor: only how it sits changes (a new offset, or in / out of
    // the flow).
    if (text !== doc.sliceString(span.from, span.to)) {
      view.dispatch({ changes: { from: span.from, to: span.to, insert: text }, annotations });
    }
    return;
  }
  view.dispatch({
    changes: [{ from: place.pos, insert: place.before ? `${text}\n` : `\n${text}` }, { ...removal, insert: "" }],
    annotations,
  });
}
