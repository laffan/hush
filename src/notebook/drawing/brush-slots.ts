/* src/notebook/drawing/brush-slots.ts
 *
 * Slot row + shared flyout, matching the reference demo's model:
 *   - Four slots, each holding a full pen preset.
 *   - Clicking a slot activates it. Clicking an already-active slot
 *     toggles a flyout that edits THAT slot in place.
 *   - Flyout: size / stream / spacing sliders, brush grid, color row
 *     (including "auto" sentinel), pen/highlighter mode toggle.
 *   - Retroactive styling: when a selection is active in drawing
 *     mode, flyout edits restyle the selection too. Slider drags
 *     are wrapped in one style-session-per-drag so undo is whole.
 *   - Auto-close rules: Escape always closes; canvas pointerdown
 *     closes iff no selection is active; clicks on toolbar/HUD/
 *     flyout are ignored.
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import type { DrawingSlot } from "../types";
import { h } from "../ui/dom-helpers";

const SLOT_COUNT = 3;
// Default color sentinels + explicit palette. "auto" resolves to the
// current theme's foreground (text colour) at paint time; "heading"
// resolves to theme.headingColor (the same colour markdown headings
// pick up in the editor). Both retint live when the theme changes.
const COLORS = ["auto", "heading", "#111111", "#e11d48", "#f59e0b", "#16a34a", "#2563eb", "#7c3aed", "#fde047"];
const BRUSH_IDS = ["brush-1", "brush-2", "brush-3", "brush-4", "brush-5", "brush-highlighter"];
const MODES: { id: "normal" | "highlighter"; label: string }[] = [
  { id: "normal", label: "Pen" },
  { id: "highlighter", label: "Highlighter" },
];

export interface BrushSlotsHandle {
  /** The slot-row DOM — goes inline in the tool panel. */
  root: HTMLElement;
  /** The flyout DOM — positioned absolutely; append to the tool
   *  panel's parent so it can escape the toolbar pill. */
  flyout: HTMLElement;
  /** 15-px-thick mini-palette pinned next to the active brush slot.
   *  Carries A / H / red / blue color shortcuts and a draggable size
   *  readout. Hidden when the full brush flyout is open or the user
   *  isn't in pen-draw mode. Append next to `flyout`. */
  miniPalette: HTMLElement;
  /** Force a thumbnail redraw (e.g. after the atlas PNGs land). */
  redrawThumbs: () => void;
}

export function createBrushSlots(
  state: DrawingState,
  drawingLayer: DrawingLayer,
): BrushSlotsHandle {
  const root = h("div", {
    style: { display: "flex", alignItems: "center", gap: "6px" },
  });

  const flyout = h("div", {
    style: {
      position: "absolute",
      display: "none",
      minWidth: "280px",
      maxWidth: "320px",
      padding: "12px 14px",
      borderRadius: "12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
      zIndex: "200",
      backdropFilter: "blur(8px)",
      userSelect: "none",
    },
  });
  flyout.addEventListener("pointerdown", (e) => e.stopPropagation());

  let flyoutOpen = false;

  function closeFlyout() {
    flyoutOpen = false;
    flyout.style.display = "none";
    updateMiniPalette();
  }
  function openFlyout() {
    flyoutOpen = true;
    flyout.style.display = "block";
    applyFlyoutTheme();
    syncFlyoutValues();
    positionFlyout();
    updateMiniPalette();
  }

  document.addEventListener("keydown", (e) => {
    if (flyoutOpen && e.key === "Escape") closeFlyout();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!flyoutOpen) return;
    if (drawingLayer.hasSelection()) return; // keep open for restyling
    const t = e.target as Node;
    if (flyout.contains(t) || root.contains(t)) return;
    // Walk ancestry: clicks in any toolbar / HUD-style chrome leave it open.
    let el: HTMLElement | null = t as HTMLElement;
    while (el && el !== document.body) {
      const cls = el.classList;
      if (cls && (cls.contains("notebook-toolbar") || cls.contains("notebook-tool-panel") ||
                  cls.contains("status-bar") || cls.contains("shelf") ||
                  cls.contains("selection-toolbar"))) return;
      el = el.parentElement;
    }
    closeFlyout();
  });

  // ---------- slot row ----------
  const slotBtns: HTMLButtonElement[] = [];
  const slotThumbs: HTMLCanvasElement[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const thumb = document.createElement("canvas");
    thumb.width = 32; thumb.height = 32;
    Object.assign(thumb.style, {
      width: "32px", height: "32px", display: "block",
    });
    slotThumbs.push(thumb);

    const btn = h("button", {
      title: `Brush ${i + 1}`,
      style: {
        width: "36px", height: "36px", padding: "0",
        border: "none",
        borderRadius: "8px",
        background: "transparent",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.15s",
      },
      children: [thumb],
      onClick: (e) => {
        e.stopPropagation();
        // Tapping a brush slot with a live selection live-restyles
        // every selected stroke to the slot's full config — works
        // whether the user reached the selection via the regular
        // Select tool or the pen-mode lasso, and whether or not the
        // tapped slot is already the active one. Runs ahead of the
        // wasActive flyout-toggle so re-tapping the active slot still
        // imprints its settings on the selection (a no-op if they
        // already match).
        if (drawingLayer.hasSelection()) {
          const before = drawingLayer.snapshotSelectedStyle();
          const slot = state.brushSlots[i];
          drawingLayer.applyStyleToSelection({
            brushId: slot.brushId,
            color: slot.color,
            size: slot.size,
            mode: slot.mode,
          });
          drawingLayer.commitStyleHistory(before);
        }
        const drawingActive = state.tool === "pen";
        const wasActive = drawingActive && state.activeBrushSlot === i && state.drawingSubTool === "draw";
        if (wasActive) {
          // Flyout only opens on a click of the already-active slot.
          if (flyoutOpen) closeFlyout(); else openFlyout();
          return;
        }
        // Picking a brush implicitly engages the drawing engine:
        // drawing-mode used to be a separate "enter pen mode" gesture,
        // but the top toolbar is always visible now, so any brush /
        // erase / slice / lasso click is the entry point.
        if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
        if (state.tool !== "pen") {
          state.tool = "pen";
          state.notify("tool");
          state.notify("drawingMode");
        }
        if (state.drawingSubTool !== "draw") state.setDrawingSubTool("draw");
        state.setActiveBrushSlot(i);
        // Selecting a different brush does NOT open the flyout;
        // the user must click the already-active brush for that.
        if (flyoutOpen) closeFlyout();
      },
    }) as HTMLButtonElement;
    slotBtns.push(btn);
    root.appendChild(btn);
  }

  // ---------- flyout content ----------

  const sizeRow = makeSliderRow("Size", 1, 48, 1, 4);
  const streamRow = makeSliderRow("Stream", 0, 100, 1, 35);
  const spacingRow = makeSliderRow("Spacing", 5, 50, 1, 12);

  const brushGrid = h("div", {
    style: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "4px" },
  });
  const brushCells: { id: string; cell: HTMLButtonElement; canvas: HTMLCanvasElement }[] = [];
  for (const id of BRUSH_IDS) {
    const c = document.createElement("canvas");
    c.width = 36; c.height = 36;
    Object.assign(c.style, { width: "36px", height: "36px", display: "block", borderRadius: "4px", background: "rgba(255,255,255,0.5)" });
    const cell = h("button", {
      title: id,
      style: {
        width: "40px", height: "40px", padding: "0",
        border: "2px solid transparent", borderRadius: "6px",
        background: "rgba(0,0,0,0.03)",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      children: [c],
      onClick: (e) => {
        e.stopPropagation();
        const idx = state.activeBrushSlot;
        const slot = state.brushSlots[idx];
        if (slot.brushId === id) return;
        if (drawingLayer.hasSelection()) {
          const before = drawingLayer.snapshotSelectedStyle();
          drawingLayer.applyStyleToSelection({ brushId: id });
          drawingLayer.commitStyleHistory(before);
        }
        state.updateBrushSlot(idx, { brushId: id });
      },
    }) as HTMLButtonElement;
    brushCells.push({ id, cell, canvas: c });
    brushGrid.appendChild(cell);
  }

  const colorRow = h("div", {
    style: { display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: "4px" },
  });
  const colorBtns: { value: string; btn: HTMLButtonElement }[] = [];
  for (const value of COLORS) {
    const isAuto = value === "auto" || value === "heading";
    const btn = h("button", {
      title: value === "auto"
        ? "Default (text colour, follows theme)"
        : value === "heading"
          ? "Heading colour (follows theme)"
          : value,
      style: {
        width: "24px", height: "24px", padding: "0",
        borderRadius: "50%",
        border: "2px solid transparent",
        cursor: "pointer",
        ...(isAuto
          ? { fontSize: "10px", fontWeight: "700", display: "flex", alignItems: "center", justifyContent: "center" }
          : { background: value }),
      },
      text: value === "auto" ? "A" : value === "heading" ? "H" : undefined,
      onClick: (e) => {
        e.stopPropagation();
        const idx = state.activeBrushSlot;
        const slot = state.brushSlots[idx];
        if (slot.color === value) return;
        if (drawingLayer.hasSelection()) {
          const before = drawingLayer.snapshotSelectedStyle();
          drawingLayer.applyStyleToSelection({ color: value });
          drawingLayer.commitStyleHistory(before);
        }
        state.updateBrushSlot(idx, { color: value });
      },
    }) as HTMLButtonElement;
    colorBtns.push({ value, btn });
    colorRow.appendChild(btn);
  }

  const modeRow = h("div", {
    style: { display: "flex", gap: "6px" },
  });
  const modeBtns: { id: "normal" | "highlighter"; btn: HTMLButtonElement }[] = [];
  for (const m of MODES) {
    const btn = h("button", {
      text: m.label,
      style: {
        flex: "1", padding: "6px 10px",
        border: "1px solid rgba(0,0,0,0.12)", borderRadius: "6px",
        background: "#fff", color: "#333",
        font: "inherit", cursor: "pointer",
      },
      onClick: (e) => {
        e.stopPropagation();
        const idx = state.activeBrushSlot;
        const slot = state.brushSlots[idx];
        if (slot.mode === m.id) return;
        if (drawingLayer.hasSelection()) {
          const before = drawingLayer.snapshotSelectedStyle();
          drawingLayer.applyStyleToSelection({ mode: m.id });
          drawingLayer.commitStyleHistory(before);
        }
        state.updateBrushSlot(idx, { mode: m.id });
      },
    }) as HTMLButtonElement;
    modeBtns.push({ id: m.id, btn });
    modeRow.appendChild(btn);
  }

  flyout.appendChild(section("Pen", [sizeRow.root, streamRow.root, spacingRow.root]));
  flyout.appendChild(section("Brush", [brushGrid]));
  flyout.appendChild(section("Color", [colorRow]));
  flyout.appendChild(section("Mode", [modeRow]));

  // ---------- mini-palette ----------
  // Thin 15-px strip pinned next to the active brush slot. Four color
  // shortcuts (A / H / red / blue) plus a draggable size readout. The
  // strip's long axis runs parallel to the toolbar — horizontal mode →
  // 15 px tall, vertical mode → 15 px wide. Hidden when the full
  // flyout is open or the user isn't on the brush sub-tool.

  const MINI_COLORS: { value: string; label?: string }[] = [
    { value: "auto", label: "A" },
    { value: "heading", label: "H" },
    { value: "#e11d48" },
    { value: "#2563eb" },
  ];

  const miniPalette = h("div", {
    style: {
      position: "absolute",
      display: "none",
      flexDirection: "row",
      zIndex: "150",
      userSelect: "none",
      overflow: "hidden",
      borderRadius: "3px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
    },
  });
  miniPalette.addEventListener("pointerdown", (e) => e.stopPropagation());

  const miniColorBtns: { value: string; el: HTMLButtonElement }[] = [];
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
    miniColorBtns.push({ value: c.value, el });
    miniPalette.appendChild(el);
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
  miniPalette.appendChild(sizeCell);

  // Size cell drag — vertical drag in horizontal mode, horizontal drag
  // in vertical mode. Either way, "outward from the bar's near edge"
  // grows the size. We map drag distance at 4 px / unit so a small
  // gesture nudges by a few units.
  let sizeDragStart: { axis: "x" | "y"; pos: number; value: number; sign: number } | null = null;
  let sizeSessionBeforeMini: ReturnType<DrawingLayer["snapshotSelectedStyle"]> | null = null;
  sizeCell.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const idx = state.activeBrushSlot;
    const value = state.brushSlots[idx].size;
    sizeDragStart = state.drawingToolbarVertical
      ? { axis: "x", pos: e.clientX, value, sign: 1 }
      : { axis: "y", pos: e.clientY, value, sign: -1 };
    if (drawingLayer.hasSelection()) {
      sizeSessionBeforeMini = drawingLayer.snapshotSelectedStyle();
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
    if (sizeSessionBeforeMini) drawingLayer.applyStyleToSelection({ size: v });
  });
  function endSizeDrag(e: PointerEvent) {
    if (!sizeDragStart) return;
    sizeDragStart = null;
    try { sizeCell.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (sizeSessionBeforeMini) {
      drawingLayer.commitStyleHistory(sizeSessionBeforeMini);
      sizeSessionBeforeMini = null;
    }
  }
  sizeCell.addEventListener("pointerup", endSizeDrag);
  sizeCell.addEventListener("pointercancel", endSizeDrag);

  function syncMiniPaletteVisuals(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    const theme = state.theme;
    for (const { value, el } of miniColorBtns) {
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
  }

  function positionMiniPalette(): void {
    const parent = miniPalette.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const activeBtn = slotBtns[state.activeBrushSlot];
    const btnRect = activeBtn.getBoundingClientRect();
    if (btnRect.width === 0) return;
    miniPalette.style.left = "auto";
    miniPalette.style.right = "auto";
    miniPalette.style.top = "auto";
    miniPalette.style.bottom = "auto";
    if (state.drawingToolbarVertical) {
      // 15-px-wide strip running top-to-bottom on the canvas-facing
      // side of the toolbar.
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      miniPalette.style.top = `${centerY}px`;
      miniPalette.style.transform = "translateY(-50%)";
      const btnCenterX = btnRect.left + btnRect.width / 2;
      if (btnCenterX < window.innerWidth / 2) {
        miniPalette.style.left = `${btnRect.right - parentRect.left}px`;
      } else {
        miniPalette.style.right = `${parentRect.right - btnRect.left}px`;
      }
    } else {
      // 15-px-tall strip running left-to-right on the canvas-facing
      // side of the toolbar.
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      miniPalette.style.left = `${centerX}px`;
      miniPalette.style.transform = "translateX(-50%)";
      const btnCenterY = btnRect.top + btnRect.height / 2;
      if (btnCenterY < window.innerHeight / 2) {
        miniPalette.style.top = `${btnRect.bottom - parentRect.top}px`;
      } else {
        miniPalette.style.bottom = `${parentRect.bottom - btnRect.top}px`;
      }
    }
  }

  function updateMiniPalette(): void {
    const live = state.tool === "pen" && state.drawingSubTool === "draw" && !flyoutOpen;
    if (!live) {
      miniPalette.style.display = "none";
      return;
    }
    miniPalette.style.display = "flex";
    miniPalette.style.flexDirection = state.drawingToolbarVertical ? "column" : "row";
    syncMiniPaletteVisuals();
    positionMiniPalette();
  }

  // Slider retroactive styling: session opens on first `input` event
  // of a drag and commits on `change` (fired on pointer release).
  let sizeSessionBefore: ReturnType<DrawingLayer["snapshotSelectedStyle"]> | null = null;
  sizeRow.input.addEventListener("input", () => {
    const v = parseFloat(sizeRow.input.value);
    sizeRow.val.textContent = String(v);
    state.updateBrushSlot(state.activeBrushSlot, { size: v });
    if (drawingLayer.hasSelection()) {
      if (!sizeSessionBefore) sizeSessionBefore = drawingLayer.snapshotSelectedStyle();
      drawingLayer.applyStyleToSelection({ size: v });
    }
  });
  sizeRow.input.addEventListener("change", () => {
    if (sizeSessionBefore) {
      drawingLayer.commitStyleHistory(sizeSessionBefore);
      sizeSessionBefore = null;
    }
  });

  // Stream + spacing are renderer-global options — they don't live
  // per-stroke, so no retroactive session. Change still pushes to the
  // engine via applySlot (the state listener below does that).
  streamRow.input.addEventListener("input", () => {
    const v = parseFloat(streamRow.input.value) / 100;
    streamRow.val.textContent = streamRow.input.value;
    state.updateBrushSlot(state.activeBrushSlot, { streamline: v });
  });
  spacingRow.input.addEventListener("input", () => {
    const v = parseFloat(spacingRow.input.value) / 100;
    spacingRow.val.textContent = spacingRow.input.value;
    state.updateBrushSlot(state.activeBrushSlot, { spacing: v });
  });

  // ---------- syncing ----------

  function applyFlyoutTheme(): void {
    const theme = state.theme;
    flyout.style.background = theme.uiBackground;
    flyout.style.border = `1px solid ${theme.uiBorder}`;
    flyout.style.color = theme.foreground;
  }

  function syncFlyoutValues(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    sizeRow.input.value = String(slot.size);
    sizeRow.val.textContent = String(slot.size);
    streamRow.input.value = String(Math.round(slot.streamline * 100));
    streamRow.val.textContent = String(Math.round(slot.streamline * 100));
    spacingRow.input.value = String(Math.round(slot.spacing * 100));
    spacingRow.val.textContent = String(Math.round(slot.spacing * 100));
    for (const { id, cell } of brushCells) {
      cell.style.borderColor = id === slot.brushId ? state.theme.accent : "transparent";
      cell.style.background = id === slot.brushId ? "rgba(66, 133, 244, 0.08)" : "rgba(0,0,0,0.03)";
    }
    for (const { value, btn } of colorBtns) {
      btn.style.borderColor = value === slot.color ? state.theme.accent : "transparent";
      if (value === "auto") {
        btn.style.background = state.theme.canvasBackground;
        btn.style.color = state.theme.foreground;
      } else if (value === "heading") {
        btn.style.background = state.theme.canvasBackground;
        btn.style.color = state.theme.headingColor;
      }
    }
    for (const { id, btn } of modeBtns) {
      const active = slot.mode === id;
      btn.style.background = active ? state.theme.accent : "#fff";
      btn.style.color = active ? "#fff" : "#333";
      btn.style.borderColor = active ? state.theme.accent : "rgba(0,0,0,0.12)";
    }
    redrawBrushCells();
  }

  function redrawBrushCells(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    for (const { id, canvas } of brushCells) {
      drawingLayer.renderSwatch(canvas, {
        ...slot,
        brushId: id,
        // Cap the size in the cell preview so large sizes don't
        // cover the whole cell.
        size: Math.min(slot.size, 10),
      });
    }
  }

  function redrawThumbs(): void {
    for (let i = 0; i < slotBtns.length; i++) {
      drawingLayer.renderSwatch(slotThumbs[i], state.brushSlots[i]);
      // Active-slot indication is opacity-only — no background tint,
      // so the brush preview PNG reads cleanly against the toolbar.
      // Only highlighted when the drawing engine is actually taking
      // input (state.tool === "pen") AND the sub-tool is Draw.
      // Erase / Slice make the brush selection irrelevant, and
      // outside pen mode nothing in the pill is "live" at all.
      const active = state.tool === "pen" && i === state.activeBrushSlot && state.drawingSubTool === "draw";
      slotBtns[i].style.opacity = active ? "1" : "0.55";
    }
  }

  function positionFlyout(): void {
    const rowRect = root.getBoundingClientRect();
    const parent = flyout.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const activeBtn = slotBtns[state.activeBrushSlot];
    const btnRect = activeBtn.getBoundingClientRect();
    flyout.style.left = "auto";
    flyout.style.right = "auto";
    flyout.style.top = "auto";
    flyout.style.bottom = "auto";
    if (state.drawingToolbarVertical) {
      // Vertical toolbar — flyout flies to the side. Push toward the
      // farther screen edge so it doesn't clip.
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      flyout.style.top = `${centerY}px`;
      flyout.style.transform = "translateY(-50%)";
      const rowCenterX = rowRect.left + rowRect.width / 2;
      if (rowCenterX < window.innerWidth / 2) {
        flyout.style.left = `${rowRect.right - parentRect.left + 8}px`;
      } else {
        flyout.style.right = `${parentRect.right - rowRect.left + 8}px`;
      }
    } else {
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      flyout.style.left = `${centerX}px`;
      flyout.style.transform = "translateX(-50%)";
      const rowCenterY = rowRect.top + rowRect.height / 2;
      if (rowCenterY < window.innerHeight / 2) {
        flyout.style.top = `${rowRect.bottom - parentRect.top + 8}px`;
      } else {
        flyout.style.bottom = `${parentRect.bottom - rowRect.top + 8}px`;
      }
    }
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("activeBrushSlot") || keys.includes("brushSlots") ||
        keys.includes("theme") || keys.includes("drawingSubTool") ||
        keys.includes("tool")) {
      redrawThumbs();
      if (flyoutOpen) { applyFlyoutTheme(); syncFlyoutValues(); }
    }
    // Slot row swaps flex direction with the toolbar's orientation so
    // the brush slots stack vertically in vertical mode.
    if (keys.includes("drawingToolbarVertical")) {
      root.style.flexDirection = state.drawingToolbarVertical ? "column" : "row";
    }
    // Track the toolbar as it's dragged so the open flyout stays anchored
    // to the slot row instead of stranding at the original position.
    if (flyoutOpen && (keys.includes("drawingToolbarOffset") || keys.includes("drawingToolbarVertical"))) {
      positionFlyout();
    }
    if (keys.includes("drawingMode") && !state.drawingMode) closeFlyout();
    // Mini-palette tracks the same state surface as the flyout — slot
    // changes, theme, sub-tool, orientation, drag offset all matter.
    // The rAF pass catches the second-frame layout settle in
    // tool-panel.ts so positionMiniPalette reads the up-to-date btn
    // rect after a drag or orientation flip.
    updateMiniPalette();
    requestAnimationFrame(updateMiniPalette);
  }) as EventListener);

  // Initial draw (and one delayed re-draw for async atlas PNGs).
  redrawThumbs();
  setTimeout(redrawThumbs, 400);
  if (state.drawingToolbarVertical) root.style.flexDirection = "column";
  updateMiniPalette();
  setTimeout(updateMiniPalette, 400);

  return { root, flyout, miniPalette, redrawThumbs };

  // ---------- helpers ----------

  function section(title: string, children: HTMLElement[]): HTMLElement {
    const sec = h("div", { style: { marginBottom: "12px" } });
    const t = h("div", {
      text: title,
      style: { fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", opacity: "0.7", marginBottom: "6px" },
    });
    sec.appendChild(t);
    for (const c of children) sec.appendChild(c);
    return sec;
  }

  function makeSliderRow(label: string, min: number, max: number, step: number, initial: number): {
    root: HTMLElement; input: HTMLInputElement; val: HTMLElement;
  } {
    const row = h("div", {
      style: { display: "grid", gridTemplateColumns: "60px 1fr 32px", alignItems: "center", gap: "8px", marginBottom: "4px" },
    });
    const lbl = h("label", { text: label, style: { fontSize: "12px" } });
    const input = h("input", {
      attrs: { type: "range", min: String(min), max: String(max), step: String(step) },
      style: { width: "100%" },
    }) as HTMLInputElement;
    input.value = String(initial);
    const val = h("span", {
      text: String(initial),
      style: { fontSize: "11px", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: "0.7" },
    });
    row.appendChild(lbl); row.appendChild(input); row.appendChild(val);
    return { root: row, input, val };
  }
}
