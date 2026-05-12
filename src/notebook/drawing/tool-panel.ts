/* src/notebook/drawing/tool-panel.ts
 *
 * Drawing-tools controller for the notebook bar. After the toolbar
 * merge there's no longer a separate "drawing pill" — the divider,
 * brush slots, slice / erase, and lasso buttons all get appended
 * directly to the bottom toolbar so the bar reads as one continuous
 * strip with no shadow seam.
 *
 * The three end-caps live as siblings of the bar inside the canvas
 * container:
 *   [drag][rotate]  — the bar itself  —  [bg-settings]
 * Drag and rotate hug the bar's opening edge (left in horizontal,
 * top in vertical); bg-settings hugs the closing edge.
 *
 * The lasso button still owns its own flyout (click to activate,
 * click-again to toggle the hold-duration slider).
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import type { DrawingSubTool } from "../types";
import { h } from "../ui/dom-helpers";
import { icon } from "../ui/icons";
import { createBrushSlots } from "./brush-slots";
import { ensureFlyoutSliderStyle, applyFlyoutSliderTheme } from "./flyout-styles";
import { createBgSettingsPopup } from "../ui/bg-settings-popup";

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
  /** Drag tab — left end-cap in horizontal mode, top in vertical. */
  dragTab: HTMLElement;
  /** Orientation toggle tab — sits next to the drag tab on the
   *  opening edge of the bar. */
  toggleTab: HTMLElement;
  /** Background-settings tab — right end-cap in horizontal mode,
   *  bottom in vertical. */
  bgSettingsTab: HTMLElement;
  /** Collapse / expand tab — sits past bg-settings on the closing
   *  edge. Toggles `drawingToolbarCollapsed`. */
  collapseTab: HTMLElement;
  /** Wrapper holding every drawing flyout (brush edit, mini-palette,
   *  lasso settings, bg-settings popup). Append once to the canvas
   *  container so each child can position absolutely against it. */
  flyout: HTMLElement;
  /** Recompute end-cap positions after the bar resizes (theme switch,
   *  layers panel content change, leftInset shift). */
  relayout(): void;
}

/** Width of an end-cap perpendicular to the bar's main axis. The
 *  long-axis dimension flips per orientation (38 in horizontal, 52
 *  in vertical) to match the bar's perpendicular thickness. */
const END_CAP_DEPTH = 32;
const BAR_HEIGHT_HORIZONTAL = 38;
const BAR_WIDTH_VERTICAL = 52;

export function createDrawingToolPanel(
  state: DrawingState,
  drawingLayer: DrawingLayer,
  bottomToolbar: HTMLElement,
): DrawingToolPanelHandle {
  ensureFlyoutSliderStyle();

  /** Route a sub-tool activation through the drawing engine. Clicking
   *  any drawing-engine tool (lasso / erase / slice / brush) flips
   *  state.tool to "pen" if it wasn't already and clears any active
   *  pan so the two modes don't layer. */
  function activateDrawingSubTool(sub: DrawingSubTool): void {
    if (state.isPanning) { state.isPanning = false; state.notify("isPanning"); }
    if (state.tool !== "pen") {
      state.tool = "pen";
      state.notify("tool");
      state.notify("drawingMode");
    }
    state.setDrawingSubTool(sub);
  }

  // ----- Divider + brush slots + slice/erase + lasso ----------------
  // All appended directly to the bottom toolbar so the assembly is
  // one continuous bar (no inter-pill shadow seam).

  // Single divider in the combined bar — separates the main canvas
  // tools (select / text / drag-area / brainstorm / layers /
  // bookmarks) from the drawing tools (brushes / slice / erase /
  // lasso). Bg-settings now lives as a right end-cap, not in the bar.
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

  // ----- End-cap tabs (drag, rotate, bg-settings) -------------------

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

  const toggleTab = h("button", {
    title: "Toggle orientation",
    style: { ...tabBaseStyle, width: `${END_CAP_DEPTH}px`, height: `${BAR_HEIGHT_HORIZONTAL}px`, borderRadius: "0", cursor: "pointer" },
    children: [icon("rotate", 18)],
    onClick: () => {
      // Capture the bar's pre-toggle screen center so we can preserve
      // it on the next microtask — without this, flipping orientation
      // snaps the toolbar all the way to the new natural anchor.
      const parent = bottomToolbar.parentElement;
      let savedCenter: { x: number; y: number } | null = null;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        const tbRect = bottomToolbar.getBoundingClientRect();
        if (tbRect.width > 0) {
          savedCenter = {
            x: tbRect.left + tbRect.width / 2 - parentRect.left,
            y: tbRect.top + tbRect.height / 2 - parentRect.top,
          };
        }
      }
      state.setDrawingToolbarVertical(!state.drawingToolbarVertical);
      if (!savedCenter || !parent) return;
      const sc = savedCenter;
      queueMicrotask(() => {
        const parentRect = parent.getBoundingClientRect();
        const tbRect = bottomToolbar.getBoundingClientRect();
        if (tbRect.width === 0) return;
        const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
        const natCx = (tbRect.left + tbRect.width / 2 - parentRect.left) - cur.x;
        const natCy = (tbRect.top + tbRect.height / 2 - parentRect.top) - cur.y;
        const desired = clampOffset(sc.x - natCx, sc.y - natCy);
        state.setDrawingToolbarOffset(desired.x, desired.y);
      });
    },
  }) as HTMLButtonElement;
  toggleTab.classList.add("notebook-tool-panel-toggle-tab");

  const bgSettings = createBgSettingsPopup(state);
  const bgSettingsTab = bgSettings.tab;

  // Collapse / expand tab — sits past bg-settings on the closing edge.
  // Tapping it flips `drawingToolbarCollapsed`; the rest of the toolbar
  // hides except the currently active tool button, leaving a minimal
  // [drag][active tool][collapse] trio.
  const collapseTab = h("button", {
    title: "Collapse toolbar",
    style: { ...tabBaseStyle, width: `${END_CAP_DEPTH}px`, height: `${BAR_HEIGHT_HORIZONTAL}px`, borderRadius: "0 12px 12px 0", cursor: "pointer" },
    children: [icon("toolbar-collapse", 18)],
    onClick: () => state.setDrawingToolbarCollapsed(!state.drawingToolbarCollapsed),
  }) as HTMLButtonElement;
  collapseTab.classList.add("notebook-tool-panel-collapse-tab");

  // ----- Drag-to-reposition wiring + clamp --------------------------

  /** Clamp an offset so the assembly (bar + 3 end-caps) stays inside
   *  its parent. */
  function clampOffset(desiredX: number, desiredY: number): { x: number; y: number } {
    const parent = bottomToolbar.parentElement;
    if (!parent) return { x: desiredX, y: desiredY };
    const parentRect = parent.getBoundingClientRect();
    const tbRect = bottomToolbar.getBoundingClientRect();
    if (tbRect.width === 0) return { x: desiredX, y: desiredY };
    const dragR = dragTab.getBoundingClientRect();
    const togR = toggleTab.getBoundingClientRect();
    const bgR = bgSettingsTab.getBoundingClientRect();
    const colR = collapseTab.getBoundingClientRect();
    const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
    const left = Math.min(tbRect.left, dragR.left, togR.left, bgR.left, colR.left);
    const right = Math.max(tbRect.right, dragR.right, togR.right, bgR.right, colR.right);
    const top = Math.min(tbRect.top, dragR.top, togR.top, bgR.top, colR.top);
    const bottom = Math.max(tbRect.bottom, dragR.bottom, togR.bottom, bgR.bottom, colR.bottom);
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
    dragStartOffset = { ...state.drawingToolbarOffset };
    try { dragTab.setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragTab.style.cursor = "grabbing";
    e.preventDefault();
  }
  function onDragPointerMove(e: PointerEvent) {
    if (dragStartClient === null || e.pointerId !== dragPointerId) return;
    const dx = e.clientX - dragStartClient.x;
    const dy = e.clientY - dragStartClient.y;
    const clamped = clampOffset(dragStartOffset.x + dx, dragStartOffset.y + dy);
    state.setDrawingToolbarOffset(clamped.x, clamped.y);
  }
  function onDragPointerUp(e: PointerEvent) {
    if (dragStartClient === null || e.pointerId !== dragPointerId) return;
    try { dragTab.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    dragStartClient = null;
    dragPointerId = null;
    dragTab.style.cursor = "grab";
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

  function styleEndCaps(vertical: boolean): void {
    const tabBg = "rgba(127,127,127,0.18)";
    const fg = state.theme.foreground;
    const collapsed = state.drawingToolbarCollapsed;
    // When collapsed, the closing-edge cap is the collapse tab itself
    // (drag is the opening cap, rotate + bg-settings are hidden). When
    // expanded, the closing cap is the collapse tab and bg-settings
    // sits just before it without a rounded outer corner.
    if (vertical) {
      // Drag (+ rotate when expanded) stack at the top; bg-settings +
      // collapse stack at the bottom. Long axis = bar's perpendicular
      // thickness (52).
      dragTab.style.width = `${BAR_WIDTH_VERTICAL}px`;
      dragTab.style.height = `${END_CAP_DEPTH}px`;
      dragTab.style.borderRadius = collapsed ? "12px 12px 0 0" : "12px 12px 0 0";
      toggleTab.style.width = `${BAR_WIDTH_VERTICAL}px`;
      toggleTab.style.height = `${END_CAP_DEPTH}px`;
      toggleTab.style.borderRadius = "0";
      bgSettingsTab.style.width = `${BAR_WIDTH_VERTICAL}px`;
      bgSettingsTab.style.height = `${END_CAP_DEPTH}px`;
      bgSettingsTab.style.borderRadius = "0";
      collapseTab.style.width = `${BAR_WIDTH_VERTICAL}px`;
      collapseTab.style.height = `${END_CAP_DEPTH}px`;
      collapseTab.style.borderRadius = "0 0 12px 12px";
      separator.style.width = "24px";
      separator.style.height = "1px";
      separator.style.margin = "4px 0";
    } else {
      dragTab.style.width = `${END_CAP_DEPTH}px`;
      dragTab.style.height = `${BAR_HEIGHT_HORIZONTAL}px`;
      dragTab.style.borderRadius = "12px 0 0 12px";
      toggleTab.style.width = `${END_CAP_DEPTH}px`;
      toggleTab.style.height = `${BAR_HEIGHT_HORIZONTAL}px`;
      toggleTab.style.borderRadius = "0";
      bgSettingsTab.style.width = `${END_CAP_DEPTH}px`;
      bgSettingsTab.style.height = `${BAR_HEIGHT_HORIZONTAL}px`;
      bgSettingsTab.style.borderRadius = "0";
      collapseTab.style.width = `${END_CAP_DEPTH}px`;
      collapseTab.style.height = `${BAR_HEIGHT_HORIZONTAL}px`;
      collapseTab.style.borderRadius = "0 12px 12px 0";
      separator.style.width = "1px";
      separator.style.height = "24px";
      separator.style.margin = "0 4px";
    }
    dragTab.style.background = tabBg;
    dragTab.style.color = fg;
    toggleTab.style.background = tabBg;
    toggleTab.style.color = fg;
    collapseTab.style.background = tabBg;
    collapseTab.style.color = fg;
    collapseTab.title = collapsed ? "Expand toolbar" : "Collapse toolbar";
    collapseTab.replaceChildren(icon(collapsed ? "toolbar-expand" : "toolbar-collapse", 18));
    bgSettings.refreshTheme();
  }

  function applyLayout(): void {
    const parent = bottomToolbar.parentElement;
    if (!parent) return;
    const offset = state.drawingToolbarOffset || { x: 0, y: 0 };
    const vertical = state.drawingToolbarVertical;
    styleEndCaps(vertical);

    const collapsed = state.drawingToolbarCollapsed;
    // Rotate + bg-settings hide entirely while collapsed — only the
    // drag handle, the active tool button (handled by the bar's own
    // child-visibility logic), and the collapse tab stay visible.
    toggleTab.style.display = collapsed ? "none" : "";
    bgSettingsTab.style.display = collapsed ? "none" : "";

    const place = () => {
      const parentRect = parent.getBoundingClientRect();
      const tbRect = bottomToolbar.getBoundingClientRect();
      // Reset tab anchors each pass.
      for (const tab of [dragTab, toggleTab, bgSettingsTab, collapseTab]) {
        tab.style.left = "auto";
        tab.style.right = "auto";
        tab.style.top = "auto";
        tab.style.bottom = "auto";
        tab.style.transform = "none";
      }
      if (vertical) {
        const tbLeft = tbRect.left - parentRect.left;
        const tbTop = tbRect.top - parentRect.top;
        // Drag is outermost above the bar; rotate stacks between drag
        // and bar when expanded. Collapsed → drag sits directly above.
        if (collapsed) {
          dragTab.style.left = tbLeft + "px";
          dragTab.style.top = (tbTop - END_CAP_DEPTH) + "px";
        } else {
          dragTab.style.left = tbLeft + "px";
          dragTab.style.top = (tbTop - END_CAP_DEPTH * 2) + "px";
          toggleTab.style.left = tbLeft + "px";
          toggleTab.style.top = (tbTop - END_CAP_DEPTH) + "px";
        }
        // Bg-settings + collapse hang below the bar (collapse outermost).
        if (!collapsed) {
          bgSettingsTab.style.left = tbLeft + "px";
          bgSettingsTab.style.top = (tbRect.bottom - parentRect.top) + "px";
          collapseTab.style.left = tbLeft + "px";
          collapseTab.style.top = (tbRect.bottom - parentRect.top + END_CAP_DEPTH) + "px";
        } else {
          collapseTab.style.left = tbLeft + "px";
          collapseTab.style.top = (tbRect.bottom - parentRect.top) + "px";
        }
      } else {
        const offsetCalc = `calc(20px + ${offset.y}px)`;
        const tbLeft = tbRect.left - parentRect.left;
        if (collapsed) {
          dragTab.style.left = (tbLeft - END_CAP_DEPTH) + "px";
          dragTab.style.top = offsetCalc;
        } else {
          dragTab.style.left = (tbLeft - END_CAP_DEPTH * 2) + "px";
          dragTab.style.top = offsetCalc;
          toggleTab.style.left = (tbLeft - END_CAP_DEPTH) + "px";
          toggleTab.style.top = offsetCalc;
        }
        // Bg-settings sits flush to the right of the bar, then collapse
        // takes the outermost slot. Collapsed → collapse sits flush.
        if (!collapsed) {
          bgSettingsTab.style.left = (tbRect.right - parentRect.left) + "px";
          bgSettingsTab.style.top = offsetCalc;
          collapseTab.style.left = (tbRect.right - parentRect.left + END_CAP_DEPTH) + "px";
          collapseTab.style.top = offsetCalc;
        } else {
          collapseTab.style.left = (tbRect.right - parentRect.left) + "px";
          collapseTab.style.top = offsetCalc;
        }
      }
    };
    place();
    requestAnimationFrame(() => {
      place();
      // Keep the offset inside the parent on layout changes (window
      // resize, sidebar inset shift, orientation flip). The
      // setDrawingToolbarOffset short-circuit prevents a notify loop
      // when the offset is already in bounds.
      const cur = state.drawingToolbarOffset || { x: 0, y: 0 };
      const c = clampOffset(cur.x, cur.y);
      if (c.x !== cur.x || c.y !== cur.y) {
        state.setDrawingToolbarOffset(c.x, c.y);
      }
    });
    if (lassoFlyoutOpen) positionLassoFlyout();
    bgSettings.reposition();
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
    if (keys.includes("drawingToolbarCollapsed")) applyCollapseVisibility();
    applyLayout();
  }) as EventListener);

  // ----- Collapsed-mode bar children --------------------------------
  // While collapsed, only the currently-active drawing tool button
  // stays visible from the drawing-side of the bar; separator, brush
  // slots row, and any inactive sub-tools hide. The main-side children
  // (select / text / drag-area / brainstorm / layers / bookmarks) are
  // owned by toolbar.ts which runs the same collapse-vs-active filter
  // in its own `update()` pass.
  function applyCollapseVisibility(): void {
    const collapsed = state.drawingToolbarCollapsed;
    const activeSub: string | null = state.tool === "pen" ? state.drawingSubTool : null;
    const brushEl = (state.tool === "pen" && state.drawingSubTool === "draw")
      ? (slots.root.children[state.activeBrushSlot] as HTMLElement | undefined) ?? null
      : null;

    if (!collapsed) {
      separator.style.display = "";
      slots.root.style.display = "";
      for (const slotEl of Array.from(slots.root.children) as HTMLElement[]) slotEl.style.display = "";
      lassoBtn.style.display = "";
      for (const btn of subToolBtns.values()) btn.style.display = "";
      return;
    }

    separator.style.display = "none";
    // Brush-slot row survives only when "draw" is active; within it,
    // hide every non-active slot.
    if (activeSub === "draw" && brushEl) {
      slots.root.style.display = "";
      for (const slotEl of Array.from(slots.root.children) as HTMLElement[]) {
        slotEl.style.display = slotEl === brushEl ? "" : "none";
      }
    } else {
      slots.root.style.display = "none";
    }
    lassoBtn.style.display = activeSub === "select" ? "" : "none";
    for (const [id, btn] of subToolBtns) {
      btn.style.display = activeSub === id ? "" : "none";
    }
  }

  updateActiveClasses();
  applyCollapseVisibility();
  applyLayout();
  applyActiveSlot();
  drawingLayer.setTool(state.drawingSubTool);

  const flyoutGroup = h("div", { style: { position: "relative" } });
  flyoutGroup.appendChild(slots.flyout);
  flyoutGroup.appendChild(slots.miniPalette);
  flyoutGroup.appendChild(lassoFlyout);
  flyoutGroup.appendChild(bgSettings.popup);

  return { dragTab, toggleTab, bgSettingsTab, collapseTab, flyout: flyoutGroup, relayout: applyLayout };
}
