/**
 * Bridges Hush's `state.selectedIds` set into the engine's selection
 * so the resize / rotate bbox + handles appear for strokes selected
 * via *any* tool, not just the pen-mode lasso. CSS pins
 * `pointer-events: auto` on the bbox + handles so they stay
 * interactive even while the SVG root is non-capturing outside pen
 * mode (see `drawing-layer-dom.ts` and `notebook.css`).
 *
 * Pulled out of `drawing-layer.ts` to keep that file under the 700
 * line cap.
 */

import type { ShimState } from "./sync-shim";

interface SelectionEngine {
  activate(): void;
  deactivate(): void;
  setSelectedIds(ids: Iterable<number>): void;
}

interface ShimRef {
  current: { getEngineStrokeId(id: string): number | undefined } | null;
}

export function createSelectionBridge(deps: {
  state: ShimState;
  selectionEngine: SelectionEngine;
  shimBox: ShimRef;
}): { destroy(): void } {
  const { state, selectionEngine, shimBox } = deps;
  let bridging = false;

  const onChange = ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (!keys.includes("selectedIds") && !keys.includes("shapes") &&
        !keys.includes("tool") && !keys.includes("drawingSubTool")) return;
    if (bridging) return;
    // Pen-mode lasso owns its own selection — leave it alone.
    if (state.tool === "pen" && state.drawingSubTool === "select") return;
    // Pen-mode drawing / erasing / slicing should never carry
    // selection chrome from a prior Hush selection.
    if (state.tool === "pen" && state.drawingSubTool !== "select") {
      bridging = true;
      try { selectionEngine.setSelectedIds(new Set()); selectionEngine.deactivate(); }
      finally { bridging = false; }
      return;
    }
    const drawIds = new Set<number>();
    for (const id of state.selectedIds) {
      const eid = shimBox.current?.getEngineStrokeId(id);
      if (eid !== undefined) drawIds.add(eid);
    }
    bridging = true;
    try {
      if (drawIds.size > 0) {
        selectionEngine.activate();
        selectionEngine.setSelectedIds(drawIds);
      } else {
        selectionEngine.setSelectedIds(new Set());
        selectionEngine.deactivate();
      }
    } finally {
      bridging = false;
    }
  }) as EventListener;
  state.addEventListener("change", onChange);

  return {
    destroy() { state.removeEventListener("change", onChange); },
  };
}
