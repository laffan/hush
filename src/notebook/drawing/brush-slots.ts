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
import { PEN_COLORS } from "../types";
import { h } from "../ui/dom-helpers";
import { createMiniPalette } from "./mini-palette";
import {
  ensureFlyoutSliderStyle, ensureBrushFlyoutStyle, applyFlyoutSliderTheme, accentTint,
  STRAIGHT_LINE_ICON,
} from "./flyout-styles";

// Color sentinels + explicit palette (PEN_COLORS in types.ts — shared
// with the mini-palette's secondary selector). "auto" resolves to the
// current theme's foreground (text colour) at paint time; "heading"
// resolves to theme.headingColor (the same colour markdown headings
// pick up in the editor). Both retint live when the theme changes.
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
  ensureFlyoutSliderStyle();
  ensureBrushFlyoutStyle();
  const root = h("div", {
    style: { display: "flex", alignItems: "center", gap: "6px" },
  });

  const flyout = h("div", {
    style: {
      position: "absolute",
      display: "none",
      minWidth: "280px",
      maxWidth: "320px",
      padding: "14px",
      borderRadius: "12px",
      boxShadow: "0 10px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)",
      zIndex: "200",
      backdropFilter: "blur(8px)",
      userSelect: "none",
    },
  });
  flyout.classList.add("notebook-brush-flyout");
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
  // Thumb canvases are 26 px (down from 32) so the slim 1-px-padded
  // toolbar still has room for a centered preview without bleeding
  // into the rounded button corners. Buttons stay at 36 px so the
  // tap target hasn't shrunk.
  const slotBtns: HTMLButtonElement[] = [];
  const slotThumbs: HTMLCanvasElement[] = [];
  // One button per state slot (4 by default — pen ×3 + highlighter).
  for (let i = 0; i < state.brushSlots.length; i++) {
    const thumb = document.createElement("canvas");
    thumb.width = 26; thumb.height = 26;
    Object.assign(thumb.style, {
      width: "26px", height: "26px", display: "block",
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
    style: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "6px", justifyItems: "center" },
  });
  const brushCells: { id: string; cell: HTMLButtonElement; canvas: HTMLCanvasElement }[] = [];
  for (const id of BRUSH_IDS) {
    const c = document.createElement("canvas");
    c.width = 36; c.height = 36;
    Object.assign(c.style, { width: "36px", height: "36px", display: "block", borderRadius: "6px", pointerEvents: "none" });
    const cell = h("button", {
      title: id === "brush-highlighter" ? "Highlighter" : `Brush ${id.replace("brush-", "")}`,
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
    cell.classList.add("nbf-cell");
    brushCells.push({ id, cell, canvas: c });
    brushGrid.appendChild(cell);
  }

  const colorRow = h("div", {
    style: { display: "grid", gridTemplateColumns: "repeat(9, 1fr)", justifyItems: "center", rowGap: "6px" },
  });
  const colorBtns: { value: string; btn: HTMLButtonElement }[] = [];
  for (const value of PEN_COLORS) {
    const isAuto = value === "auto" || value === "heading";
    const btn = h("button", {
      title: value === "auto"
        ? "Default (text colour, follows theme)"
        : value === "heading"
          ? "Heading colour (follows theme)"
          : value,
      style: isAuto ? {} : { background: value },
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
    btn.classList.add("nbf-swatch");
    colorBtns.push({ value, btn });
    colorRow.appendChild(btn);
  }

  // Mode — a two-segment control rather than two free-floating
  // buttons; the active segment fills with the theme accent (same
  // treatment as the bg-settings pattern buttons).
  const modeRow = h("div");
  modeRow.classList.add("nbf-mode");
  const modeBtns: { id: "normal" | "highlighter"; btn: HTMLButtonElement }[] = [];
  for (const m of MODES) {
    const btn = h("button", {
      text: m.label,
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
    btn.classList.add("nbf-seg");
    modeBtns.push({ id: m.id, btn });
    modeRow.appendChild(btn);
  }

  // Blend Stroke — highlighter only. Multiply is right over a printed
  // page (a proof) and wrong on a dark canvas, where it swallows light
  // ink, so which one you get is a switch rather than a rule. A slot the
  // user has never touched inherits the notebook's answer
  // (`resolveSlotBlend`); ticking the box makes it explicit and the
  // notebook stops deciding. Like every other control here except
  // straight-line capture, it also restyles a live selection.
  const blendInput = h("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  const blendRow = h("label", {
    cls: "nbf-check",
    title: "Composite the highlight against what's under it, so text shows through",
    children: [blendInput, "Blend Stroke"],
  });
  blendRow.addEventListener("pointerdown", (e) => e.stopPropagation());
  blendInput.addEventListener("change", () => {
    const idx = state.activeBrushSlot;
    const on = blendInput.checked;
    if (drawingLayer.hasSelection()) {
      const before = drawingLayer.snapshotSelectedStyle();
      drawingLayer.applyStyleToSelection({ blend: on });
      drawingLayer.commitStyleHistory(before);
    }
    state.updateBrushSlot(idx, { blend: on });
  });

  // Line — freehand vs. ruled. Same two-segment control as Mode, since
  // it's the same shape of choice: how the stroke follows the pointer.
  // Per slot, so one brush can be the ruler while the rest stay
  // freehand. Straight mode carries the dot-in-circle glyph the
  // mini-palette's toggle uses, so the two read as one control.
  const lineRow = h("div");
  lineRow.classList.add("nbf-mode");
  const lineBtns: { straight: boolean; btn: HTMLButtonElement }[] = [];
  for (const opt of [{ straight: false, label: "Freehand" }, { straight: true, label: "Straight" }]) {
    const btn = h("button", {
      title: opt.straight
        ? "Straight line — the stroke runs from where you press to where you lift"
        : "Freehand — the stroke follows the pointer",
      onClick: (e) => {
        e.stopPropagation();
        const idx = state.activeBrushSlot;
        if (!!state.brushSlots[idx].straightLine === opt.straight) return;
        // Straight-line mode governs how a stroke is *captured*, so
        // there's nothing retroactive to apply — an existing stroke's
        // points are already recorded. Unlike every other control here,
        // it deliberately leaves a live selection alone.
        state.updateBrushSlot(idx, { straightLine: opt.straight });
      },
    }) as HTMLButtonElement;
    btn.classList.add("nbf-seg");
    if (opt.straight) {
      const glyph = h("span");
      glyph.classList.add("nbf-seg-icon");
      glyph.innerHTML = STRAIGHT_LINE_ICON;
      btn.appendChild(glyph);
    }
    btn.appendChild(document.createTextNode(opt.label));
    lineBtns.push({ straight: opt.straight, btn });
    lineRow.appendChild(btn);
  }

  // Demo stroke replaces the "Pen" section header — a live preview of
  // the active slot's brush, color, size, and spacing so the user can
  // see what they're configuring.
  const demoStroke = document.createElement("canvas");
  Object.assign(demoStroke.style, {
    width: "100%", height: "48px", display: "block",
    marginBottom: "12px", borderRadius: "8px",
  });
  flyout.appendChild(demoStroke);
  flyout.appendChild(section(null, [sizeRow.root, streamRow.root, spacingRow.root]));
  flyout.appendChild(divider());
  flyout.appendChild(section("Brush", [brushGrid]));
  flyout.appendChild(divider());
  flyout.appendChild(section("Color", [colorRow]));
  flyout.appendChild(divider());
  flyout.appendChild(section("Mode", [modeRow, blendRow]));
  flyout.appendChild(divider());
  flyout.appendChild(section("Line", [lineRow]));

  function redrawDemoStroke(): void {
    if (!flyoutOpen) return;
    if (demoStroke.clientWidth === 0) {
      // Flyout was just shown — clientWidth resolves on the next
      // layout pass. Retry once a frame is on the books.
      requestAnimationFrame(redrawDemoStroke);
      return;
    }
    drawingLayer.renderDemoStroke(demoStroke, state.brushSlots[state.activeBrushSlot]);
  }

  // ---------- mini-palette ----------
  // Lives in src/notebook/drawing/mini-palette.ts. The thin 15-px
  // strip sits on the toolbar's outside edge and shows A / H / Red
  // color shortcuts plus a draggable size readout for the active
  // brush. We pass the slot button list and a flyout-state probe so
  // it can hide while the full flyout is open.
  const mini = createMiniPalette({
    state,
    drawingLayer,
    slotBtns,
    isFlyoutOpen: () => flyoutOpen,
  });
  const miniPalette = mini.root;
  const updateMiniPalette = mini.update;

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
    const dark = theme.variant === "dark";
    flyout.style.background = theme.uiBackground;
    flyout.style.border = `1px solid ${theme.uiBorder}`;
    flyout.style.color = theme.foreground;
    // Theme surface for the component classes in flyout-styles.ts —
    // every `--nbf-*` reference in the injected sheet resolves against
    // these, so a theme switch restyles the panel in one place.
    flyout.style.setProperty("--nbf-border", theme.uiBorder);
    flyout.style.setProperty("--nbf-accent", theme.accent);
    flyout.style.setProperty("--nbf-panel", theme.uiBackground);
    flyout.style.setProperty("--nbf-canvas", theme.canvasBackground);
    flyout.style.setProperty("--nbf-subtle", dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.045)");
    flyout.style.setProperty("--nbf-swatch-edge", dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.12)");
    flyout.style.setProperty("--nbf-accent-tint", accentTint(theme.accent, 0.12));
    // Tint the demo canvas to match the canvas background so the
    // stroke reads exactly as it would on the real surface.
    demoStroke.style.background = theme.canvasBackground;
    demoStroke.style.border = `1px solid ${theme.uiBorder}`;
    applyFlyoutSliderTheme(sizeRow.input, theme.accent, theme.variant);
    applyFlyoutSliderTheme(streamRow.input, theme.accent, theme.variant);
    applyFlyoutSliderTheme(spacingRow.input, theme.accent, theme.variant);
  }

  function syncFlyoutValues(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    sizeRow.input.value = String(slot.size);
    sizeRow.val.textContent = String(slot.size);
    streamRow.input.value = String(Math.round(slot.streamline * 100));
    streamRow.val.textContent = String(Math.round(slot.streamline * 100));
    spacingRow.input.value = String(Math.round(slot.spacing * 100));
    spacingRow.val.textContent = String(Math.round(slot.spacing * 100));
    // Active states are class-driven; the sheet in flyout-styles.ts
    // paints rings / fills from the --nbf-* theme variables.
    for (const { id, cell } of brushCells) {
      cell.classList.toggle("nbf-active", id === slot.brushId);
    }
    for (const { value, btn } of colorBtns) {
      btn.classList.toggle("nbf-active", value === slot.color);
      if (value === "auto") {
        btn.style.background = state.theme.canvasBackground;
        btn.style.color = state.theme.foreground;
      } else if (value === "heading") {
        btn.style.background = state.theme.canvasBackground;
        btn.style.color = state.theme.headingColor;
      }
    }
    for (const { id, btn } of modeBtns) {
      btn.classList.toggle("nbf-active", slot.mode === id);
    }
    blendRow.style.display = slot.mode === "highlighter" ? "flex" : "none";
    blendInput.checked = state.resolveSlotBlend(slot);
    for (const { straight, btn } of lineBtns) {
      btn.classList.toggle("nbf-active", !!slot.straightLine === straight);
    }
    redrawBrushCells();
    redrawDemoStroke();
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
    // Minimizing the bar takes the slot row with it; an open flyout is
    // anchored to a button that is no longer on screen.
    if (keys.includes("drawingToolbarMinimized") && state.drawingToolbarMinimized) closeFlyout();
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

  function section(title: string | null, children: HTMLElement[]): HTMLElement {
    const sec = h("div");
    if (title !== null) {
      const t = h("div", { text: title });
      t.classList.add("nbf-label");
      sec.appendChild(t);
    }
    for (const c of children) sec.appendChild(c);
    return sec;
  }

  /** Hairline rule between sections — carries the 12 px section
   *  rhythm on both sides (sections themselves have no margins). */
  function divider(): HTMLElement {
    const d = h("div");
    d.classList.add("nbf-divider");
    return d;
  }

  function makeSliderRow(label: string, min: number, max: number, step: number, initial: number): {
    root: HTMLElement; input: HTMLInputElement; val: HTMLElement;
  } {
    const row = h("div", {
      style: { display: "grid", gridTemplateColumns: "52px 1fr 34px", alignItems: "center", gap: "10px", marginBottom: "6px" },
    });
    const lbl = h("label", { text: label });
    lbl.classList.add("nbf-row-label");
    const input = h("input", {
      attrs: { type: "range", min: String(min), max: String(max), step: String(step) },
      style: { width: "100%" },
    }) as HTMLInputElement;
    input.classList.add("notebook-flyout-slider");
    input.value = String(initial);
    const val = h("span", { text: String(initial) });
    val.classList.add("nbf-row-val");
    row.appendChild(lbl); row.appendChild(input); row.appendChild(val);
    return { root: row, input, val };
  }
}
