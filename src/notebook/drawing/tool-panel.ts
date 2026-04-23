/* src/notebook/drawing/tool-panel.ts
 *
 * Top-centered tool panel that appears while drawing mode is active.
 * Matches the bottom toolbar pill style so the two chrome elements
 * read as siblings.
 *
 * Contents: Draw / Erase / Slice / Select sub-tool buttons, a
 * vertical divider, then 4 brush slots (via `brush-slots.ts`) whose
 * shared flyout is returned alongside the panel so callers can mount
 * it outside the pill (the flyout is wider than the panel).
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
  // Draw is the implicit default — entering drawing mode always
  // lands on it and the active brush slot in the row below makes it
  // visible. Picking a brush from the row returns the user to Draw
  // from Erase/Slice, so no dedicated Draw button is needed.
  { id: "erase",  iconName: "erase",  label: "Erase",  shortcut: "E" },
  { id: "slice",  iconName: "slice",  label: "Slice",  shortcut: "X" },
  // Select (polygon lasso) lives on the main toolbar next to Pen.
];

export interface DrawingToolPanelHandle {
  /** The pill-shaped panel that sits at the top of the notebook. */
  root: HTMLElement;
  /** The brush-slot flyout. Append separately — it's wider than the
   *  pill and positions itself relative to its parent. */
  flyout: HTMLElement;
}

export function createDrawingToolPanel(
  state: DrawingState,
  drawingLayer: DrawingLayer,
): DrawingToolPanelHandle {
  const container = h("div", {
    style: {
      position: "absolute",
      top: "calc(16px + env(safe-area-inset-top))",
      display: "none",
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
      onClick: () => {
        // state change propagates to drawing-layer via the listener
        // below; direct call is redundant.
        state.setDrawingSubTool(def.id);
      },
    }) as HTMLButtonElement;
    subToolBtns.set(def.id, btn);
    container.appendChild(btn);
  }

  container.appendChild(h("div", {
    style: { width: "1px", height: "24px", background: "currentColor", opacity: "0.15", margin: "0 4px" },
  }));

  // Layers live in the main notebook toolbar (not here) because
  // layer membership applies to every shape type, not just drawings.
  const slots = createBrushSlots(state, drawingLayer);
  container.appendChild(slots.root);

  function updateActiveClasses(): void {
    const theme = state.theme;
    for (const [id, btn] of subToolBtns) {
      const active = state.drawingSubTool === id;
      btn.style.color = active ? theme.accent : theme.foreground;
      btn.style.opacity = active ? "1" : "0.6";
      btn.style.background = active ? "rgba(66, 133, 244, 0.08)" : "transparent";
    }
  }

  function applyActiveSlot(): void {
    const slot = state.brushSlots[state.activeBrushSlot];
    if (slot) drawingLayer.applySlot(slot);
  }

  function updateVisibility(): void {
    const visible = state.drawingMode;
    container.style.display = visible ? "flex" : "none";
    if (visible) {
      const inset = state.leftInset || 0;
      const parent = container.parentElement;
      const parentW = parent ? parent.clientWidth : window.innerWidth;
      const center = inset + (parentW - inset) / 2;
      container.style.left = center + "px";
      container.style.transform = "translateX(-50%)";
      container.style.background = state.theme.uiBackground;
    }
  }

  state.addEventListener("change", ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (keys.includes("drawingMode") || keys.includes("tool") || keys.includes("theme")) {
      updateVisibility();
      if (state.drawingMode) {
        applyActiveSlot();
        drawingLayer.setTool(state.drawingSubTool);
      }
    }
    if (keys.includes("drawingSubTool") || keys.includes("theme")) {
      updateActiveClasses();
    }
    // Push sub-tool changes to the engine regardless of the
    // origin (sub-tool buttons here, Lasso button in main toolbar,
    // or anywhere else that flips the state).
    if (keys.includes("drawingSubTool")) {
      drawingLayer.setTool(state.drawingSubTool);
    }
    // Slot activation / edit: push to engine for future strokes.
    if (keys.includes("activeBrushSlot") || keys.includes("brushSlots")) {
      applyActiveSlot();
    }
  }) as EventListener);

  updateActiveClasses();
  updateVisibility();

  return { root: container, flyout: slots.flyout };
}
