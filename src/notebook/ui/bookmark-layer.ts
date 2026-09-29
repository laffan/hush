/**
 * The bookmarks on the canvas: one DOM marker each — the ribbon in the
 * bookmark's colour and its name beside it, in the app's UI font — laid
 * over the canvas at the bookmark's world point. The markers keep their
 * screen size at any zoom (a marker is a label, not ink) and stay upright
 * when the canvas is rotated.
 *
 *  - drag a marker to move the bookmark (one undo step per drag)
 *  - click the ribbon: the shared colour palette, with Copy link and
 *    Delete under it
 *  - click the name: rename it in place
 *  - ⌘-drag either: a `[Name](hush-nb://…)` link, into a Doc
 *
 * The layer sits above the canvas and the ink but under the toolbar,
 * shelf and floating panes. It passes every pointer through except on
 * the markers themselves.
 */

import type { DrawingState } from "../state";
import type { NotebookBookmark } from "../types";
import { canvasToScreen, screenToCanvas } from "../utils";
import {
  bookmarkGlyph, openBookmarkColorPalette, startBookmarkLinkDrag,
} from "../../ui/bookmark-ui.js";
import { bookmarkLinkText, deleteBookmark, updateBookmark } from "../bookmarks";
import { writeClipboardText } from "../canvas-paste";

const DRAG_SLOP_2 = 16;
/** Half the ribbon's box: the marker is placed so the ribbon's centre is
 *  the bookmark's point. */
const ICON = 18;

interface Marker { el: HTMLElement; icon: HTMLElement; label: HTMLElement; bm: NotebookBookmark; renaming: boolean }

function cmdHeld(e: PointerEvent): boolean {
  return e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
}

export function createBookmarkLayer(state: DrawingState): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "nb-bookmark-layer";
  Object.assign(layer.style, {
    position: "absolute", inset: "0", pointerEvents: "none", overflow: "hidden",
    // Over the canvas and the drawing wrapper (no z-index of their own),
    // under the toolbar / shelf band (85–88) and floating panes (90).
    zIndex: "82",
  } as Partial<CSSStyleDeclaration>);

  const markers = new Map<string, Marker>();

  function place(m: Marker): void {
    const p = canvasToScreen({ x: m.bm.x, y: m.bm.y }, state.camera);
    const w = layer.clientWidth || 99999, hgt = layer.clientHeight || 99999;
    const off = p.x < -300 || p.y < -40 || p.x > w + 40 || p.y > hgt + 40;
    m.el.style.display = off ? "none" : "";
    if (!off) m.el.style.transform = `translate(${Math.round(p.x - ICON / 2)}px, ${Math.round(p.y - ICON / 2)}px)`;
  }

  function paint(m: Marker): void {
    m.icon.innerHTML = bookmarkGlyph(m.bm.color, ICON);
    if (!m.renaming) m.label.textContent = m.bm.name || "Bookmark";
    m.el.title = m.bm.name || "Bookmark";
  }

  function rename(m: Marker): void {
    if (m.renaming) return;
    m.renaming = true;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "nb-bookmark-input";
    input.value = m.bm.name || "";
    input.spellcheck = false;
    m.label.textContent = "";
    m.label.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      m.renaming = false;
      const next = input.value.trim();
      input.remove();
      if (commit && next && next !== m.bm.name) updateBookmark(state, m.bm.id, { name: next });
      else paint(m);
    };
    // Keys stay in the field — the canvas's shortcuts (tools, delete)
    // must not hear a name being typed.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));
  }

  function openPalette(m: Marker): void {
    const link = bookmarkLinkText(state, m.bm);
    openBookmarkColorPalette({
      anchor: m.icon,
      color: m.bm.color,
      onPick: (color) => updateBookmark(state, m.bm.id, { color }),
      actions: [
        ...(link ? [{ label: "Copy link", run: () => { void writeClipboardText(link); } }] : []),
        { label: "Delete", danger: true, run: () => deleteBookmark(state, m.bm.id) },
      ],
    });
  }

  function wire(m: Marker): void {
    m.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || m.renaming) return;
      // The canvas must not start a selection, a pan or a stroke under a
      // marker, and the press must not move the focus.
      e.stopPropagation();
      e.preventDefault();
      if (cmdHeld(e)) {
        const link = bookmarkLinkText(state, m.bm);
        if (link) void startBookmarkLinkDrag(link, e);
        return;
      }
      const onLabel = m.label.contains(e.target as Node);
      const start = { x: e.clientX, y: e.clientY };
      const startBm = { x: m.bm.x, y: m.bm.y };
      let dragging = false;
      try { m.el.setPointerCapture(e.pointerId); } catch { /* detached */ }
      const move = (me: PointerEvent) => {
        const dx = me.clientX - start.x, dy = me.clientY - start.y;
        if (!dragging && dx * dx + dy * dy < DRAG_SLOP_2) return;
        dragging = true;
        m.el.classList.add("dragging");
        // Screen delta → world delta through the camera, rotation and all.
        const o = screenToCanvas({ x: 0, y: 0 }, state.camera);
        const q = screenToCanvas({ x: dx, y: dy }, state.camera);
        updateBookmark(state, m.bm.id, { x: startBm.x + q.x - o.x, y: startBm.y + q.y - o.y }, false);
      };
      const up = (ue: PointerEvent) => {
        m.el.removeEventListener("pointermove", move);
        m.el.removeEventListener("pointerup", up);
        m.el.removeEventListener("pointercancel", cancel);
        m.el.classList.remove("dragging");
        if (dragging) { state.recordHistory(); return; }
        if (ue.type === "pointercancel") return;
        if (onLabel) rename(m);
        else openPalette(m);
      };
      const cancel = (ce: PointerEvent) => up(ce);
      m.el.addEventListener("pointermove", move);
      m.el.addEventListener("pointerup", up);
      // iOS ends a claimed touch with pointercancel; a drag it
      // interrupted is kept, not dropped.
      m.el.addEventListener("pointercancel", cancel);
    });
    // WebKit still sends mousedown after a cancelled pointerdown — keep
    // it from widening a text selection underneath.
    m.el.addEventListener("mousedown", (e) => { if (!m.renaming) e.preventDefault(); });
  }

  function build(bm: NotebookBookmark): Marker {
    const el = document.createElement("div");
    el.className = "nb-bookmark";
    const icon = document.createElement("span");
    icon.className = "nb-bookmark-icon";
    const label = document.createElement("span");
    label.className = "nb-bookmark-label";
    el.append(icon, label);
    const m: Marker = { el, icon, label, bm, renaming: false };
    wire(m);
    layer.appendChild(el);
    return m;
  }

  let lastList: NotebookBookmark[] | null = null;
  const sync = () => {
    const t = state.theme;
    layer.style.setProperty("--nb-bm-fg", t.foreground);
    layer.style.setProperty("--nb-bm-bg", t.uiBackground);
    layer.style.setProperty("--nb-bm-border", t.uiBorder);
    if (state.bookmarks !== lastList) {
      lastList = state.bookmarks;
      const seen = new Set<string>();
      for (const bm of state.bookmarks) {
        seen.add(bm.id);
        let m = markers.get(bm.id);
        if (!m) { m = build(bm); markers.set(bm.id, m); }
        const changed = m.bm !== bm;
        m.bm = bm;
        if (changed || !m.icon.firstChild) paint(m);
      }
      for (const [id, m] of markers) {
        if (!seen.has(id)) { m.el.remove(); markers.delete(id); }
      }
    }
    for (const m of markers.values()) place(m);
    // A fresh stamp opens its name for typing.
    if (state.renamingBookmarkId) {
      const m = markers.get(state.renamingBookmarkId);
      state.renamingBookmarkId = null;
      if (m) requestAnimationFrame(() => rename(m));
    }
    // A jump to a bookmark (list, shelf, link) pulses its marker once.
    if (state.flashBookmarkId) {
      const m = markers.get(state.flashBookmarkId);
      state.flashBookmarkId = null;
      if (m) {
        m.el.classList.remove("flash");
        void m.el.offsetWidth;
        m.el.classList.add("flash");
      }
    }
  };
  state.addEventListener("change", sync);
  if (typeof ResizeObserver === "function") new ResizeObserver(sync).observe(layer);
  sync();
  return layer;
}
