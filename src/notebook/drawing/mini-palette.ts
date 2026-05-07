/* src/notebook/drawing/mini-palette.ts
 *
 * Thin (15 px thick) strip pinned next to the active brush slot on
 * the toolbar's canvas-facing edge — opposite the nearest screen
 * edge so it never sits "outside" the writing surface. Carries three
 * color shortcuts (A / H / Red) and a draggable size readout
 * (number; press-and-drag changes the value). Hidden when the full
 * brush flyout is open or the user isn't on the brush sub-tool.
 *
 * The strip's long axis runs parallel to the toolbar — horizontal
 * mode → 15 px tall, vertical mode → 15 px wide. The corner touching
 * the toolbar paints square; the canvas-side corners stay rounded so
 * the strip reads as an extension of the bar rather than a
 * free-floating pill. Anchors against the drawing pill's outer rect
 * (not the brush button) so it doesn't sit inside the pill's padding.
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import { h } from "../ui/dom-helpers";

const MINI_COLORS: { value: string; label?: string }[] = [
  { value: "auto", label: "A" },
  { value: "heading", label: "H" },
  { value: "#e11d48" },
];

export interface MiniPaletteHandle {
  /** The strip's root DOM. Append next to the brush flyout in the
   *  drawing pill's flyout group. */
  root: HTMLElement;
  /** Re-render and re-position the strip. Callers fire this on every
   *  state change that might affect visibility or position
   *  (active slot, theme, drawing sub-tool, orientation, drag offset,
   *  flyout open / close). */
  update: () => void;
}

export function createMiniPalette(opts: {
  state: DrawingState;
  drawingLayer: DrawingLayer;
  /** Live array of slot buttons keyed by `state.activeBrushSlot`. */
  slotBtns: HTMLButtonElement[];
  /** Returns true when the full brush flyout is open — the mini-palette
   *  hides for the duration so the two don't compete for the user's
   *  attention. */
  isFlyoutOpen: () => boolean;
}): MiniPaletteHandle {
  const { state, drawingLayer, slotBtns, isFlyoutOpen } = opts;

  const root = h("div", {
    style: {
      position: "absolute",
      display: "none",
      flexDirection: "row",
      zIndex: "150",
      userSelect: "none",
      overflow: "hidden",
      boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
    },
  });
  root.addEventListener("pointerdown", (e) => e.stopPropagation());

  const colorBtns: { value: string; el: HTMLButtonElement }[] = [];
  for (const c of MINI_COLORS) {
    const el = h("button", {
      title: c.value === "auto"
        ? "Default (text colour)"
        : c.value === "heading"
          ? "Heading colour"
          : c.value,
      style: {
        width: "15px",
        height: "15px",
        flex: "0 0 15px",
        border: "none",
        cursor: "pointer",
        padding: "0",
        margin: "0",
        font: "700 9px/1 system-ui, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      },
      text: c.label,
      onClick: (e) => {
        e.stopPropagation();
        const idx = state.activeBrushSlot;
        const slot = state.brushSlots[idx];
        if (slot.color === c.value) return;
        if (drawingLayer.hasSelection()) {
          const before = drawingLayer.snapshotSelectedStyle();
          drawingLayer.applyStyleToSelection({ color: c.value });
          drawingLayer.commitStyleHistory(before);
        }
        state.updateBrushSlot(idx, { color: c.value });
      },
    }) as HTMLButtonElement;
    colorBtns.push({ value: c.value, el });
    root.appendChild(el);
  }

  const sizeCell = h("div", {
    style: {
      width: "22px",
      height: "15px",
      flex: "0 0 22px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      font: "600 9px/1 system-ui, sans-serif",
      fontVariantNumeric: "tabular-nums",
      cursor: "ns-resize",
      touchAction: "none",
      boxSizing: "border-box",
    },
  }) as HTMLElement;
  root.appendChild(sizeCell);

  // Size cell drag — vertical drag in horizontal mode, horizontal drag
  // in vertical mode. Either way, "outward from the bar's near edge"
  // grows the size. We map drag distance at 4 px / unit so a small
  // gesture nudges by a few units.
  let sizeDragStart: { axis: "x" | "y"; pos: number; value: number; sign: number } | null = null;
  let sizeSessionBefore: ReturnType<DrawingLayer["snapshotSelectedStyle"]> | null = null;
  sizeCell.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const idx = state.activeBrushSlot;
    const value = state.brushSlots[idx].size;
    sizeDragStart = state.drawingToolbarVertical
      ? { axis: "x", pos: e.clientX, value, sign: 1 }
      : { axis: "y", pos: e.clientY, value, sign: -1 };
    if (drawingLayer.hasSelection()) {
      sizeSessionBefore = drawingLayer.snapshotSelectedStyle();
    }
    try { sizeCell.setPointerCapture(e.pointerId); } catch { /* noop */ }
    e.preventDefault();
  });
  sizeCell.addEventListener("pointermove", (e) => {
    if (!sizeDragStart) return;
    const cur = sizeDragStart.axis === "y" ? e.clientY : e.clientX;
    const delta = (cur - sizeDragStart.pos) * sizeDragStart.sign;
    const v = Math.max(1, Math.min(48, Math.round(sizeDragStart.value + delta / 4)));
    const idx = state.activeBrushSlot;
    if (state.brushSlots[idx].size === v) return;
    state.updateBrushSlot(idx, { size: v });
    if (sizeSessionBefore) drawingLayer.applyStyleToSelection({ size: v });
  });
  function endSizeDrag(e: PointerEvent) {
    if (!sizeDragStart) return;
    sizeDragStart = null;
    try { sizeCell.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (sizeSessionBefore) {
      drawingLayer.commitStyleHistory(sizeSessionBefore);
      sizeSessionBefore = null;
    }
  }
  sizeCell.addEventListener("pointerup", endSizeDrag);
  sizeCell.addEventListener("pointercancel", endSizeDrag);

  /** Pick the strip's anchor side. The strip sits on the toolbar's
   *  *canvas-facing* side — opposite the nearest screen edge — so it
   *  never blocks the writing surface from above (or wherever the
   *  user has dragged the bar). */
  function attachSide(btnRect: DOMRect): "above" | "below" | "left" | "right" {
    if (state.drawingToolbarVertical) {
      const cx = btnRect.left + btnRect.width / 2;
      return cx < window.innerWidth / 2 ? "right" : "left";
    }
    const cy = btnRect.top + btnRect.height / 2;
    return cy < window.innerHeight / 2 ? "below" : "above";
  }

  function syncVisuals(side: "above" | "below" | "left" | "right"): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    const theme = state.theme;
    for (const { value, el } of colorBtns) {
      if (value === "auto") {
        el.style.background = theme.canvasBackground;
        el.style.color = theme.foreground;
      } else if (value === "heading") {
        el.style.background = theme.canvasBackground;
        el.style.color = theme.headingColor;
      } else {
        el.style.background = value;
        el.style.color = "transparent";
      }
      const active = slot.color === value;
      el.style.boxShadow = active ? `inset 0 0 0 2px ${theme.accent}` : "none";
    }
    sizeCell.textContent = String(slot.size);
    sizeCell.style.background = theme.uiBackground;
    sizeCell.style.color = theme.foreground;
    // Square the corners on the bar-touching edge; round the outside.
    const r = "3px";
    if (side === "below") root.style.borderRadius = `0 0 ${r} ${r}`;
    else if (side === "above") root.style.borderRadius = `${r} ${r} 0 0`;
    else if (side === "right") root.style.borderRadius = `0 ${r} ${r} 0`;
    else root.style.borderRadius = `${r} 0 0 ${r}`;
  }

  function position(side: "above" | "below" | "left" | "right"): void {
    const parent = root.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const activeBtn = slotBtns[state.activeBrushSlot];
    const btnRect = activeBtn.getBoundingClientRect();
    if (btnRect.width === 0) return;
    // Touch the *drawing pill's* edge, not the button's — the pill's
    // padding wraps every button, so anchoring to the button would
    // park the strip inside that padding (overlapping the bar).
    const pill = activeBtn.closest(".notebook-tool-panel") as HTMLElement | null;
    const pillRect = pill ? pill.getBoundingClientRect() : btnRect;
    root.style.left = "auto";
    root.style.right = "auto";
    root.style.top = "auto";
    root.style.bottom = "auto";
    if (state.drawingToolbarVertical) {
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      root.style.top = `${centerY}px`;
      root.style.transform = "translateY(-50%)";
      if (side === "right") {
        root.style.left = `${pillRect.right - parentRect.left}px`;
      } else {
        root.style.right = `${parentRect.right - pillRect.left}px`;
      }
    } else {
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      root.style.left = `${centerX}px`;
      root.style.transform = "translateX(-50%)";
      if (side === "below") {
        root.style.top = `${pillRect.bottom - parentRect.top}px`;
      } else {
        root.style.bottom = `${parentRect.bottom - pillRect.top}px`;
      }
    }
  }

  function update(): void {
    const live = state.tool === "pen" && state.drawingSubTool === "draw" && !isFlyoutOpen();
    if (!live) {
      root.style.display = "none";
      return;
    }
    root.style.display = "flex";
    root.style.flexDirection = state.drawingToolbarVertical ? "column" : "row";
    const activeBtn = slotBtns[state.activeBrushSlot];
    const btnRect = activeBtn.getBoundingClientRect();
    if (btnRect.width === 0) {
      // Slot button hasn't been laid out yet — try again next frame.
      requestAnimationFrame(update);
      return;
    }
    const side = attachSide(btnRect);
    syncVisuals(side);
    position(side);
  }

  return { root, update };
}
