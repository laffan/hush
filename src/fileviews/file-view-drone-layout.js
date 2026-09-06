/**
 * Drone view layout — the desk resolved into a floor plan.
 *
 * A squarified treemap partitions one square plate: every folder becomes
 * a plot whose area is the weight of what it holds, and every file a
 * building standing on its parent's plot. Nesting is elevation — a plot
 * sits on the slab of the plot that contains it — so containment reads
 * as terracing and siblings read as neighbours sharing a wall.
 *
 * Weight is deliberately coarse. Only documents carry their text in the
 * boot library index, so a notebook or PDF contributes a fixed mass
 * rather than sending the view off to read files (see file-view-data.js).
 */

import { childrenOf, isContainer, leafSize, leafModified } from "./file-view-data.js";

export const PLATE = 340;      // world units across the whole floor
export const PLATE_THICK = 7;
export const SLAB_H = 7;       // how far a plot stands above its parent
const PLOT_INSET = 3;          // gap between neighbouring plots
const LEAF_INSET = 2.2;
const PLOT_PAD = 6;            // wall thickness inside a plot
const MAX_DEPTH = 5;
const MAX_BOXES = 600;

/** Layout mass. Containers add a little of their own so an empty folder
 *  still earns a visible plot rather than collapsing to a hairline. */
export function weightOf(state, node) {
  if (!isContainer(node)) return 1 + Math.log2(1 + leafSize(state, node) / 512);
  let w = 0.6;
  for (const kid of childrenOf(node)) w += weightOf(state, kid);
  return w;
}

/** Building height, from the file's size. Log-scaled: a desk holding one
 *  200 KB draft and forty notes should still read as a skyline. */
export function heightOf(state, node) {
  return Math.min(70, 4 + 5.5 * Math.log2(1 + leafSize(state, node) / 256));
}

/** 0 → untouched for two months or unknown, 1 → edited just now. Drives
 *  how brightly a building's roof reads. */
export function recencyOf(state, node) {
  const m = leafModified(state, node);
  if (!m) return 0;
  const days = (Date.now() - m) / 86400000;
  return Math.max(0, Math.min(1, 1 - days / 60));
}

function worst(row, side, scale) {
  if (side <= 0) return Infinity;
  let sum = 0, mx = 0, mn = Infinity;
  for (const it of row) {
    const a = it.weight * scale;
    sum += a;
    if (a > mx) mx = a;
    if (a < mn) mn = a;
  }
  if (sum <= 0 || mn <= 0) return Infinity;
  return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
}

/** Squarified treemap (Bruls/Huizing/van Wijk): fill `rect` with one
 *  cell per item, favouring cells close to square. */
export function squarify(items, rect, out) {
  let rest = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  let r = { ...rect };
  while (rest.length && r.w > 0.01 && r.h > 0.01) {
    let totalRest = 0;
    for (const it of rest) totalRest += it.weight;
    const scale = (r.w * r.h) / (totalRest || 1);
    const side = Math.min(r.w, r.h);
    const row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side, scale) <= worst(row, side, scale)) {
      row.push(rest[i]);
      i++;
    }
    let rowWeight = 0;
    for (const it of row) rowWeight += it.weight;
    const rowArea = rowWeight * scale;
    if (r.w >= r.h) {
      const rw = Math.min(r.w, rowArea / r.h);
      let y = r.y;
      for (const it of row) {
        const h = (it.weight * scale) / (rw || 1);
        out.push({ item: it, x: r.x, y, w: rw, h });
        y += h;
      }
      r = { x: r.x + rw, y: r.y, w: r.w - rw, h: r.h };
    } else {
      const rh = Math.min(r.h, rowArea / r.w);
      let x = r.x;
      for (const it of row) {
        const w = (it.weight * scale) / (rh || 1);
        out.push({ item: it, x, y: r.y, w, h: rh });
        x += w;
      }
      r = { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh };
    }
    rest = rest.slice(row.length);
  }
}

/**
 * Build one level of plots and everything under it.
 *
 * Boxes come back nested (`box.children`) rather than flat: painter
 * order depends on the yaw the camera happens to be at, so siblings have
 * to be sortable at draw time, while a plot must always be painted
 * before the things standing on it.
 *
 * Each box: `{ node, x0, y0, x1, y1, z0, z1, container, depth, children }`
 * in world units, with the plate centred on the origin.
 */
export function buildBoxes(state, nodes, rect, depth, baseZ, budget) {
  const level = [];
  if (depth > MAX_DEPTH || budget.n > MAX_BOXES) return level;
  const items = nodes.map((n) => ({ node: n, weight: weightOf(state, n) }));
  const cells = [];
  squarify(items, rect, cells);
  for (const cell of cells) {
    const node = cell.item.node;
    const container = isContainer(node);
    const inset = container ? PLOT_INSET : LEAF_INSET;
    const w = cell.w - inset * 2;
    const h = cell.h - inset * 2;
    if (w <= 0.8 || h <= 0.8) continue;   // too thin to read — drop it
    const x0 = cell.x + inset, y0 = cell.y + inset;
    budget.n++;
    if (container) {
      const top = baseZ + SLAB_H;
      const box = {
        node, x0, y0, x1: x0 + w, y1: y0 + h,
        z0: baseZ, z1: top, container: true, depth, children: [],
      };
      const kids = childrenOf(node);
      if (kids.length) {
        box.children = buildBoxes(state, kids, {
          x: x0 + PLOT_PAD, y: y0 + PLOT_PAD,
          w: Math.max(0, w - PLOT_PAD * 2), h: Math.max(0, h - PLOT_PAD * 2),
        }, depth + 1, top, budget);
      }
      level.push(box);
    } else {
      level.push({
        node, x0, y0, x1: x0 + w, y1: y0 + h,
        z0: baseZ, z1: baseZ + heightOf(state, node), container: false, depth, children: [],
      });
    }
  }
  return level;
}

/** The whole model for one focus level, plate-centred on the origin. */
export function buildModel(state, roots) {
  return buildBoxes(state, roots, { x: -PLATE / 2, y: -PLATE / 2, w: PLATE, h: PLATE }, 0, 0, { n: 0 });
}
