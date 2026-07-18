/* src/notebook/drawing/mini-palette.ts
 *
 * Thin (15 px thick) strip pinned next to the active brush slot on
 * the toolbar's canvas-facing edge — opposite the nearest screen
 * edge so it never sits "outside" the writing surface. Carries three
 * color shortcuts (A / H / Red) and a draggable size readout
 * (number; press-and-drag changes the value). Hidden when the full
 * brush flyout is open or the user isn't on the brush sub-tool.
 *
 * Two satellite popups hang off the strip (both siblings of the strip
 * in the flyout group, since the strip itself clips via overflow:
 * hidden):
 *   - Tapping the color square that is ALREADY selected opens a
 *     secondary color selector on the strip's canvas-facing side —
 *     the full pen palette as 14 px circle swatches, same style as
 *     the text color picker rows.
 *   - While the size number is being dragged, a live preview stroke
 *     floats beside the number (to its right) showing the brush at
 *     its current true size; it disappears on release.
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
import { PEN_COLORS } from "../types";
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
        if (slot.color === c.value) {
          // Re-tapping the selected square opens the secondary color
          // selector (full pen palette, circle swatches) beneath it.
          if (colorFlyoutOpen) closeColorFlyout(); else openColorFlyout(el);
          return;
        }
        closeColorFlyout();
        applyColor(c.value);
      },
    }) as HTMLButtonElement;
    colorBtns.push({ value: c.value, el });
    root.appendChild(el);
  }

  /** Shared color application — retroactively restyles a live
   *  selection (one undo entry) and updates the active slot. */
  function applyColor(value: string): void {
    const idx = state.activeBrushSlot;
    if (state.brushSlots[idx].color === value) return;
    if (drawingLayer.hasSelection()) {
      const before = drawingLayer.snapshotSelectedStyle();
      drawingLayer.applyStyleToSelection({ color: value });
      drawingLayer.commitStyleHistory(before);
    }
    state.updateBrushSlot(idx, { color: value });
  }

  // ---------- secondary color flyout ----------
  // Circle swatches matching the text color picker's row style
  // (14 px circles, A / H sentinels lettered in the theme colours).
  // A sibling of the strip — the strip's overflow: hidden would clip
  // anything nested inside it — mounted lazily into the flyout group.
  let colorFlyoutOpen = false;
  const colorFlyout = h("div", {
    style: {
      position: "absolute",
      display: "none",
      alignItems: "center",
      gap: "6px",
      padding: "8px 10px",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      zIndex: "200",
      userSelect: "none",
    },
  });
  colorFlyout.addEventListener("pointerdown", (e) => e.stopPropagation());
  const flyoutSwatches: { value: string; el: HTMLButtonElement }[] = [];
  for (const value of PEN_COLORS) {
    const isSentinel = value === "auto" || value === "heading";
    const sw = h("button", {
      title: value === "auto"
        ? "Default (text colour, follows theme)"
        : value === "heading"
          ? "Heading colour (follows theme)"
          : value,
      style: {
        width: "14px", height: "14px", padding: "0",
        borderRadius: "50%",
        border: "1px solid #ccc",
        cursor: "pointer",
        flex: "0 0 14px",
        ...(isSentinel
          ? { display: "flex", alignItems: "center", justifyContent: "center", font: "700 8px/1 system-ui, sans-serif" }
          : { background: value }),
      },
      text: value === "auto" ? "A" : value === "heading" ? "H" : undefined,
      onClick: (e) => {
        e.stopPropagation();
        applyColor(value);
        closeColorFlyout();
      },
    }) as HTMLButtonElement;
    flyoutSwatches.push({ value, el: sw });
    colorFlyout.appendChild(sw);
  }

  function syncColorFlyout(): void {
    const theme = state.theme;
    const slot = state.brushSlots[state.activeBrushSlot];
    colorFlyout.style.background = theme.uiBackground;
    colorFlyout.style.border = `1px solid ${theme.uiBorder}`;
    for (const { value, el } of flyoutSwatches) {
      if (value === "auto") {
        el.style.background = theme.foreground;
        el.style.color = theme.variant === "dark" ? "#000" : "#fff";
      } else if (value === "heading") {
        el.style.background = theme.headingColor;
        el.style.color = theme.variant === "dark" ? "#000" : "#fff";
      }
      el.style.boxShadow = slot.color === value ? `0 0 0 2px ${theme.accent}` : "none";
    }
  }

  function openColorFlyout(anchorSquare: HTMLElement): void {
    const parent = root.parentElement;
    if (!parent) return;
    if (!colorFlyout.parentElement) parent.appendChild(colorFlyout);
    colorFlyoutOpen = true;
    colorFlyout.style.display = "flex";
    syncColorFlyout();
    // Sit on the strip's canvas-facing side, centered on the tapped
    // square — "beneath it" relative to wherever the strip attaches.
    const parentRect = parent.getBoundingClientRect();
    const stripRect = root.getBoundingClientRect();
    const sqRect = anchorSquare.getBoundingClientRect();
    const side = attachSide(sqRect);
    colorFlyout.style.left = "auto";
    colorFlyout.style.right = "auto";
    colorFlyout.style.top = "auto";
    colorFlyout.style.bottom = "auto";
    colorFlyout.style.transform = "none";
    if (side === "below" || side === "above") {
      colorFlyout.style.left = `${sqRect.left + sqRect.width / 2 - parentRect.left}px`;
      colorFlyout.style.transform = "translateX(-50%)";
      if (side === "below") colorFlyout.style.top = `${stripRect.bottom - parentRect.top + 4}px`;
      else colorFlyout.style.bottom = `${parentRect.bottom - stripRect.top + 4}px`;
    } else {
      colorFlyout.style.top = `${sqRect.top + sqRect.height / 2 - parentRect.top}px`;
      colorFlyout.style.transform = "translateY(-50%)";
      if (side === "right") colorFlyout.style.left = `${stripRect.right - parentRect.left + 4}px`;
      else colorFlyout.style.right = `${parentRect.right - stripRect.left + 4}px`;
    }
  }

  function closeColorFlyout(): void {
    if (!colorFlyoutOpen) return;
    colorFlyoutOpen = false;
    colorFlyout.style.display = "none";
  }

  document.addEventListener("pointerdown", (e) => {
    if (!colorFlyoutOpen) return;
    const t = e.target as Node;
    if (colorFlyout.contains(t) || root.contains(t)) return;
    closeColorFlyout();
  });
  document.addEventListener("keydown", (e) => {
    if (colorFlyoutOpen && e.key === "Escape") closeColorFlyout();
  });

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

  // Live size preview — floats beside the number (to its right) for
  // the duration of a size drag, showing a short demo stroke at the
  // brush's current TRUE pixel size (renderDemoStroke only caps at
  // the canvas height, and 56 px of headroom clears the 48 px max).
  // A sibling of the strip for the same overflow reason as the
  // secondary color flyout; mounted lazily on first drag.
  const sizePreviewCanvas = document.createElement("canvas");
  Object.assign(sizePreviewCanvas.style, {
    width: "72px", height: "56px", display: "block", borderRadius: "6px",
  });
  const sizePreview = h("div", {
    style: {
      position: "absolute",
      display: "none",
      padding: "2px",
      borderRadius: "8px",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      zIndex: "200",
      pointerEvents: "none",
    },
    children: [sizePreviewCanvas],
  });

  function redrawSizePreview(): void {
    drawingLayer.renderDemoStroke(sizePreviewCanvas, state.brushSlots[state.activeBrushSlot]);
  }

  function showSizePreview(): void {
    const parent = root.parentElement;
    if (!parent) return;
    if (!sizePreview.parentElement) parent.appendChild(sizePreview);
    const theme = state.theme;
    sizePreview.style.background = theme.uiBackground;
    sizePreview.style.border = `1px solid ${theme.uiBorder}`;
    // The demo canvas tints to the canvas background so the stroke
    // reads exactly as it would on the writing surface.
    sizePreviewCanvas.style.background = theme.canvasBackground;
    sizePreview.style.display = "block";
    // To the right of the number, vertically centered on it; flip to
    // the strip's left when the right edge would leave the window.
    const parentRect = parent.getBoundingClientRect();
    const cellRect = sizeCell.getBoundingClientRect();
    const stripRect = root.getBoundingClientRect();
    sizePreview.style.left = "auto";
    sizePreview.style.right = "auto";
    sizePreview.style.top = `${cellRect.top + cellRect.height / 2 - parentRect.top}px`;
    sizePreview.style.transform = "translateY(-50%)";
    if (cellRect.right + 8 + 80 <= window.innerWidth) {
      sizePreview.style.left = `${cellRect.right - parentRect.left + 8}px`;
    } else {
      sizePreview.style.right = `${parentRect.right - stripRect.left + 8}px`;
    }
    redrawSizePreview();
  }

  function hideSizePreview(): void {
    sizePreview.style.display = "none";
  }

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
    showSizePreview();
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
    redrawSizePreview();
  });
  function endSizeDrag(e: PointerEvent) {
    if (!sizeDragStart) return;
    sizeDragStart = null;
    try { sizeCell.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (sizeSessionBefore) {
      drawingLayer.commitStyleHistory(sizeSessionBefore);
      sizeSessionBefore = null;
    }
    hideSizePreview();
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
      closeColorFlyout();
      hideSizePreview();
      return;
    }
    if (colorFlyoutOpen) syncColorFlyout();
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
