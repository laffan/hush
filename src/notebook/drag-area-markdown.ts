/**
 * A drag area's contents as markdown, for the Copy button in its
 * selection toolbar.
 *
 * Reading order is left to right, top to bottom: the children are cut
 * into rows — a child whose box overlaps the row above by at least half
 * the shorter of the two heights joins that row — and each row is read
 * left to right (top to bottom where two start at the same x, which is
 * how a tall box beside a column of short ones reads). A grid laid out
 * by Arrange comes out row by row.
 *
 * Text shapes are markdown already (cards and outlines included) and go
 * in as written. A nested drag area goes in as its own contents, in its
 * own reading order, at its place. Images and ink have no markdown to
 * give and are left out. Blocks are separated by a blank line.
 *
 * Pure: shapes in, a string out.
 */

import type { Bounds, Shape } from "./types";
import { getShapeBounds } from "./utils";

interface Item { shape: Shape; b: Bounds }

/** Order `items` left to right, top to bottom. */
export function readingOrder<T extends { b: Bounds }>(items: T[]): T[] {
  const byTop = [...items].sort((p, q) => p.b.minY - q.b.minY || p.b.minX - q.b.minX);
  const rows: { minY: number; maxY: number; items: T[] }[] = [];
  for (const it of byTop) {
    const row = rows[rows.length - 1];
    const h = Math.max(1, it.b.maxY - it.b.minY);
    if (row) {
      const overlap = Math.min(row.maxY, it.b.maxY) - Math.max(row.minY, it.b.minY);
      if (overlap >= Math.min(h, row.maxY - row.minY) * 0.5) {
        row.items.push(it);
        row.maxY = Math.max(row.maxY, it.b.maxY);
        continue;
      }
    }
    rows.push({ minY: it.b.minY, maxY: it.b.maxY, items: [it] });
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.b.minX - q.b.minX || p.b.minY - q.b.minY));
}

export function dragAreaMarkdown(shapes: Shape[], areaId: string, fontFamily?: string): string {
  const children = new Map<string, Shape[]>();
  for (const s of shapes) {
    if (!s.parentId || s.pocketed) continue;
    const list = children.get(s.parentId);
    if (list) list.push(s);
    else children.set(s.parentId, [s]);
  }
  const seen = new Set<string>();
  const blocksOf = (id: string): string[] => {
    if (seen.has(id)) return []; // a parent chain that loops back on itself
    seen.add(id);
    const items: Item[] = (children.get(id) || [])
      .filter((s) => s.type === "text" || s.type === "drag-area")
      .map((s) => ({ shape: s, b: getShapeBounds(s, fontFamily) }));
    const out: string[] = [];
    for (const { shape } of readingOrder(items)) {
      if (shape.type === "drag-area") out.push(...blocksOf(shape.id));
      else if (shape.type === "text") {
        const text = shape.text.replace(/\s+$/, "").replace(/^\n+/, "");
        if (text.trim()) out.push(text);
      }
    }
    return out;
  };
  return blocksOf(areaId).join("\n\n");
}
