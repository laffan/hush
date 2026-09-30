/**
 * The writes the outline layer (`ui/outline-layer.ts`) makes to outline
 * shapes. Each replaces the shape, per the immutability rule; neither
 * records an undo step — the layer records one after a pause in typing,
 * and a measured height is derived, not an edit.
 */
import type { DrawingState } from "./state";

/** The outline's editor changed its text. */
export function setOutlineText(state: DrawingState, id: string, text: string): void {
  let changed = false;
  const next = state.shapes.map((s) => {
    if (s.id !== id || s.type !== "text" || !s.outline || s.text === text) return s;
    changed = true;
    return { ...s, text };
  });
  if (!changed) return;
  state.shapes = next;
  state.notify("shapes");
}

/** Heights the layer measured, onto their shapes (`outlineHeight`). */
export function setOutlineHeights(state: DrawingState, heights: Map<string, number>): void {
  let changed = false;
  const next = state.shapes.map((s) => {
    const h = heights.get(s.id);
    if (h === undefined || s.type !== "text" || !s.outline || s.outlineHeight === h) return s;
    changed = true;
    return { ...s, outlineHeight: h };
  });
  if (!changed) return;
  state.shapes = next;
  state.notify("shapes");
}
