/**
 * A flowchart for painting a *saved* notebook's arrows — a Desktop
 * thumbnail, a Versions preview — where there is no live DrawingState to
 * own one. `renderForExport` already draws a `flowchart` when handed one;
 * these callers used to pass none, so a chart arrived as its boxes with
 * every line between them missing.
 *
 * Anchors on group bounds the way the canvas does
 * (`DrawingState.unionGroupBounds`), so an arrow meets a grouped cluster
 * at its edge rather than at one stray member. Drag areas are never
 * nodes (a box joins a chart through its title, which is a text shape).
 */

import { FlowchartLayer, type FlowEdge } from "./flowchart";
import { getShapeBounds } from "./utils";
import type { Bounds, Shape } from "./types";

/** `zoom` is the scale the snapshot is drawn at: the stroke and head are
 *  widened so they still land at least `minPx` / a legible head on the
 *  small raster, where the canvas's 1.5-unit line would be a hair. */
export function snapshotFlowchart(
  shapes: Shape[],
  edges: FlowEdge[] | undefined | null,
  fontFamily: string,
  zoom = 1,
  minPx = 1.5,
): FlowchartLayer<Shape> | undefined {
  if (!edges || !edges.length) return undefined;
  const own = new Map<string, Bounds>();
  const boundsOf = (s: Shape): Bounds => {
    let b = own.get(s.id);
    if (!b) { b = getShapeBounds(s, fontFamily); own.set(s.id, b); }
    return b;
  };
  const groups = new Map<string, Bounds>();
  for (const s of shapes) {
    if (!s.groupId) continue;
    const b = boundsOf(s);
    const g = groups.get(s.groupId);
    groups.set(s.groupId, g ? {
      minX: Math.min(g.minX, b.minX), minY: Math.min(g.minY, b.minY),
      maxX: Math.max(g.maxX, b.maxX), maxY: Math.max(g.maxY, b.maxY),
    } : { ...b });
  }
  const bounds = (s: Shape) => (s.groupId && groups.get(s.groupId)) || boundsOf(s);
  const flow = new FlowchartLayer<Shape>({
    getBounds: bounds,
    getLayoutBounds: bounds,
    isFlowable: (s) => s.type !== "drag-area",
  });
  flow.deserialize(edges);
  const z = zoom > 0 ? zoom : 1;
  flow.setArrowMetrics(Math.max(1.5, minPx / z), Math.max(11, (minPx * 6) / z));
  return flow;
}
