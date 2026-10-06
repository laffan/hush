/**
 * Highlight colour picker — click a `==highlight==` in a text shape and a
 * row of swatches opens under the pointer; a pick repaints that one
 * highlight (`TextShape.highlightColors`, keyed by its place among the
 * shape's highlights). The first swatch is the default yellow, which
 * clears the pick. Canvas-only: markdown has no way to carry a highlight's
 * colour, so a shape copied into a Doc comes out in the Doc's yellow.
 *
 * A click, not a press: the shape still selects and drags as before, and
 * the picker waits out the double-click window so a double-click goes
 * into the text instead. Hit-testing uses the boxes the renderer painted
 * (`renderer.ts#highlightRects`), so a highlight in a quote, a task or a
 * list item is found where it actually is.
 */
import type { DrawingState } from "../state";
import type { TextShape } from "../types";
import { highlightRects, highlightWash } from "../renderer";
import { screenToCanvas } from "../utils";
import { h } from "./dom-helpers";

/** The first is the default (it clears the pick). */
const SWATCHES = ["#ffd000", "#34c759", "#2f7fe0", "#ff4fa3", "#ff8a00", "#8e5cf7", "#ff3b30"];
const CLICK_SLOP = 4;
/** Long enough for a second click to make it a double-click. */
const OPEN_DELAY_MS = 260;

export function createHighlightColorPicker(state: DrawingState): HTMLElement {
  const theme = () => state.theme;
  const panel = h("div", {
    cls: "nb-highlight-picker",
    style: {
      position: "absolute", display: "none", gap: "6px", padding: "6px 8px",
      borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", zIndex: "300",
      alignItems: "center", pointerEvents: "auto",
    },
  });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  let target: { id: string; index: number } | null = null;
  let down: { x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function close() {
    panel.style.display = "none";
    target = null;
  }

  function setColor(color: string | null) {
    if (!target) return;
    const { id, index } = target;
    state.shapes = state.shapes.map((s) => {
      if (s.id !== id || s.type !== "text") return s;
      const next = (s.highlightColors || []).slice();
      while (next.length <= index) next.push(null);
      next[index] = color;
      while (next.length && !next[next.length - 1]) next.pop();
      const out: TextShape = { ...s };
      if (next.length) out.highlightColors = next; else delete out.highlightColors;
      return out;
    });
    state.recordHistory();
    state.notify("shapes");
    close();
  }

  function render(current: string | null) {
    const t = theme();
    Object.assign(panel.style, { background: t.uiBackground, border: `1px solid ${t.uiBorder}` });
    panel.replaceChildren();
    SWATCHES.forEach((c, i) => {
      const isDefault = i === 0;
      const on = isDefault ? !current : current?.toLowerCase() === c;
      const sw = h("button", {
        title: isDefault ? "Default" : c,
        attrs: { type: "button", "aria-label": isDefault ? "Default highlight" : `Highlight ${c}` },
        style: {
          width: "18px", height: "18px", borderRadius: "50%", padding: "0", cursor: "pointer",
          background: highlightWash(c), border: `2px solid ${on ? t.accent : "transparent"}`,
          boxShadow: `inset 0 0 0 1px ${c}`,
        },
      });
      sw.addEventListener("click", () => setColor(isDefault ? null : c));
      panel.appendChild(sw);
    });
    // Anything else: the system picker.
    const custom = h("input", { attrs: { type: "color", "aria-label": "Custom highlight colour" } });
    custom.value = current && current.startsWith("#") ? current : SWATCHES[0];
    Object.assign(custom.style, { width: "22px", height: "22px", padding: "0", border: "none", background: "none", cursor: "pointer" });
    custom.addEventListener("change", () => setColor(custom.value));
    panel.appendChild(custom);
  }

  /** The highlight under a canvas point, if any — topmost shape first. */
  function highlightAt(pt: { x: number; y: number }): { shape: TextShape; index: number } | null {
    for (let i = state.shapes.length - 1; i >= 0; i--) {
      const s = state.shapes[i];
      if (s.type !== "text" || s.pocketed) continue;
      const rects = highlightRects.get(s);
      const hit = rects?.find((r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h);
      if (hit) return { shape: s, index: hit.index };
    }
    return null;
  }

  function open(clientX: number, clientY: number) {
    const canvas = state.canvasEl;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const pt = screenToCanvas({ x: clientX - r.left, y: clientY - r.top }, state.camera);
    const hit = highlightAt(pt);
    if (!hit) return;
    target = { id: hit.shape.id, index: hit.index };
    render(hit.shape.highlightColors?.[hit.index] || null);
    panel.style.display = "flex";
    // Under the pointer, kept inside the canvas.
    const host = panel.offsetParent instanceof HTMLElement ? panel.offsetParent.getBoundingClientRect() : r;
    const w = panel.offsetWidth, ph = panel.offsetHeight;
    const left = Math.min(Math.max(4, clientX - host.left - w / 2), host.width - w - 4);
    const top = Math.min(clientY - host.top + 14, host.height - ph - 4);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function cancelPending() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const attach = () => {
    const canvas = state.canvasEl;
    if (!canvas) return false;
    canvas.addEventListener("pointerdown", (e) => {
      cancelPending();
      close();
      down = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey ? { x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener("click", (e) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP) return;
      if (state.tool !== "select" || state.editingText) return;
      const { clientX, clientY } = e;
      timer = setTimeout(() => {
        timer = null;
        if (state.tool === "select" && !state.editingText) open(clientX, clientY);
      }, OPEN_DELAY_MS);
    });
    canvas.addEventListener("dblclick", cancelPending);
    return true;
  };
  // The canvas element lands on the state after the overlay layers are built.
  if (!attach()) {
    const wait = setInterval(() => { if (attach()) clearInterval(wait); }, 50);
  }

  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && target) close(); });
  state.addEventListener("change", (ev) => {
    const keys: string[] = (ev as CustomEvent).detail?.keys || [];
    if (!target) return;
    if (keys.includes("camera") || keys.includes("editingText") || keys.includes("tool")) close();
    else if (keys.includes("shapes") && !state.shapes.some((s) => s.id === target!.id)) close();
  });

  return panel;
}
