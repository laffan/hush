/* src/notebook/drawing/tool-panel.ts
 *
 * Drawing-tools controller for the notebook bar. Appends the divider,
 * brush slots, slice / erase, and lasso buttons directly onto the
 * bottom toolbar so the bar reads as one continuous strip.
 *
 * After the toolbar redesign the only end-cap that lives next to the
 * bar is a drag handle. The orientation toggle, background-settings
 * popup, and collapse tab were removed:
 *   - Background settings now mount as a fixed bottom-right button
 *     (see `src/notebook/ui/bg-settings-fixed-button.ts`).
 *   - Orientation flips through drag-snap zones (top / bottom / left).
 *   - Collapse is gone — the responsive 2-row layout handles narrow
 *     viewports instead.
 *
 * Drag-snap: while the user drags the bar around, three highlighted
 * drop zones appear pinned to the top edge, the bottom edge, and the
 * left edge of the canvas. Dropping inside a zone snaps the toolbar to
 * that position. Dropping outside leaves it at the dragged offset.
 *
 * Responsive: when the bar's natural width would overflow the visible
 * canvas, every child icon shrinks to 75% and the bar wraps to two
 * rows via `flex-wrap`.
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import type { DrawingSubTool } from "../types";
import { h } from "../ui/dom-helpers";
import { icon } from "../ui/icons";
import { createBrushSlots } from "./brush-slots";
import { ensureFlyoutSliderStyle, applyFlyoutSliderTheme } from "./flyout-styles";

interface SubToolDef {
  id: DrawingSubTool;
  iconName: string;
  label: string;
  shortcut: string;
}

const SUB_TOOLS: SubToolDef[] = [
  { id: "slice",  iconName: "slice",  label: "Slice",  shortcut: "X" },
  { id: "erase",  iconName: "erase",  label: "Erase",  shortcut: "E" },
];

export interface DrawingToolPanelHandle {
  /** Drag tab — sits flush against the bar's opening edge. */
  dragTab: HTMLElement;
  /** Wrapper holding the drawing flyouts (brush edit, mini-palette,
   *  lasso settings). */
  flyout: HTMLElement;
  /** Recompute layout after the bar resizes / snap position changes. */
  relayout(): void;
}

const END_CAP_DEPTH = 32;
const BAR_HEIGHT_HORIZONTAL = 38;
const BAR_WIDTH_VERTICAL = 52;
/** Margin of the drop zone from the canvas edge it represents. */
const SNAP_ZONE_MARGIN = 12;
/** Thickness of each drop zone strip. */
const SNAP_ZONE_THICKNESS = 80;

export function createDrawingToolPanel(
  state: DrawingState,
  drawingLayer: DrawingLayer,
  bottomToolbar: HTMLElement,
): DrawingToolPanelHandle {
  ensureFlyoutSliderStyle();

  function activateDrawingSubTool(sub: DrawingSubTool): void {
    if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
    if (state.tool !== "pen") {
      state.tool = "pen";
      state.notify("tool");
      state.notify("drawingMode");
    }
    state.setDrawingSubTool(sub);
  }

  const separator = h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  });
  bottomToolbar.appendChild(separator);

  const slots = createBrushSlots(state, drawingLayer);
  bottomToolbar.appendChild(slots.root);

  const subToolBtns = new Map<DrawingSubTool, HTMLButtonElement>();
  for (const def of SUB_TOOLS) {
    const btn = h("button", {
      title: `${def.label} (${def.shortcut})`,
      style: {
        width: "36px", height: "36px", display: "flex",
        alignItems: "center", justifyContent: "center",
        border: "none", borderRadius: "8px", cursor: "pointer",
        background: "transparent", transition: "all 0.15s",
      },
      children: [icon(def.iconName, 20)],
      onClick: () => activateDrawingSubTool(def.id),
    }) as HTMLButtonElement;
    subToolBtns.set(def.id, btn);
    bottomToolbar.appendChild(btn);
  }

  const lassoBtn = h("button", {
    title: "Lasso select",
    style: {
      width: "36px", height: "36px", display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "8px", cursor: "pointer",
      background: "transparent", transition: "all 0.15s",
    },
    children: [icon("lasso", 20)],
    onClick: () => {
      const alreadyActive = state.tool === "pen" && state.drawingSubTool === "select";
      if (alreadyActive) {
        if (lassoFlyoutOpen) closeLassoFlyout(); else openLassoFlyout();
        return;
      }
      activateDrawingSubTool("select");
      if (lassoFlyoutOpen) closeLassoFlyout();
    },
  });
  bottomToolbar.appendChild(lassoBtn);

  // ----- Drag tab (single end-cap) ----------------------------------

  const tabBaseStyle = {
    position: "absolute" as const,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    border: "none",
    transition: "background 0.15s",
    touchAction: "none" as const,
    zIndex: "100",
    padding: "0",
    userSelect: "none" as const,
  };

  const dragTab = h("button", {
    title: "Drag toolbar",
    style: { ...tabBaseStyle, width: `${END_CAP_DEPTH}px`, height: `${BAR_HEIGHT_HORIZONTAL}px`, borderRadius: "12px 0 0 12px", cursor: "grab" },
    children: [icon("menu", 18)],
  }) as HTMLButtonElement;
  dragTab.classList.add("notebook-tool-panel-drag-tab");

  // ----- Snap-zone overlays -----------------------------------------

  function makeZone(): HTMLElement {
    const z = document.createElement("div");
    z.className = "notebook-toolbar-snap-zone";
    Object.assign(z.style, {
      position: "absolute",
      display: "none",
      borderRadius: "12px",
      background: "rgba(66, 153, 225, 0.18)",
      border: "2px dashed rgba(66, 153, 225, 0.65)",
      pointerEvents: "none",
      zIndex: "99",
      transition: "background 80ms",
    } as Partial<CSSStyleDeclaration>);
    return z;
  }
  const zoneTop = makeZone();
  const zoneBottom = makeZone();
  const zoneLeft = makeZone();

  function positionSnapZones(): void {
    const parent = bottomToolbar.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    const leftInset = state.leftInset || 0;
    const rightInset = state.rightInset || 0;
    const innerW = r.width - leftInset - rightInset;
    const innerX = leftInset;
    const zoneW = Math.min(innerW * 0.7, 600);
    const zoneX = innerX + (innerW - zoneW) / 2;
    Object.assign(zoneTop.style, {
      left: `${zoneX}px`, top: `${SNAP_ZONE_MARGIN}px`,
      width: `${zoneW}px`, height: `${SNAP_ZONE_THICKNESS}px`,
    });
    Object.assign(zoneBottom.style, {
      left: `${zoneX}px`, top: `${r.height - SNAP_ZONE_MARGIN - SNAP_ZONE_THICKNESS}px`,
      width: `${zoneW}px`, height: `${SNAP_ZONE_THICKNESS}px`,
    });
    const zoneH = Math.min(r.height * 0.7, 600);
    Object.assign(zoneLeft.style, {
      left: `${leftInset + SNAP_ZONE_MARGIN}px`, top: `${(r.height - zoneH) / 2}px`,
      width: `${SNAP_ZONE_THICKNESS}px`, height: `${zoneH}px`,
    });
  }
  function showSnapZones(show: boolean): void {
    for (const z of [zoneTop, zoneBottom, zoneLeft]) {
      z.style.display = show ? "block" : "none";
      z.style.background = "rgba(66, 153, 225, 0.18)";
    }
    if (show) positionSnapZones();
  }
  function highlightZone(zone: HTMLElement | null): void {
    for (const z of [zoneTop, zoneBottom, zoneLeft]) {
      z.style.background = z === zone ? "rgba(66, 153, 225, 0.40)" : "rgba(66, 153, 225, 0.18)";
    }
  }
  function hitTestZone(clientX: number, clientY: number): "top" | "bottom" | "left" | null {
    function inside(z: HTMLElement): boolean {
      const r = z.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }
    if (inside(zoneTop)) return "top";
    if (inside(zoneBottom)) return "bottom";
    if (inside(zoneLeft)) return "left";
    return null;
  }

  // ----- Drag-to-reposition wiring + clamp --------------------------

  function clampOffset(desiredX: number, desiredY: number): { x: number; y: number } {
    const parent = bottomToolbar.parentElement;
    if (!parent) return { x: desiredX, y: desiredY };
    const parentRect = parent.getBoundingClientRect();
    const tbRect = bottomToolbar.getBoundingClientRect();
    if (tbRect.width === 0) return { x: desiredX, y: desiredY };
    const rects = [tbRect, dragTab.getBoundingClientRect()];
    const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const natLeft = (left - parentRect.left) - cur.x;
    const natRight = (right - parentRect.left) - cur.x;
    const natTop = (top - parentRect.top) - cur.y;
    const natBottom = (bottom - parentRect.top) - cur.y;
    const leftBound = state.leftInset || 0;
    let minX = leftBound - natLeft;
    let maxX = parentRect.width - natRight;
    if (minX > maxX) { const m = (minX + maxX) / 2; minX = maxX = m; }
    let minY = -natTop;
    let maxY = parentRect.height - natBottom;
    if (minY > maxY) { const m = (minY + maxY) / 2; minY = maxY = m; }
    return {
      x: Math.max(minX, Math.min(maxX, desiredX)),
      y: Math.max(minY, Math.min(maxY, desiredY)),
    };
  }

  let dragStartClient: { x: number; y: number } | null = null;
  let dragStartOffset: { x: number; y: number } = { x: 0, y: 0 };
  let dragPointerId: number | null = null;
  function onDragPointerDown(e: PointerEvent) {
    if (e.button !== undefined && e.button !== 0) return;
    dragPointerId = e.pointerId;
    dragStartClient = { x: e.clientX, y: e.clientY };
    // Promote a snapped position to custom while dragging so the offset
    // delta paints live. Capture the pre-drag screen center so the bar
    // starts the drag exactly where it sat before.
    const parent = bottomToolbar.parentElement;
    if (parent && state.drawingToolbarPosition !== "custom") {
      const parentRect = parent.getBoundingClientRect();
      const tbRect = bottomToolbar.getBoundingClientRect();
      const sc = {
        x: tbRect.left + tbRect.width / 2 - parentRect.left,
        y: tbRect.top + tbRect.height / 2 - parentRect.top,
      };
      state.drawingToolbarPosition = "custom";
      state.notify("drawingToolbarPosition");
      state.notify("drawingToolbarVertical");
      // After the layout pass switches to custom (centered on parent),
      // back-compute the offset that puts the bar back at its old centre.
      queueMicrotask(() => {
        const pr = parent.getBoundingClientRect();
        const tr = bottomToolbar.getBoundingClientRect();
        const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
        const natCx = (tr.left + tr.width / 2 - pr.left) - cur.x;
        const natCy = (tr.top + tr.height / 2 - pr.top) - cur.y;
        const desired = clampOffset(sc.x - natCx, sc.y - natCy);
        state.setDrawingToolbarOffset(desired.x, desired.y);
        dragStartOffset = { ...state.drawingToolbarOffset };
      });
    }
    dragStartOffset = { ...state.drawingToolbarOffset };
    try { dragTab.setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragTab.style.cursor = "grabbing";
    showSnapZones(true);
    e.preventDefault();
  }
  function onDragPointerMove(e: PointerEvent) {
    if (dragStartClient === null || e.pointerId !== dragPointerId) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    const clamped = clampOffset(dragStartOffset.x + dx, dragStartOffset.y + dy);
    state.setDrawingToolbarOffset(clamped.x, clamped.y);
    const zone = hitTestZone(e.clientX, e.clientY);
    highlightZone(zone === "top" ? zoneTop : zone === "bottom" ? zoneBottom : zone === "left" ? zoneLeft : null);
  }
  function onDragPointerUp(e: PointerEvent) {
    if (dragStartClient === null || e.pointerId !== dragPointerId) return;
    try { dragTab.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const zone = hitTestZone(e.clientX, e.clientY);
    if (zone) state.setDrawingToolbarPosition(zone);
    dragStartClient = null;
    dragPointerId = null;
    dragTab.style.cursor = "grab";
    showSnapZones(false);
  }
  dragTab.addEventListener("pointerdown", onDragPointerDown);
  dragTab.addEventListener("pointermove", onDragPointerMove);
  dragTab.addEventListener("pointerup", onDragPointerUp);
  dragTab.addEventListener("pointercancel", onDragPointerUp);

  // ----- Lasso flyout (hold-duration slider) ------------------------

  let lassoFlyoutOpen = false;
  const lassoFlyout = h("div", {
    style: {
      position: "absolute", display: "none", minWidth: "220px",
      padding: "12px 14px", borderRadius: "12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.15)", zIndex: "200",
      backdropFilter: "blur(8px)", userSelect: "none",
    },
  });
  lassoFlyout.addEventListener("pointerdown", (e) => e.stopPropagation());

  lassoFlyout.appendChild(h("div", {
    text: "Hold to select",
    style: { fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", opacity: "0.7", marginBottom: "6px" },
  }));

  const lassoSliderRow = h("div", {
    style: { display: "grid", gridTemplateColumns: "1fr 48px", alignItems: "center", gap: "10px" },
  });
  const lassoSlider = h("input", {
    attrs: { type: "range", min: "500", max: "2000", step: "50" },
    style: { width: "100%" },
  }) as HTMLInputElement;
  lassoSlider.classList.add("notebook-flyout-slider");
  lassoSlider.value = String(state.lassoHoldMs);
  const lassoReadout = h("span", {
    text: formatHoldMs(state.lassoHoldMs),
    style: { fontSize: "11px", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: "0.7" },
  });
  lassoSlider.addEventListener("input", () => {
    const ms = parseInt(lassoSlider.value, 10);
    lassoReadout.textContent = formatHoldMs(ms);
    state.setLassoHoldMs(ms);
  });
  lassoSliderRow.appendChild(lassoSlider);
  lassoSliderRow.appendChild(lassoReadout);
  lassoFlyout.appendChild(lassoSliderRow);

  function formatHoldMs(ms: number): string {
    const s = ms / 1000;
    return (Math.round(s * 10) / 10).toFixed(s === Math.round(s) ? 0 : 1) + "s";
  }

  function applyLassoFlyoutTheme(): void {
    const theme = state.theme;
    lassoFlyout.style.background = theme.uiBackground;
    lassoFlyout.style.border = `1px solid ${theme.uiBorder}`;
    lassoFlyout.style.color = theme.foreground;
    applyFlyoutSliderTheme(lassoSlider, theme.accent);
  }

  function positionLassoFlyout(): void {
    const parent = lassoFlyout.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const btnRect = lassoBtn.getBoundingClientRect();
    lassoFlyout.style.left = "auto";
    lassoFlyout.style.right = "auto";
    lassoFlyout.style.top = "auto";
    lassoFlyout.style.bottom = "auto";
    if (state.drawingToolbarVertical) {
      const centerY = btnRect.top + btnRect.height / 2 - parentRect.top;
      lassoFlyout.style.top = `${centerY}px`;
      lassoFlyout.style.transform = "translateY(-50%)";
      const cx = btnRect.left + btnRect.width / 2;
      if (cx < window.innerWidth / 2) {
        lassoFlyout.style.left = `${btnRect.right - parentRect.left + 8}px`;
      } else {
        lassoFlyout.style.right = `${parentRect.right - btnRect.left + 8}px`;
      }
    } else {
      const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
      lassoFlyout.style.left = `${centerX}px`;
      lassoFlyout.style.transform = "translateX(-50%)";
      const cy = btnRect.top + btnRect.height / 2;
      if (cy < window.innerHeight / 2) {
        lassoFlyout.style.top = `${btnRect.bottom - parentRect.top + 8}px`;
      } else {
        lassoFlyout.style.bottom = `${parentRect.bottom - btnRect.top + 8}px`;
      }
    }
  }

  function openLassoFlyout(): void {
    lassoFlyoutOpen = true;
    lassoFlyout.style.display = "block";
    applyLassoFlyoutTheme();
    lassoSlider.value = String(state.lassoHoldMs);
    lassoReadout.textContent = formatHoldMs(state.lassoHoldMs);
    positionLassoFlyout();
  }
  function closeLassoFlyout(): void {
    lassoFlyoutOpen = false;
    lassoFlyout.style.display = "none";
  }

  document.addEventListener("keydown", (e) => {
    if (lassoFlyoutOpen && e.key === "Escape") closeLassoFlyout();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!lassoFlyoutOpen) return;
    const t = e.target as Node;
    if (lassoFlyout.contains(t) || lassoBtn.contains(t)) return;
    let el: HTMLElement | null = t as HTMLElement;
    while (el && el !== document.body) {
      const cls = el.classList;
      if (cls && (cls.contains("notebook-toolbar") || cls.contains("notebook-tool-panel") ||
                  cls.contains("status-bar") || cls.contains("shelf") ||
                  cls.contains("selection-toolbar"))) return;
      el = el.parentElement;
    }
    closeLassoFlyout();
  });

  // ----- Active-state classes + layout ------------------------------

  function updateActiveClasses(): void {
    const theme = state.theme;
    const drawing = state.tool === "pen";
    const lassoActive = drawing && state.drawingSubTool === "select";
    lassoBtn.style.color = lassoActive ? theme.accent : theme.foreground;
    lassoBtn.style.opacity = lassoActive ? "1" : "0.6";
    lassoBtn.style.background = lassoActive ? "rgba(66, 133, 244, 0.08)" : "transparent";
    for (const [id, btn] of subToolBtns) {
      const active = drawing && state.drawingSubTool === id;
      btn.style.color = active ? theme.accent : theme.foreground;
      btn.style.opacity = active ? "1" : "0.6";
      btn.style.background = active ? "rgba(66, 133, 244, 0.08)" : "transparent";
    }
  }

  function applyActiveSlot(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    if (slot) drawingLayer.applySlot(slot);
  }

  function styleDragTab(vertical: boolean): void {
    const tabBg = "rgba(127,127,127,0.18)";
    const fg = state.theme.foreground;
    if (vertical) {
      dragTab.style.width = `${BAR_WIDTH_VERTICAL}px`;
      dragTab.style.height = `${END_CAP_DEPTH}px`;
      dragTab.style.borderRadius = "12px 12px 0 0";
      separator.style.width = "24px";
      separator.style.height = "1px";
      separator.style.margin = "4px 0";
    } else {
      dragTab.style.width = `${END_CAP_DEPTH}px`;
      dragTab.style.height = `${BAR_HEIGHT_HORIZONTAL}px`;
      dragTab.style.borderRadius = "12px 0 0 12px";
      separator.style.width = "1px";
      separator.style.height = "24px";
      separator.style.margin = "0 4px";
    }
    dragTab.style.background = tabBg;
    dragTab.style.color = fg;
  }

  function applyLayout(): void {
    const parent = bottomToolbar.parentElement;
    if (!parent) return;
    const vertical = state.drawingToolbarVertical;
    styleDragTab(vertical);

    const place = () => {
      const parentRect = parent.getBoundingClientRect();
      const tbRect = bottomToolbar.getBoundingClientRect();
      dragTab.style.left = "auto";
      dragTab.style.right = "auto";
      dragTab.style.top = "auto";
      dragTab.style.bottom = "auto";
      dragTab.style.transform = "none";
      const tbLeft = tbRect.left - parentRect.left;
      const tbTop = tbRect.top - parentRect.top;
      if (vertical) {
        dragTab.style.left = tbLeft + "px";
        dragTab.style.top = (tbTop - END_CAP_DEPTH) + "px";
      } else {
        dragTab.style.left = (tbLeft - END_CAP_DEPTH) + "px";
        dragTab.style.top = tbTop + "px";
      }
    };
    place();
    requestAnimationFrame(() => {
      place();
      const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
      const c = clampOffset(cur.x, cur.y);
      if (c.x !== cur.x || c.y !== cur.y) {
        state.setDrawingToolbarOffset(c.x, c.y);
      }
    });
    if (lassoFlyoutOpen) positionLassoFlyout();
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme") || keys.includes("drawingMode") ||
        keys.includes("tool") || keys.includes("drawingSubTool")) {
      applyActiveSlot();
      drawingLayer.setTool(state.drawingSubTool);
    }
    if (keys.includes("activeBrushSlot") || keys.includes("brushSlots")) {
      applyActiveSlot();
    }
    if (lassoFlyoutOpen) {
      const lassoLive = state.tool === "pen" && state.drawingSubTool === "select";
      if (!lassoLive) closeLassoFlyout();
    }
    updateActiveClasses();
    applyLayout();
  }) as EventListener);

  updateActiveClasses();
  applyLayout();
  applyActiveSlot();
  drawingLayer.setTool(state.drawingSubTool);

  const flyoutGroup = h("div", { style: { position: "relative" } });
  flyoutGroup.appendChild(slots.flyout);
  flyoutGroup.appendChild(slots.miniPalette);
  flyoutGroup.appendChild(lassoFlyout);
  flyoutGroup.appendChild(zoneTop);
  flyoutGroup.appendChild(zoneBottom);
  flyoutGroup.appendChild(zoneLeft);

  return { dragTab, flyout: flyoutGroup, relayout: applyLayout };
}
