/**
 * Split geometry — the pure half of the Split / Grab tools.
 *
 * A split is a cut across the whole canvas: two parallel lines whose
 * near and far sides each carry their own content. Dragging one line
 * translates everything on its side, so the canvas opens (or closes)
 * like a concertina. Grabs reuse the same machinery — an "apply" is a
 * cut at each band edge, a lift, and a close.
 *
 * Everything here is a pure function over `Shape[]` / `Split[]`. The
 * interaction state machine lives in `state-splits.ts` and the painting
 * in `renderer-splits.ts`; keeping the maths separate is what lets the
 * grab path reuse the split path wholesale.
 *
 * Two rules run through the whole module:
 *
 *  1. **Splits cut images, and nothing else.** A line through a text
 *     shape, a stroke, a group or a drag box doesn't divide it — the
 *     outermost grouping is resolved (`buildUnits`) and the whole unit
 *     lands on one side. Only a *standalone* image is cut, into two
 *     crop-masked copies of the same bytes, so the cut is invisible
 *     until the sides move apart.
 *  2. **Sides are decided by the unit's centre**, not by overlap. That
 *     makes near / far a partition: every unit belongs to exactly one
 *     side, so a line drag can never move a unit twice or leave one
 *     behind, however many times the canvas has been split.
 */

import type { Axis, Bounds, ImageShape, Shape, Split } from "./types";
import { getShapeBounds, generateId } from "./utils";
import { moveShape } from "./state-helpers";

/** Screen-px separation the renderer forces between a split's two lines
 *  so both stay grabbable when they sit at the same world position.
 *  Shared with the hit test — a click has to land where the line is
 *  drawn, not where it logically is. */
export const SPLIT_LINE_GAP_PX = 10;

/** Screen-px pick radius for a split line. */
export const SPLIT_HIT_PX = 7;

/** A group of shapes that a split treats as indivisible: the transitive
 *  closure of "shares a group id" and "sits inside this drag area". */
export interface ContentUnit {
  ids: string[];
  /** Extent along the split's cross axis (y for a horizontal split). */
  lo: number;
  hi: number;
  center: number;
  /** Set when the unit is a lone, ungrouped, unparented image — the one
   *  case a split is allowed to cut through. */
  cuttableImageId: string | null;
}

/** Cross-axis extent of a bounds rect for the given split orientation.
 *  A horizontal split cuts across y; a vertical one across x. */
export function crossRange(b: Bounds, orientation: Axis): { lo: number; hi: number } {
  return orientation === "horizontal"
    ? { lo: b.minY, hi: b.maxY }
    : { lo: b.minX, hi: b.maxX };
}

/** World delta vector for a scalar move along a split's cross axis. */
export function crossDelta(orientation: Axis, d: number): { dx: number; dy: number } {
  return orientation === "horizontal" ? { dx: 0, dy: d } : { dx: d, dy: 0 };
}

// ───────────────────────── units ─────────────────────────

/**
 * Resolve the outermost grouping of every shape into indivisible units.
 *
 * Union-find over two relations — `groupId` (logical grouping) and
 * `parentId` (drag-area containment) — because they interleave: a
 * handful of grouped strokes dropped inside a drag box has to move as
 * one thing, and neither relation alone says so.
 *
 * `skipIds` drops shapes from consideration entirely (pocketed shapes,
 * which live in screen space, and anything on a hidden layer).
 */
export function buildUnits(
  shapes: Shape[],
  orientation: Axis,
  fontFamily?: string,
  skipIds?: Set<string>,
): ContentUnit[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    // Path compression — a deep drag-area nest would otherwise walk the
    // chain once per shape per lookup.
    let cur = id;
    while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const live: Shape[] = [];
  for (const s of shapes) {
    if (skipIds?.has(s.id)) continue;
    if (s.pocketed) continue;
    live.push(s);
    parent.set(s.id, s.id);
  }
  const present = new Set(live.map((s) => s.id));
  const groupSeed = new Map<string, string>();
  for (const s of live) {
    // A drag area parents its contents; the area itself is a shape, so
    // uniting with it also pulls in every sibling child.
    if (s.parentId && present.has(s.parentId)) union(s.id, s.parentId);
    if (s.groupId) {
      const seed = groupSeed.get(s.groupId);
      if (seed === undefined) groupSeed.set(s.groupId, s.id);
      else union(s.id, seed);
    }
  }

  const byRoot = new Map<string, { ids: string[]; lo: number; hi: number }>();
  for (const s of live) {
    const root = find(s.id);
    const { lo, hi } = crossRange(getShapeBounds(s, fontFamily), orientation);
    const acc = byRoot.get(root);
    if (!acc) byRoot.set(root, { ids: [s.id], lo, hi });
    else {
      acc.ids.push(s.id);
      if (lo < acc.lo) acc.lo = lo;
      if (hi > acc.hi) acc.hi = hi;
    }
  }

  const byId = new Map(live.map((s) => [s.id, s]));
  const units: ContentUnit[] = [];
  for (const acc of byRoot.values()) {
    let cuttable: string | null = null;
    if (acc.ids.length === 1) {
      const only = byId.get(acc.ids[0]);
      if (only && only.type === "image" && !only.parentId && !only.groupId) cuttable = only.id;
    }
    units.push({
      ids: acc.ids,
      lo: acc.lo,
      hi: acc.hi,
      center: (acc.lo + acc.hi) / 2,
      cuttableImageId: cuttable,
    });
  }
  return units;
}

/** Shape ids whose unit centre falls strictly before `pos` — the near
 *  side of a split line, the material its `a` line carries. */
export function idsBefore(units: ContentUnit[], pos: number): Set<string> {
  const out = new Set<string>();
  for (const u of units) if (u.center < pos) for (const id of u.ids) out.add(id);
  return out;
}

/** Shape ids whose unit centre falls strictly after `pos` — the far side. */
export function idsAfter(units: ContentUnit[], pos: number): Set<string> {
  const out = new Set<string>();
  for (const u of units) if (u.center > pos) for (const id of u.ids) out.add(id);
  return out;
}

/** Shape ids whose unit centre lies inside `[lo, hi]` — what a grab
 *  lifts, and what "clear split content" considers for removal. */
export function idsBetween(units: ContentUnit[], lo: number, hi: number): Set<string> {
  const out = new Set<string>();
  for (const u of units) if (u.center >= lo && u.center <= hi) for (const id of u.ids) out.add(id);
  return out;
}

// ───────────────────────── image cutting ─────────────────────────

/**
 * Divide one image at a world coordinate on the given axis, returning
 * the near and far pieces.
 *
 * Both pieces reference the same `dataUrl` and differ only in their
 * placement and crop window, so the pair paints pixel-for-pixel like the
 * original until something moves them — which is the whole point: the
 * cut has to be invisible at the moment it happens. Nothing is
 * re-encoded, so cutting a 50-page proof costs no memory beyond one
 * extra shape record per cut.
 *
 * The near piece keeps the original shape id so anything holding a
 * reference to the image (a proofread page entry, an image cache slot)
 * still resolves.
 */
export function cutImage(shape: ImageShape, orientation: Axis, pos: number): [ImageShape, ImageShape] | null {
  const crop = shape.crop || { x: 0, y: 0, w: 1, h: 1 };
  if (orientation === "horizontal") {
    const top = shape.position.y, h = shape.height;
    if (!(pos > top && pos < top + h)) return null;
    const frac = (pos - top) / h;
    const near: ImageShape = {
      ...shape,
      height: pos - top,
      crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h * frac },
    };
    const far: ImageShape = {
      ...shape,
      id: generateId(),
      position: { x: shape.position.x, y: pos },
      height: top + h - pos,
      crop: { x: crop.x, y: crop.y + crop.h * frac, w: crop.w, h: crop.h * (1 - frac) },
    };
    return [near, far];
  }
  const left = shape.position.x, w = shape.width;
  if (!(pos > left && pos < left + w)) return null;
  const frac = (pos - left) / w;
  const near: ImageShape = {
    ...shape,
    width: pos - left,
    crop: { x: crop.x, y: crop.y, w: crop.w * frac, h: crop.h },
  };
  const far: ImageShape = {
    ...shape,
    id: generateId(),
    position: { x: pos, y: shape.position.y },
    width: left + w - pos,
    crop: { x: crop.x + crop.w * frac, y: crop.y, w: crop.w * (1 - frac), h: crop.h },
  };
  return [near, far];
}

/**
 * Apply `cutImage` to every standalone image the line passes through.
 * Returns the same array when nothing was crossed, so callers can skip
 * the shapes notify (and the save it implies) for a cut that changed
 * nothing.
 *
 * Grouped and drag-area-contained images are deliberately left whole —
 * see rule 1 in the module header.
 */
export function cutImagesAt(
  shapes: Shape[],
  orientation: Axis,
  pos: number,
  units: ContentUnit[],
): Shape[] {
  const cuttable = new Set<string>();
  for (const u of units) if (u.cuttableImageId) cuttable.add(u.cuttableImageId);
  if (!cuttable.size) return shapes;

  let changed = false;
  const out: Shape[] = [];
  for (const s of shapes) {
    if (s.type !== "image" || !cuttable.has(s.id)) { out.push(s); continue; }
    const pieces = cutImage(s as ImageShape, orientation, pos);
    if (!pieces) { out.push(s); continue; }
    out.push(pieces[0], pieces[1]);
    changed = true;
  }
  return changed ? out : shapes;
}

// ───────────────────────── translation ─────────────────────────

/** Translate the named shapes along the split's cross axis. Untouched
 *  shapes keep their identity, so the drawing engine's identity diff and
 *  the undo manager's structural sharing both stay cheap. */
export function translateShapes(shapes: Shape[], ids: Set<string>, orientation: Axis, d: number): Shape[] {
  if (!ids.size || d === 0) return shapes;
  const { dx, dy } = crossDelta(orientation, d);
  return shapes.map((s) => (ids.has(s.id) ? moveShape(s, dx, dy) : s));
}

/**
 * Carry other split lines along with a translation.
 *
 * A split line is content as far as another split is concerned, so each
 * line moves on the same test its side's shapes did — which is what
 * makes splits nest: cut a split inside another and dragging the outer
 * line takes the inner split's lines with it, while a split sitting in
 * the outer gap (neither before nor after) correctly stays put.
 *
 * Cross-orientation splits are untouched: a vertical line runs the whole
 * height of the canvas, so shifting content down the y axis doesn't move
 * it anywhere.
 */
export function translateSplits(
  splits: Split[],
  orientation: Axis,
  d: number,
  moves: (linePos: number) => boolean,
  exceptId?: string,
): Split[] {
  if (d === 0) return splits;
  let changed = false;
  const out = splits.map((s) => {
    if (s.orientation !== orientation || s.id === exceptId) return s;
    const na = moves(s.a) ? s.a + d : s.a;
    const nb = moves(s.b) ? s.b + d : s.b;
    if (na === s.a && nb === s.b) return s;
    changed = true;
    return { ...s, a: na, b: nb };
  });
  return changed ? out : splits;
}

// ───────────────────────── hit testing ─────────────────────────

/** Where a split's two lines are actually painted, in world units.
 *
 *  Coincident lines (every freshly cut split) are pushed apart to
 *  `SPLIT_LINE_GAP_PX` on screen so both can be grabbed; once the user
 *  has opened the split past that, the drawn positions are the true
 *  ones. The hit test reads the same function, so what you click is what
 *  you see. */
export function drawnLinePositions(split: Split, zoom: number): { a: number; b: number } {
  const gap = SPLIT_LINE_GAP_PX / Math.max(zoom, 0.01);
  if (split.b - split.a >= gap) return { a: split.a, b: split.b };
  const mid = (split.a + split.b) / 2;
  return { a: mid - gap / 2, b: mid + gap / 2 };
}

// ───────────────────────── hover actions ─────────────────────────

/** The three things a hovered split line offers. Order is the drawn
 *  order, left-to-right (or top-to-bottom on a vertical split). */
export const SPLIT_ACTIONS = ["clear", "grab", "delete"] as const;
export type SplitAction = (typeof SPLIT_ACTIONS)[number];

export const SPLIT_ACTION_LABELS: Record<SplitAction, string> = {
  clear: "Clear split content",
  grab: "Grab split",
  delete: "Delete split",
};

const ACTION_BTN = 26;
const ACTION_GAP = 4;
/** Clearance between the line and the nearest edge of the cluster. */
const ACTION_OFFSET = 9;

export interface SplitActionRect { action: SplitAction; x: number; y: number; w: number; h: number }

/**
 * Screen-space rects for a hovered line's action cluster.
 *
 * The cluster sits on the OUTSIDE of the split — above the `a` line,
 * below the `b` line — so it never covers the gap, which is exactly the
 * region the user is watching while they drag. `anchor` is the pointer's
 * position along the line, so the buttons appear under the hand rather
 * than at some fixed point the user has to travel to.
 */
export function splitActionRects(
  orientation: Axis,
  line: "a" | "b",
  lineScreen: number,
  anchor: number,
): SplitActionRect[] {
  const n = SPLIT_ACTIONS.length;
  const span = n * ACTION_BTN + (n - 1) * ACTION_GAP;
  const start = anchor - span / 2;
  const off = line === "a" ? -(ACTION_OFFSET + ACTION_BTN) : ACTION_OFFSET;
  return SPLIT_ACTIONS.map((action, i) => {
    const along = start + i * (ACTION_BTN + ACTION_GAP);
    return orientation === "horizontal"
      ? { action, x: along, y: lineScreen + off, w: ACTION_BTN, h: ACTION_BTN }
      : { action, x: lineScreen + off, y: along, w: ACTION_BTN, h: ACTION_BTN };
  });
}

/** Which action rect (if any) a screen point lands in. */
export function hitTestSplitActions(rects: SplitActionRect[], sx: number, sy: number): SplitAction | null {
  for (const r of rects) {
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r.action;
  }
  return null;
}

/** True when a screen point is inside the cluster's overall footprint,
 *  padded a little. The hover anchor freezes while this holds so the
 *  buttons don't slide away as the pointer travels toward them. */
export function withinActionCluster(rects: SplitActionRect[], sx: number, sy: number, pad = 8): boolean {
  if (!rects.length) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return sx >= minX - pad && sx <= maxX + pad && sy >= minY - pad && sy <= maxY + pad;
}

/** Nearest split line under a world point, or null. `b` is tested first
 *  so the two lines of a freshly cut split resolve predictably when the
 *  pick radius covers both. */
export function hitTestSplits(
  splits: Split[],
  world: { x: number; y: number },
  zoom: number,
): { split: Split; line: "a" | "b" } | null {
  const r = SPLIT_HIT_PX / Math.max(zoom, 0.01);
  let best: { split: Split; line: "a" | "b"; d: number } | null = null;
  for (const s of splits) {
    const drawn = drawnLinePositions(s, zoom);
    const p = s.orientation === "horizontal" ? world.y : world.x;
    for (const line of ["a", "b"] as const) {
      const d = Math.abs(p - drawn[line]);
      if (d <= r && (!best || d < best.d)) best = { split: s, line, d };
    }
  }
  return best ? { split: best.split, line: best.line } : null;
}
