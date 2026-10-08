/**
 * A canvas's own drag of cards, carried off the canvas.
 *
 * On a canvas a card is a text object: the card layer lets every press
 * through (notebook/ui/card-layer.ts), so the canvas selects, drags,
 * groups and resizes cards the way it does any object. This watches such
 * a drag from the window, ahead of the canvas, and when what is being
 * dragged is all cards it carries them across surfaces the way the
 * header drag does (card-drag.js): off the canvas the cards wait where
 * they left it (the canvas doesn't see the pointer move there) and a
 * ghost of each follows the pointer; let go over a Doc, another canvas or
 * a document / notebook row in the sidebar, they land there and leave
 * this canvas. Let go anywhere else, the canvas finishes its drag as it
 * would have. Let go with ⌘ held, they land as text, in reading order —
 * this canvas included, where they turn into a text shape at the
 * pointer (card-drop.js#landCardsAsText).
 */

import { resolveCardTarget, canvasWorld, landCards, landCardsAsText, dropsAsText } from "./card-drop.js";
import { createDragFeedback } from "./card-drag-feedback.js";
import { canvasReturn } from "./card-return.js";
import { MOVE_THRESHOLD, cardDragActive } from "./card-drag.js";
import { cardBox } from "../notebook/card-geometry.ts";

const isCard = (s) => !!s && s.type === "text" && !!s.card;

/** Watch `state`'s canvas for drags of cards. Idempotent. */
export function watchCanvasCardDrag({ appState, state }) {
  const canvas = state.canvasEl;
  if (!canvas || canvas.__hushCardDragWatch) return;
  canvas.__hushCardDragWatch = true;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || cardDragActive()) return;
    follow(appState, state, e);
  });
}

function follow(appState, state, down) {
  const canvas = state.canvasEl;
  const start = { x: down.clientX, y: down.clientY };
  let decided = false;
  let carry = null;
  const home = (t) => t?.kind === "nb" && t.state === state;

  /** Once the press has travelled: is the canvas dragging cards, and
   *  only cards? (It has handled the press by now.) */
  function decide(e) {
    decided = true;
    if (!state._isDragging) return null;
    const shapes = state.shapes.filter((s) => state.selectedIds.has(s.id));
    if (!shapes.length || !shapes.every(isCard)) return null;
    const w = canvasWorld(state, canvas, e.clientX, e.clientY);
    // The card held: the one under the pointer (the shapes have moved
    // with it so far), else the first.
    const held = shapes.find((s) => {
      const b = cardBox(s);
      return w.x >= b.x && w.x <= b.x + b.width && w.y >= b.y && w.y <= b.y + b.height;
    }) || shapes[0];
    const ordered = [held, ...shapes.filter((s) => s !== held)];
    const cards = ordered.map((s) => ({
      body: s.text,
      meta: { ...(s.cardMeta || {}) },
      dx: s.position.x - held.position.x,
      dy: s.position.y - held.position.y,
    }));
    const grab = { x: w.x - held.position.x, y: w.y - held.position.y };
    const ids = ordered.map((s) => s.id);
    const layer = canvas.parentElement?.querySelector(".nb-card-layer");
    const els = ids.map((id) => layer?.querySelector(`.hush-card[data-shape-id="${CSS.escape(id)}"]`)).filter(Boolean);
    return { cards, grab, ids, feedback: createDragFeedback(cards, grab, els) };
  }

  function stop() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    carry?.feedback.clear();
    document.body.classList.remove("text-drag-active");
  }

  function move(e) {
    if (!decided) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
      carry = decide(e);
      if (!carry) { stop(); return; }
      // Inactive panes take the pointer only while this is on
      // (floating-pane.css) — a card can land in one.
      document.body.classList.add("text-drag-active");
    }
    const t = resolveCardTarget(appState, e.clientX, e.clientY);
    const onHome = home(t);
    const asText = dropsAsText(e);
    carry.feedback.show(t, e.clientX, e.clientY, !onHome || asText, asText);
    if (!onHome) e.stopPropagation();
  }

  function up(e) {
    // Resolved before `stop` takes the inactive panes' pointer away.
    const t = carry ? resolveCardTarget(appState, e.clientX, e.clientY) : null;
    stop();
    if (!carry) return;
    const asText = dropsAsText(e);
    if (!t || (home(t) && !asText)) return;
    // Theirs now: the canvas's drag ends without committing, and the
    // cards leave once they have landed.
    e.stopPropagation();
    state.cancelActiveInteraction();
    const { cards, grab, ids } = carry;
    // Undoing the landing in a Doc puts the cards back here.
    const back = t.kind === "cm" ? canvasReturn(state, ids) : null;
    const landing = asText
      ? landCardsAsText(appState, t, [...cards].sort((a, b) => (a.dy - b.dy) || (a.dx - b.dx)), e.clientX, e.clientY, back)
      : landCards(appState, t, cards, e.clientX, e.clientY, grab, back);
    void landing.then(async (ok) => {
      if (!ok) return;
      const { removeCardShapes } = await import("../notebook/card-shape.ts");
      removeCardShapes(state, ids);
    }).catch(async (err) => {
      console.error("Card drop failed:", err);
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast(err?.message || "The cards couldn't be moved", "error");
    });
  }

  function cancel() { stop(); }

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
}
