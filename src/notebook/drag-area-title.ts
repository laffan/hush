/**
 * A drag area's title, and the areas that follow theirs.
 *
 * Drag areas can't be flowchart nodes — dropping onto one re-parents into
 * it, and that gesture can't also mean "connect" — so a box that belongs
 * in a chart joins it through the text at its head: a node inside the
 * box, standing as its title, with the chart's arrow pointing at that.
 * Dragging the node's parent pulls the node along (a chart drag moves a
 * node's whole subtree), and without this it was pulled out of its box,
 * leaving the box and everything else in it behind.
 *
 * The rule: a box's title is the child sitting highest in it (leftmost
 * on a tie). When a chart drag, a snap or a tidy moves a box's title as a
 * descendant, the box and everything inside it move with it by the same
 * amount. Only as a descendant — picking the title up by itself still
 * moves just the title, in or out of its box.
 *
 * Pure: shapes in, ids out. `DrawingState` applies it at each place that
 * moves a node's descendants.
 */

import type { Shape } from "./types";
import { getShapeBounds } from "./utils";

/**
 * Every shape carried along by a title that is moving: for each drag area
 * whose title is in `movingIds`, the area and everything inside it
 * (children, and the contents of areas nested in it), each mapped to the
 * id of the title whose move it follows. Shapes already moving are left
 * out. A box carried this way can itself be the title of the box around
 * it, which then follows too.
 */
export function titledAreaFollowers(
  shapes: Shape[],
  movingIds: Set<string>,
  fontFamily?: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (movingIds.size === 0) return out;
  // The live drag asks on every pointer sample, and nearly always none of
  // the moving nodes sits in a box: answer that without building maps.
  let inBox = false;
  for (const s of shapes) {
    if (s.parentId && movingIds.has(s.id)) { inBox = true; break; }
  }
  if (!inBox) return out;

  const byId = new Map<string, Shape>();
  const children = new Map<string, Shape[]>();
  for (const s of shapes) {
    byId.set(s.id, s);
    if (!s.parentId || s.pocketed) continue;
    const list = children.get(s.parentId);
    if (list) list.push(s);
    else children.set(s.parentId, [s]);
  }
  if (children.size === 0) return out;

  const titles = new Map<string, string | null>();
  const titleOf = (areaId: string): string | null => {
    if (titles.has(areaId)) return titles.get(areaId)!;
    let best: string | null = null;
    let bestY = Infinity;
    let bestX = Infinity;
    for (const c of children.get(areaId) || []) {
      const b = getShapeBounds(c, fontFamily);
      if (b.minY < bestY || (b.minY === bestY && b.minX < bestX)) {
        best = c.id;
        bestY = b.minY;
        bestX = b.minX;
      }
    }
    titles.set(areaId, best);
    return best;
  };

  // A worklist, so a carried box can carry the box it is the title of.
  const queue: { id: string; leader: string }[] = [];
  for (const id of movingIds) queue.push({ id, leader: id });
  while (queue.length) {
    const { id, leader } = queue.shift()!;
    const s = byId.get(id);
    const area = s?.parentId ? byId.get(s.parentId) : undefined;
    if (!area || area.type !== "drag-area") continue;
    if (movingIds.has(area.id) || out.has(area.id)) continue;
    if (titleOf(area.id) !== id) continue;
    // The box, and everything inside it, however deeply nested.
    // `seen` guards against a parent chain that loops back on itself.
    const stack: Shape[] = [area];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      if (cur.id !== id && !movingIds.has(cur.id) && !out.has(cur.id)) {
        out.set(cur.id, leader);
        queue.push({ id: cur.id, leader });
      }
      for (const c of children.get(cur.id) || []) stack.push(c);
    }
  }
  return out;
}
