/**
 * The cards on a canvas: one DOM card each — the very component a Doc
 * shows (`cards/card-element.js`), handed over through the
 * `window.__hushCards` bridge because the notebook bundle doesn't import
 * app modules — laid over the canvas at the card's world position and
 * scaled with the zoom, so a card is a thing on the page rather than a
 * label over it.
 *
 * A card here is a text object. The layer lets every press through to
 * the canvas, which selects, drags, groups and resizes cards the way it
 * does any shape (width only: a card is as tall as its words — the
 * layer measures each card and records the height on the shape so the
 * canvas frames it true). What the layer adds:
 *
 *  - a double-click opens the card's editor (`editing`: the card takes
 *    the pointer until the keyboard leaves it); each edit lands on the
 *    shape at once, and the pause after a run of typing records one
 *    undo step. A double-click on the header strip folds it instead.
 *  - the header's buttons (colour, insert-at-cursor, delete) answer
 *    while the card is selected
 *  - a drag of cards carried off the canvas lands them on whatever it
 *    is let go over (`cards/card-canvas-drag.js`); while editing, the
 *    header is the handle for the same thing (`cards/card-drag.js`)
 *
 * Only cards near the view are built (an editor per card is not free).
 * The layer sits over the canvas and the ink, under the bookmark markers
 * (82), the toolbar and shelf band and floating panes.
 */

import type { DrawingState } from "../state";
import type { TextShape } from "../types";
import { canvasToScreen } from "../utils";
import {
  cardIndexOf, cardMetaOf, hasNonCardShapes, isCardShape, patchCardShape, removeCardShape, setCardHeights, uncardShape,
} from "../card-shape";
import { cardBox } from "../card-geometry";
import type { CardMeta } from "../../cards/card-model";

interface CardHandle {
  el: HTMLElement;
  getBody(): string;
  setBody(text: string): void;
  setMeta(meta: CardMeta): void;
  setSelected(on: boolean): void;
  hasFocus(): boolean;
  focus(atEnd?: boolean): void;
  destroy(): void;
}

interface CardsBridge {
  createCardElement(o: Record<string, unknown>): CardHandle;
  startCardDrag(o: Record<string, unknown>): void;
  watchCanvasCardDrag?(o: Record<string, unknown>): void;
  insertAtRememberedCursor(text: string, back?: unknown): boolean;
  canvasReturn?(state: DrawingState, ids: string[]): unknown;
  publishNotebookCards(fileId: string, cards: { id: string; title: string; bgColor?: string }[], o?: { otherContent?: boolean }): void;
}

function bridge(): CardsBridge | null {
  return (window as unknown as { __hushCards?: CardsBridge }).__hushCards || null;
}

function appState(): unknown {
  return (window as unknown as { __hushState__?: unknown }).__hushState__ || null;
}

/** How far outside the view a card is still kept built. */
const MARGIN = 400;
const HISTORY_PAUSE_MS = 700;

interface Entry { handle: CardHandle; shape: TextShape; metaKey: string; recordTimer: ReturnType<typeof setTimeout> | null }

export function createCardLayer(state: DrawingState): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "nb-card-layer";
  Object.assign(layer.style, {
    position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "81",
  } as Partial<CSSStyleDeclaration>);

  const entries = new Map<string, Entry>();

  // Each card's height, as its words lay out, onto its shape — batched
  // to one change per frame.
  const measured = new Map<string, number>();
  let measureFrame = 0;
  const heights = typeof ResizeObserver === "function" ? new ResizeObserver((list) => {
    for (const r of list) {
      const el = r.target as HTMLElement;
      const id = el.dataset.shapeId;
      if (id && !el.classList.contains("collapsed")) measured.set(id, Math.round(el.offsetHeight));
    }
    if (measureFrame || !measured.size) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      const batch = new Map(measured);
      measured.clear();
      setCardHeights(state, batch);
    });
  }) : null;

  const current = (id: string): TextShape | null => {
    const s = state.shapes.find((x) => x.id === id);
    return isCardShape(s) ? s : null;
  };

  function flushHistory(e: Entry) {
    if (!e.recordTimer) return;
    clearTimeout(e.recordTimer);
    e.recordTimer = null;
    state.recordHistory();
  }

  function build(shape: TextShape): Entry | null {
    const b = bridge();
    const app = appState();
    if (!b || !app) return null;
    const id = shape.id;
    let entry: Entry;
    const handle = b.createCardElement({
      appState: app,
      body: shape.text,
      meta: shape.cardMeta || {},
      surface: "nb",
      getScale: () => state.camera.zoom,
      onEdit: (update: { state: { doc: { toString(): string } } }) => {
        patchCardShape(state, id, { text: update.state.doc.toString() }, false);
        if (entry.recordTimer) clearTimeout(entry.recordTimer);
        entry.recordTimer = setTimeout(() => { entry.recordTimer = null; state.recordHistory(); }, HISTORY_PAUSE_MS);
      },
      onEscape: () => { (document.activeElement as HTMLElement | null)?.blur?.(); },
      onAction: (action: string, _e: Event, arg: unknown) => {
        const s = current(id);
        if (!s) return;
        flushHistory(entry);
        const meta = { ...(s.cardMeta || {}) } as CardMeta;
        if (action === "color") patchCardShape(state, id, { cardMeta: { ...meta, bgColor: (arg as string) || undefined } });
        else if (action === "collapse") patchCardShape(state, id, { cardMeta: { ...meta, collapsed: !meta.collapsed } });
        else if (action === "delete") removeCardShape(state, id);
        else if (action === "insert") {
          // Into the document the keyboard was last in, if one is on
          // screen — undoing it there puts the card back here (cards/
          // card-return.js); with none, the card turns back into text in
          // place.
          if (b.insertAtRememberedCursor(s.text, b.canvasReturn?.(state, [id]))) removeCardShape(state, id);
          else uncardShape(state, id);
        }
      },
      onResize: (width: number) => {
        const s = current(id);
        if (s) patchCardShape(state, id, { cardMeta: { ...(s.cardMeta || {}), width } as CardMeta });
      },
      onHeaderDown: (e: PointerEvent) => {
        const s = current(id);
        if (!s) return;
        flushHistory(entry);
        b.startCardDrag({
          appState: app,
          body: s.text,
          meta: cardMetaOf(s),
          initialEvent: e,
          source: { kind: "nb", state, shapeId: id, element: handle.el },
        });
      },
    });
    handle.el.dataset.shapeId = id;
    handle.el.addEventListener("wheel", (e) => forwardWheel(e, handle.el), { passive: false });
    // Editing ends when the keyboard leaves the card.
    handle.el.addEventListener("focusout", (e) => {
      if (!handle.el.contains(e.relatedTarget as Node | null)) handle.el.classList.remove("editing");
    });
    heights?.observe(handle.el);
    layer.appendChild(handle.el);
    entry = { handle, shape, metaKey: JSON.stringify(shape.cardMeta || {}), recordTimer: null };
    return entry;
  }

  /** The wheel belongs to the card only while its text can scroll that
   *  way; otherwise it pans or zooms the canvas, as it would one pixel
   *  to the side of the card. */
  function forwardWheel(e: WheelEvent, el: HTMLElement) {
    const sc = el.querySelector(".cm-scroller") as HTMLElement | null;
    if (sc && !e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      const room = e.deltaY > 0 ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : sc.scrollTop;
      if (room > 1) return;
    }
    const canvas = state.canvasEl;
    if (!canvas) return;
    e.preventDefault();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
      clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
      bubbles: true, cancelable: true,
    }));
  }

  function place(e: Entry, shape: TextShape) {
    const box = cardBox(shape);
    const p = canvasToScreen({ x: box.x, y: box.y }, state.camera);
    const rot = state.camera.rotation || 0;
    e.handle.el.style.transform = `translate(${p.x}px, ${p.y}px)${rot ? ` rotate(${rot}rad)` : ""} scale(${state.camera.zoom})`;
  }

  function visible(shape: TextShape, hidden: Set<string>): boolean {
    if (shape.pocketed) return false;
    if (shape.layerId && hidden.has(shape.layerId)) return false;
    const box = cardBox(shape);
    const z = state.camera.zoom;
    const p = canvasToScreen({ x: box.x, y: box.y }, state.camera);
    const w = layer.clientWidth || window.innerWidth;
    const h = layer.clientHeight || window.innerHeight;
    return p.x + box.width * z > -MARGIN && p.y + box.height * z > -MARGIN && p.x < w + MARGIN && p.y < h + MARGIN;
  }

  let lastIndexKey = "";
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  function publishIndex() {
    if (indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = null;
      const fileId = state.hostFileId;
      const b = bridge();
      if (!fileId || !b) return;
      const index = cardIndexOf(state.shapes);
      const key = JSON.stringify(index);
      if (key === lastIndexKey) return;
      lastIndexKey = key;
      b.publishNotebookCards(fileId, index, { otherContent: hasNonCardShapes(state.shapes) });
    }, 300);
  }

  let lastShapes: unknown = null;
  let watching = false;
  const sync = () => {
    if (!watching && state.canvasEl) {
      const b = bridge();
      const app = appState();
      if (b?.watchCanvasCardDrag && app) { b.watchCanvasCardDrag({ appState: app, state }); watching = true; }
    }
    const t = state.theme;
    layer.style.setProperty("--card-base", t.background);
    layer.style.setProperty("--card-fg", t.foreground);
    const hidden = state._hiddenLayerIds();
    const seen = new Set<string>();
    for (const shape of state.shapes) {
      if (!isCardShape(shape)) continue;
      let e = entries.get(shape.id);
      const show = visible(shape, hidden);
      if (!show && !(e && e.handle.hasFocus())) continue;
      seen.add(shape.id);
      if (!e) {
        const built = build(shape);
        if (!built) continue;
        e = built;
        entries.set(shape.id, e);
      }
      if (e.shape !== shape) {
        if (shape.text !== e.handle.getBody()) e.handle.setBody(shape.text);
        const metaKey = JSON.stringify(shape.cardMeta || {});
        if (metaKey !== e.metaKey) { e.metaKey = metaKey; e.handle.setMeta((shape.cardMeta || {}) as CardMeta); }
        e.shape = shape;
      }
      e.handle.setSelected(state.selectedIds.has(shape.id));
      place(e, shape);
    }
    for (const [id, e] of entries) {
      if (seen.has(id)) continue;
      if (e.recordTimer) flushHistory(e);
      heights?.unobserve(e.handle.el);
      e.handle.destroy();
      entries.delete(id);
    }
    if (state.focusCardId) {
      const e = entries.get(state.focusCardId);
      state.focusCardId = null;
      if (e) {
        e.handle.el.classList.add("editing");
        requestAnimationFrame(() => e.handle.focus());
      }
    }
    if (state.shapes !== lastShapes) { lastShapes = state.shapes; publishIndex(); }
  };

  state.addEventListener("change", sync);
  if (typeof ResizeObserver === "function") new ResizeObserver(sync).observe(layer);
  // A press anywhere on the canvas takes the keyboard back from a card
  // (the canvas's own handlers keep the focus where it was).
  const releaseFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && layer.contains(a)) a.blur();
  };
  queueMicrotask(() => state.canvasEl?.addEventListener("pointerdown", releaseFocus, true));
  sync();
  return layer;
}
