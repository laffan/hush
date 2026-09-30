/**
 * The outlines on a canvas, as a Doc draws them: one DOM outline each —
 * the Doc's own outline editor and footer (`outline/outline-canvas-element.js`),
 * handed over through the `window.__hushOutlines` bridge because the
 * notebook bundle doesn't import app modules — laid over the canvas at
 * the shape's world position and scaled with the zoom. The canvas stops
 * painting outlines while this layer is up (`DrawingState.outlinesAsDom`);
 * exports, rasters and the pocket still paint them (renderer.ts).
 *
 * An outline here is still a text object. The layer lets presses through
 * to the canvas, which selects, drags, groups and resizes it like any
 * shape — except on its checkboxes and footer, which answer directly, as
 * they do in a Doc. What the layer adds:
 *
 *  - a double-click opens the editor with the caret where it landed
 *    (`editing`: the outline takes the pointer until the keyboard leaves
 *    it). Typing, the drag grip, Option-↑/↓, ⌘[ / ⌘] and undo are the
 *    Doc's. Each edit lands on the shape at once, and the pause after a
 *    run of typing records one undo step.
 *  - it measures each outline and records the height on the shape
 *    (`outlineHeight`), so the canvas frames, selects and anchors
 *    arrows to what is on screen.
 *  - a pinned outline is the same element at 1:1, docked to the bottom
 *    of the frame and centred across it, clear of the sidebar / dock and
 *    the shelf, and taking the pointer always — it is a panel, not a
 *    thing on the page — with the Doc pinned panel's grip for its height.
 *
 * Only outlines near the view are built (an editor per outline is not
 * free). The layer sits over the canvas and the ink, under the cards (81)
 * and the bookmark markers (82).
 */

import type { DrawingState } from "../state";
import type { TextShape } from "../types";
import { canvasToScreen } from "../utils";
import { outlineHeight, outlineLayout, outlinePinnedOrigin, OUTLINE_DEFAULT_WIDTH } from "../outline-shape";
import { setOutlineHeights, setOutlineText } from "../outline-edit";

interface OutlineHandle {
  el: HTMLElement;
  getText(): string;
  setText(text: string): void;
  setFlags(flags: { hideDone: boolean; pinned: boolean }): void;
  hasFocus(): boolean;
  focusAt(x?: number, y?: number): void;
  destroy(): void;
}

interface OutlinesBridge {
  createOutlineElement(o: Record<string, unknown>): OutlineHandle;
}

function bridge(): OutlinesBridge | null {
  return (window as unknown as { __hushOutlines?: OutlinesBridge }).__hushOutlines || null;
}

function appState(): unknown {
  return (window as unknown as { __hushState__?: unknown }).__hushState__ || null;
}

/** How far outside the view an outline is still kept built. */
const MARGIN = 400;
const HISTORY_PAUSE_MS = 700;

interface Entry { handle: OutlineHandle; shape: TextShape; recordTimer: ReturnType<typeof setTimeout> | null }

const isOutline = (s: unknown): s is TextShape =>
  !!s && (s as TextShape).type === "text" && !!(s as TextShape).outline;

const widthOf = (s: TextShape) => (s.width && s.width > 0 ? s.width : OUTLINE_DEFAULT_WIDTH);

export function createOutlineLayer(state: DrawingState): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "nb-outline-layer";
  Object.assign(layer.style, {
    position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden", zIndex: "80",
  } as Partial<CSSStyleDeclaration>);

  // Without the bridge (a surface booted without the app) the canvas
  // keeps painting outlines itself.
  if (!bridge() || !appState()) return layer;
  state.outlinesAsDom = true;

  const entries = new Map<string, Entry>();

  // Each outline's height, as its lines lay out, onto its shape —
  // batched to one change per frame. `offsetHeight` is the untransformed
  // box, i.e. world px for an outline on the page.
  const measured = new Map<string, number>();
  let measureFrame = 0;
  const heights = typeof ResizeObserver === "function" ? new ResizeObserver((list) => {
    for (const r of list) {
      const el = r.target as HTMLElement;
      const id = el.dataset.shapeId;
      if (id) measured.set(id, Math.round(el.offsetHeight));
    }
    if (measureFrame || !measured.size) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      const batch = new Map(measured);
      measured.clear();
      setOutlineHeights(state, batch);
    });
  }) : null;

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
    const handle = b.createOutlineElement({
      appState: app,
      text: shape.text,
      hideDone: !!shape.outlineHideDone,
      pinned: !!shape.outlinePin,
      getHostHeight: () => layer.clientHeight,
      onEdit: (text: string) => {
        setOutlineText(state, id, text);
        if (entry.recordTimer) clearTimeout(entry.recordTimer);
        entry.recordTimer = setTimeout(() => { entry.recordTimer = null; state.recordHistory(); }, HISTORY_PAUSE_MS);
      },
      onToggleHideDone: () => { flushHistory(entry); state.toggleOutlineOption(id, "hideDone"); },
      onTogglePin: () => { flushHistory(entry); state.toggleOutlineOption(id, "pin"); },
      onEscape: () => { (document.activeElement as HTMLElement | null)?.blur?.(); },
    });
    handle.el.dataset.shapeId = id;
    handle.el.addEventListener("wheel", (e) => forwardWheel(e, handle.el), { passive: false });
    // Editing ends when the keyboard leaves the outline.
    handle.el.addEventListener("focusout", (e) => {
      if (!handle.el.contains(e.relatedTarget as Node | null)) handle.el.classList.remove("editing");
    });
    heights?.observe(handle.el);
    layer.appendChild(handle.el);
    entry = { handle, shape, recordTimer: null };
    return entry;
  }

  /** The wheel belongs to the outline only while its lines can scroll
   *  that way (a pinned one taller than its panel); otherwise it pans or
   *  zooms the canvas, as it would one pixel to the side. */
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
    const el = e.handle.el;
    const width = widthOf(shape);
    el.style.width = `${width}px`;
    el.style.setProperty("--nb-outline-size", `${shape.fontSize}px`);
    if (shape.outlinePin) {
      // The same origin the canvas used to paint a pinned outline at, now
      // centred — `DrawingState` unpins it to where it is drawn from this.
      const o = outlinePinnedOrigin(
        { width, height: el.offsetHeight || outlineHeight(shape, outlineLayout(shape)) },
        layer.clientWidth, layer.clientHeight,
        { left: state.leftInset, right: state.pocketRightInset },
      );
      el.style.transform = `translate(${Math.round(o.x)}px, ${Math.round(o.y)}px)`;
      return;
    }
    const p = canvasToScreen({ x: shape.position.x, y: shape.position.y }, state.camera);
    const rot = state.camera.rotation || 0;
    el.style.transform = `translate(${p.x}px, ${p.y}px)${rot ? ` rotate(${rot}rad)` : ""} scale(${state.camera.zoom})`;
  }

  function visible(shape: TextShape, hidden: Set<string>): boolean {
    if (shape.pocketed) return false;
    if (shape.layerId && hidden.has(shape.layerId)) return false;
    if (shape.outlinePin) return true;
    const z = state.camera.zoom;
    const p = canvasToScreen({ x: shape.position.x, y: shape.position.y }, state.camera);
    const w = layer.clientWidth || window.innerWidth;
    const h = layer.clientHeight || window.innerHeight;
    const height = outlineHeight(shape, outlineLayout(shape));
    return p.x + widthOf(shape) * z > -MARGIN && p.y + height * z > -MARGIN && p.x < w + MARGIN && p.y < h + MARGIN;
  }

  const sync = () => {
    const t = state.theme;
    layer.style.setProperty("--nb-outline-bg", t.background);
    const hidden = state._hiddenLayerIds();
    const inert = state._inertLayerIds();
    const seen = new Set<string>();
    for (const shape of state.shapes) {
      if (!isOutline(shape)) continue;
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
        if (shape.text !== e.handle.getText()) e.handle.setText(shape.text);
        e.handle.setFlags({ hideDone: !!shape.outlineHideDone, pinned: !!shape.outlinePin });
        e.shape = shape;
      }
      // A locked layer's outline is drawn but out of reach, as its text
      // would be.
      e.handle.el.classList.toggle("inert", !!shape.layerId && inert.has(shape.layerId));
      e.handle.el.classList.toggle("selected", state.selectedIds.has(shape.id));
      place(e, shape);
    }
    for (const [id, e] of entries) {
      if (seen.has(id)) continue;
      if (e.recordTimer) flushHistory(e);
      heights?.unobserve(e.handle.el);
      e.handle.destroy();
      entries.delete(id);
    }
    const want = state.focusOutline;
    if (want) {
      state.focusOutline = null;
      const e = entries.get(want.id);
      if (e) {
        e.handle.el.classList.add("editing");
        requestAnimationFrame(() => e.handle.focusAt(want.x, want.y));
      }
    }
  };

  state.addEventListener("change", sync);
  if (typeof ResizeObserver === "function") new ResizeObserver(sync).observe(layer);
  // A press anywhere on the canvas takes the keyboard back from an
  // outline (the canvas's own handlers keep the focus where it was).
  const releaseFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && layer.contains(a)) a.blur();
  };
  queueMicrotask(() => state.canvasEl?.addEventListener("pointerdown", releaseFocus, true));
  sync();
  return layer;
}
