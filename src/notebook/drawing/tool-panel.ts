/* src/notebook/drawing/tool-panel.ts
 *
 * Top-centered drawing toolbar. Visible at all times — drawing tools
 * are now always accessible rather than gated behind a "pen mode"
 * toggle. Clicking any button here (lasso, erase, slice, or a brush
 * slot) implicitly routes input to the drawing engine (state.tool =
 * "pen") with the appropriate sub-tool.
 *
 * Contents (left → right):
 *   Lasso | Erase · Slice | Brush 1 · Brush 2 · Brush 3 · Brush 4
 *
 * The lasso button exposes its own small flyout (click to activate,
 * click-again to toggle) letting the user dial in how long a held
 * stroke needs to be before it promotes into a lasso.
 */

import type { DrawingState } from "../state";
import type { DrawingLayer } from "./drawing-layer";
import type { DrawingSubTool } from "../types";
import { h } from "../ui/dom-helpers";
import { icon } from "../ui/icons";
import { createBrushSlots } from "./brush-slots";

interface SubToolDef {
  id: DrawingSubTool;
  iconName: string;
  label: string;
  shortcut: string;
}

const SUB_TOOLS: SubToolDef[] = [
  // Draw is the implicit default — clicking a brush slot returns the
  // user to Draw (that's how the user exits Erase / Slice), so no
  // dedicated Draw button is needed.
  { id: "erase",  iconName: "erase",  label: "Erase",  shortcut: "E" },
  { id: "slice",  iconName: "slice",  label: "Slice",  shortcut: "X" },
];

export interface DrawingToolPanelHandle {
  /** The pill-shaped panel that sits at the top of the notebook. */
  root: HTMLElement;
  /** Flyouts (brush edit + lasso settings). Append separately — they
   *  can extend past the pill and position themselves relative to
   *  their shared parent. */
  flyout: HTMLElement;
  /** One-item pill (pencil icon) shown only while the main panel is
   *  minimized. Caller mounts it next to the bottom toolbar. */
  restorePill: HTMLElement;
}

export function createDrawingToolPanel(
  state: DrawingState,
  drawingLayer: DrawingLayer,
): DrawingToolPanelHandle {
  const container = h("div", {
    style: {
      position: "absolute",
      top: "calc(16px + env(safe-area-inset-top))",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "6px 8px",
      borderRadius: "12px",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
      zIndex: "100",
      userSelect: "none",
      backdropFilter: "blur(8px)",
    },
  });
  container.classList.add("notebook-tool-panel");

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

  // ----- Lasso button + its flyout ----------------------------------

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
        // Mirror the brush-slot pattern: clicking the already-active
        // tool toggles its flyout.
        if (lassoFlyoutOpen) closeLassoFlyout(); else openLassoFlyout();
        return;
      }
      activateDrawingSubTool("select");
      if (lassoFlyoutOpen) closeLassoFlyout();
    },
  });
  container.appendChild(lassoBtn);

  // Divider between lasso and erase/slice — groups "select" apart
  // from the destructive tools.
  container.appendChild(h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  }));

  // ----- Erase / Slice sub-tools ------------------------------------

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
    container.appendChild(btn);
  }

  container.appendChild(h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  }));

  // ----- Brush slots ------------------------------------------------

  // Layers live in the main notebook toolbar (not here) because
  // layer membership applies to every shape type, not just drawings.
  const slots = createBrushSlots(state, drawingLayer);
  container.appendChild(slots.root);

  // ----- Minimize button -------------------------------------------

  container.appendChild(h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  }));

  const minimizeBtn = h("button", {
    title: "Hide drawing toolbar",
    style: {
      width: "36px", height: "36px", display: "flex",
      alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "8px", cursor: "pointer",
      background: "transparent", transition: "all 0.15s",
    },
    children: [icon("minimize", 20)],
    onClick: () => state.setDrawingToolbarMinimized(true),
  }) as HTMLButtonElement;
  container.appendChild(minimizeBtn);

  // ----- Restore pill (shown when minimized) -----------------------

  const restorePill = h("button", {
    title: "Show drawing toolbar",
    style: {
      position: "absolute",
      bottom: "calc(16px + env(safe-area-inset-bottom))",
      width: "48px", height: "48px",
      display: "none",
      alignItems: "center", justifyContent: "center",
      border: "none", borderRadius: "12px", cursor: "pointer",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
      backdropFilter: "blur(8px)",
      padding: "6px 8px",
      zIndex: "100",
      userSelect: "none",
    },
    children: [icon("pen", 20)],
    onClick: () => state.setDrawingToolbarMinimized(false),
  }) as HTMLButtonElement;
  restorePill.classList.add("notebook-tool-panel");

  // ----- Lasso flyout (hold-duration slider) ------------------------

  let lassoFlyoutOpen = false;
  const lassoFlyout = h("div", {
    style: {
      position: "absolute",
      display: "none",
      minWidth: "220px",
      padding: "12px 14px",
      borderRadius: "12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
      zIndex: "200",
      backdropFilter: "blur(8px)",
      userSelect: "none",
    },
  });
  lassoFlyout.addEventListener("pointerdown", (e) => e.stopPropagation());

  const lassoLabelRow = h("div", {
    style: { fontSize: "11px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", opacity: "0.7", marginBottom: "6px" },
    text: "Hold to select",
  });
  lassoFlyout.appendChild(lassoLabelRow);

  const lassoSliderRow = h("div", {
    style: { display: "grid", gridTemplateColumns: "1fr 48px", alignItems: "center", gap: "10px" },
  });
  const lassoSlider = h("input", {
    attrs: { type: "range", min: "500", max: "2000", step: "50" },
    style: { width: "100%" },
  }) as HTMLInputElement;
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
    // 1 decimal when there's a fractional part, whole seconds otherwise.
    const s = ms / 1000;
    return (Math.round(s * 10) / 10).toFixed(s === Math.round(s) ? 0 : 1) + "s";
  }

  function applyLassoFlyoutTheme(): void {
    const theme = state.theme;
    lassoFlyout.style.background = theme.uiBackground;
    lassoFlyout.style.border = `1px solid ${theme.uiBorder}`;
    lassoFlyout.style.color = theme.foreground;
  }

  function positionLassoFlyout(): void {
    const parent = lassoFlyout.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const btnRect = lassoBtn.getBoundingClientRect();
    const centerX = btnRect.left + btnRect.width / 2 - parentRect.left;
    lassoFlyout.style.left = `${centerX}px`;
    lassoFlyout.style.top = `${btnRect.bottom - parentRect.top + 8}px`;
    lassoFlyout.style.transform = "translateX(-50%)";
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
    // Ignore clicks in any chrome cluster — matches the brush-flyout
    // close-suppression rules so the two panels coexist.
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

  // ----- Panel layout + active-state wiring -------------------------

  function updateActiveClasses(): void {
    const theme = state.theme;
    const drawing = state.tool === "pen";
    // Lasso is active only while the drawing engine is active AND
    // the sub-tool is select.
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

  function applyLayout(): void {
    const inset = state.leftInset || 0;
    const parent = container.parentElement;
    const parentW = parent ? parent.clientWidth : window.innerWidth;
    const center = inset + (parentW - inset) / 2;
    container.style.left = center + "px";
    container.style.transform = "translateX(-50%)";
    container.style.background = state.theme.uiBackground;
    container.style.color = state.theme.foreground;
    if (lassoFlyoutOpen) positionLassoFlyout();
  }

  function applyMinimizedState(): void {
    const minimized = state.drawingToolbarMinimized;
    container.style.display = minimized ? "none" : "flex";
    restorePill.style.display = minimized ? "flex" : "none";
    restorePill.style.background = state.theme.uiBackground;
    restorePill.style.color = state.theme.foreground;
    if (minimized && lassoFlyoutOpen) closeLassoFlyout();
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("theme") || keys.includes("drawingMode") ||
        keys.includes("tool") || keys.includes("drawingSubTool")) {
      applyActiveSlot();
      drawingLayer.setTool(state.drawingSubTool);
    }
    // Brush-slot edits (size / streamline / spacing / color / brushId /
    // mode slider updates in the flyout) and slot activation both need
    // the engine's current-slot config to refresh. Without this branch
    // the engine keeps drawing at whatever size was last pushed by a
    // tool-change event — so a slider drag looks like it's doing
    // nothing until some other state nudge happens to trigger apply.
    if (keys.includes("activeBrushSlot") || keys.includes("brushSlots")) {
      applyActiveSlot();
    }
    // Close the lasso flyout if the user navigates away from lasso —
    // leaving pen mode, or switching to a different sub-tool.
    if (lassoFlyoutOpen) {
      const lassoLive = state.tool === "pen" && state.drawingSubTool === "select";
      if (!lassoLive) closeLassoFlyout();
    }
    updateActiveClasses();
    applyLayout();
    if (keys.includes("drawingToolbarMinimized") || keys.includes("theme")) {
      applyMinimizedState();
    }
  }) as EventListener);

  updateActiveClasses();
  applyLayout();
  applyMinimizedState();
  applyActiveSlot();
  drawingLayer.setTool(state.drawingSubTool);

  // Two flyouts share the same "wider than the pill" parent slot.
  // Callers mount both alongside the pill root.
  const flyoutGroup = h("div", { style: { position: "relative" } });
  flyoutGroup.appendChild(slots.flyout);
  flyoutGroup.appendChild(lassoFlyout);

  return { root: container, flyout: flyoutGroup, restorePill };
}
