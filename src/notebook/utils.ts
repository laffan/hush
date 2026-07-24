import { LINE_HEIGHT_RATIO, FONT_FAMILY, COLOR_PALETTE } from "./types";
import type { Bounds, Camera, DragAreaShape, ImageShape, Point, Shape } from "./types";
import { parseText } from "./markdown";

let nextId = 0;
export function generateId(): string {
  return `shape_${Date.now()}_${nextId++}`;
}

// Screen ↔ world mapping: screen = (camera.x, camera.y) + R(rotation) ·
// (zoom · world). Rotation is optional (two-finger rotate gesture) and
// both helpers keep the rotation-free fast path allocation-identical to
// the original.
export function screenToCanvas(screenPoint: Point, camera: Camera): Point {
  const sx = screenPoint.x - camera.x;
  const sy = screenPoint.y - camera.y;
  const rot = camera.rotation || 0;
  if (!rot) return { x: sx / camera.zoom, y: sy / camera.zoom };
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // Inverse rotation: R(-rot) · (screen - c), then unscale.
  return {
    x: (sx * cos + sy * sin) / camera.zoom,
    y: (-sx * sin + sy * cos) / camera.zoom,
  };
}

export function canvasToScreen(canvasPoint: Point, camera: Camera): Point {
  const zx = canvasPoint.x * camera.zoom;
  const zy = canvasPoint.y * camera.zoom;
  const rot = camera.rotation || 0;
  if (!rot) return { x: zx + camera.x, y: zy + camera.y };
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return {
    x: zx * cos - zy * sin + camera.x,
    y: zx * sin + zy * cos + camera.y,
  };
}

// === Bounds ===

export function getShapeBounds(shape: Shape, fontFamily?: string): Bounds {
  switch (shape.type) {
    case "draw":
      return getPointsBounds(shape.points);
    case "text":
      return getTextBounds(shape.position, shape.text, shape.fontSize, shape.width, fontFamily);
    case "image":
      return {
        minX: shape.position.x,
        minY: shape.position.y,
        maxX: shape.position.x + shape.width,
        maxY: shape.position.y + shape.height,
      };
    case "drag-area":
      return {
        minX: shape.position.x,
        minY: shape.position.y,
        maxX: shape.position.x + shape.width,
        maxY: shape.position.y + shape.height,
      };
  }
}

export function getPointsBounds(points: Point[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Offscreen canvas for accurate text measurement
let _measureCtx: CanvasRenderingContext2D | null = null;
export function getMeasureCtx(): CanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = document.createElement("canvas");
    _measureCtx = c.getContext("2d")!;
  }
  return _measureCtx;
}

export function measureTextWidth(text: string, fontSize: number, fontFamily?: string): number {
  const ctx = getMeasureCtx();
  ctx.font = `${fontSize}px ${fontFamily ? fontFamily + ", " + FONT_FAMILY : FONT_FAMILY}`;
  return ctx.measureText(text).width;
}

export function getTextBounds(
  position: Point,
  text: string,
  fontSize: number,
  constraintWidth?: number,
  fontFamily?: string,
): Bounds {
  const baseLineHeight = fontSize * LINE_HEIGHT_RATIO;
  const descenderPad = fontSize * 0.25;
  const ff = (fontFamily || "Inter") + ", " + FONT_FAMILY;

  const measure = (t: string, fs: number): number => {
    const ctx = getMeasureCtx();
    ctx.font = `${fs}px ${ff}`;
    return ctx.measureText(t).width;
  };

  // Use parseText (same as renderer) so line counts match exactly
  const parsedLines = parseText(
    text,
    constraintWidth && constraintWidth > 0 ? constraintWidth : undefined,
    fontSize,
    measure,
  );

  let height = 0;
  let maxWidth = 0;
  for (const line of parsedLines) {
    const lineFontSize = fontSize * line.sizeScale;
    height += lineFontSize * LINE_HEIGHT_RATIO;
    const lineText = line.runs.map((r) => r.text).join("");
    maxWidth = Math.max(maxWidth, measure(lineText, lineFontSize));
  }

  const w = constraintWidth && constraintWidth > 0 ? constraintWidth : Math.max(maxWidth, 20);
  return {
    minX: position.x,
    minY: position.y,
    maxX: position.x + w,
    maxY: position.y + Math.max(height + descenderPad, baseLineHeight + descenderPad),
  };
}

/** Word-wrap using accurate canvas text measurement */
export function wrapTextMeasured(text: string, maxWidth: number, fontSize: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) { result.push(""); continue; }
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (measureTextWidth(test, fontSize) > maxWidth && line.length > 0) {
        result.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) result.push(line);
  }
  return result.length > 0 ? result : [""];
}

/** Word-wrap text to fit within a pixel width (approximate, character-based) */
export function wrapText(text: string, maxWidth: number, charWidth: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
  const result: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      result.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (test.length > maxChars && line.length > 0) {
        result.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) result.push(line);
  }

  return result.length > 0 ? result : [""];
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

export function pointInBounds(
  point: Point,
  bounds: Bounds,
  padding = 8
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

// === Hit testing ===

export function hitTestShape(point: Point, shape: Shape, fontFamily?: string): boolean {
  if (shape.type === "draw") {
    return distanceToStroke(point, shape.points) < 12;
  }
  // Pass fontFamily so text bounds match the rendered size — otherwise
  // headings (parsed with sizeScale > 1) are hit-tested against bounds
  // measured with the wrong font, and the clickable area ends up smaller
  // than the rendered text.
  return pointInBounds(point, getShapeBounds(shape, fontFamily), 4);
}

export function distanceToStroke(point: Point, points: Point[]): number {
  let minDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distanceToSegment(point, points[i], points[i + 1]);
    if (d < minDist) minDist = d;
  }
  if (points.length === 1) {
    const dx = point.x - points[0].x;
    const dy = point.y - points[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  return minDist;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ex = p.x - projX;
  const ey = p.y - projY;
  return Math.sqrt(ex * ex + ey * ey);
}

// === Drag area helpers ===

export function findDragAreaAtPoint(
  point: Point,
  shapes: Shape[]
): DragAreaShape | null {
  // Search in reverse (topmost first), only drag areas
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === "drag-area" && pointInBounds(point, getShapeBounds(s), 0)) {
      return s;
    }
  }
  return null;
}

export function getChildrenOfDragArea(
  dragAreaId: string,
  shapes: Shape[]
): Shape[] {
  return shapes.filter((s) => s.parentId === dragAreaId);
}

export function resolveColor(colorName: string): string {
  return COLOR_PALETTE[colorName] || colorName;
}

// === Alignment ===

export function alignShapes(
  shapes: Shape[],
  direction: "left" | "center" | "right" | "top" | "middle" | "bottom"
): Shape[] {
  if (shapes.length < 2) return shapes;

  // Bucket shapes into units: each ungrouped shape is its own unit,
  // grouped shapes share a unit by groupId.
  const units: { shapes: Shape[]; bounds: Bounds }[] = [];
  const groupMap = new Map<string, Shape[]>();

  for (const s of shapes) {
    if (s.groupId) {
      let arr = groupMap.get(s.groupId);
      if (!arr) { arr = []; groupMap.set(s.groupId, arr); }
      arr.push(s);
    } else {
      units.push({ shapes: [s], bounds: getShapeBounds(s) });
    }
  }
  for (const members of groupMap.values()) {
    const allB = members.map((s) => getShapeBounds(s));
    const union: Bounds = {
      minX: Math.min(...allB.map((b) => b.minX)),
      minY: Math.min(...allB.map((b) => b.minY)),
      maxX: Math.max(...allB.map((b) => b.maxX)),
      maxY: Math.max(...allB.map((b) => b.maxY)),
    };
    units.push({ shapes: members, bounds: union });
  }

  if (units.length < 2) return shapes;

  let target: number;
  switch (direction) {
    case "left":   target = Math.min(...units.map((u) => u.bounds.minX)); break;
    case "right":  target = Math.max(...units.map((u) => u.bounds.maxX)); break;
    case "top":    target = Math.min(...units.map((u) => u.bounds.minY)); break;
    case "bottom": target = Math.max(...units.map((u) => u.bounds.maxY)); break;
    case "center":
      target = (Math.min(...units.map((u) => u.bounds.minX)) + Math.max(...units.map((u) => u.bounds.maxX))) / 2;
      break;
    case "middle":
      target = (Math.min(...units.map((u) => u.bounds.minY)) + Math.max(...units.map((u) => u.bounds.maxY))) / 2;
      break;
  }

  // Build a map of shape id → delta
  const deltaMap = new Map<string, { dx: number; dy: number }>();
  for (const unit of units) {
    const b = unit.bounds;
    let dx = 0, dy = 0;
    switch (direction) {
      case "left":   dx = target - b.minX; break;
      case "right":  dx = target - b.maxX; break;
      case "center": dx = target - (b.minX + b.maxX) / 2; break;
      case "top":    dy = target - b.minY; break;
      case "bottom": dy = target - b.maxY; break;
      case "middle": dy = target - (b.minY + b.maxY) / 2; break;
    }
    for (const s of unit.shapes) {
      deltaMap.set(s.id, { dx, dy });
    }
  }

  return shapes.map((s) => {
    const d = deltaMap.get(s.id);
    if (!d || (d.dx === 0 && d.dy === 0)) return s;
    return shiftShape({ ...s }, d.dx, d.dy);
  });
}

export function distributeShapes(
  shapes: Shape[],
  axis: "horizontal" | "vertical",
): Shape[] {
  if (shapes.length < 3) return shapes;

  // Bucket shapes into units (same logic as alignShapes).
  const units: { shapes: Shape[]; bounds: Bounds }[] = [];
  const groupMap = new Map<string, Shape[]>();

  for (const s of shapes) {
    if (s.groupId) {
      let arr = groupMap.get(s.groupId);
      if (!arr) { arr = []; groupMap.set(s.groupId, arr); }
      arr.push(s);
    } else {
      units.push({ shapes: [s], bounds: getShapeBounds(s) });
    }
  }
  for (const members of groupMap.values()) {
    const allB = members.map((s) => getShapeBounds(s));
    const union: Bounds = {
      minX: Math.min(...allB.map((b) => b.minX)),
      minY: Math.min(...allB.map((b) => b.minY)),
      maxX: Math.max(...allB.map((b) => b.maxX)),
      maxY: Math.max(...allB.map((b) => b.maxY)),
    };
    units.push({ shapes: members, bounds: union });
  }

  if (units.length < 3) return shapes;

  // Build a map of shape id → delta
  const deltaMap = new Map<string, { dx: number; dy: number }>();

  if (axis === "horizontal") {
    units.sort((a, b) => a.bounds.minX - b.bounds.minX);
    const totalSpan = units[units.length - 1].bounds.maxX - units[0].bounds.minX;
    const totalWidths = units.reduce((sum, u) => sum + (u.bounds.maxX - u.bounds.minX), 0);
    const gap = (totalSpan - totalWidths) / (units.length - 1);
    let x = units[0].bounds.minX;
    for (const unit of units) {
      const dx = x - unit.bounds.minX;
      for (const s of unit.shapes) {
        deltaMap.set(s.id, { dx, dy: 0 });
      }
      x += (unit.bounds.maxX - unit.bounds.minX) + gap;
    }
  } else {
    units.sort((a, b) => a.bounds.minY - b.bounds.minY);
    const totalSpan = units[units.length - 1].bounds.maxY - units[0].bounds.minY;
    const totalHeights = units.reduce((sum, u) => sum + (u.bounds.maxY - u.bounds.minY), 0);
    const gap = (totalSpan - totalHeights) / (units.length - 1);
    let y = units[0].bounds.minY;
    for (const unit of units) {
      const dy = y - unit.bounds.minY;
      for (const s of unit.shapes) {
        deltaMap.set(s.id, { dx: 0, dy });
      }
      y += (unit.bounds.maxY - unit.bounds.minY) + gap;
    }
  }

  return shapes.map((s) => {
    const d = deltaMap.get(s.id);
    if (!d || (d.dx === 0 && d.dy === 0)) return s;
    return shiftShape({ ...s }, d.dx, d.dy);
  });
}

/** Lay the supplied shapes out in an evenly-spaced grid centred on
 *  `centerPoint` (defaulting to the centroid of the shapes' current
 *  bounding box). Groups are treated as one cell unit — every member
 *  of a `groupId` shares one cell and translates by the same delta so
 *  the cluster stays intact. Cell dimensions size to the widest /
 *  tallest unit (group bounds union, or ungrouped shape bounds) so
 *  nothing overflows. Grid shape defaults to as-square-as-possible
 *  (`cols = ceil(sqrt(n))`) unless `cols` is supplied explicitly;
 *  reading order (top→bottom, left→right) is preserved so the
 *  post-arrange layout matches the user's mental map. */
export function arrangeShapesAsGrid(
  shapes: Shape[],
  fontFamily?: string,
  gap: number = 20,
  centerPoint?: Point,
  cols?: number,
): Shape[] {
  if (shapes.length < 2) return shapes;

  // Bucket shapes into units. A unit is either one ungrouped shape or
  // every member of one groupId — both treated as a single cell.
  type Unit = { ids: string[]; bounds: Bounds };
  const groupBuckets = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const s of shapes) {
    if (s.groupId) {
      let bucket = groupBuckets.get(s.groupId);
      if (!bucket) { bucket = []; groupBuckets.set(s.groupId, bucket); }
      bucket.push(s.id);
    } else {
      ungrouped.push(s.id);
    }
  }
  const shapeById = new Map(shapes.map((s) => [s.id, s]));
  // Desktop file thumbnails carry a hover label strip just below the
  // image — reserve it in the cell measurement so grid rows don't butt
  // the next thumbnail up against a label.
  const FILE_LABEL_ALLOWANCE = 28;
  function unionBounds(ids: string[]): Bounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const s = shapeById.get(id);
      if (!s) continue;
      const b = getShapeBounds(s, fontFamily);
      const labelPad = s.type === "image" && (s as ImageShape).fileRef ? FILE_LABEL_ALLOWANCE : 0;
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY + labelPad > maxY) maxY = b.maxY + labelPad;
    }
    return { minX, minY, maxX, maxY };
  }
  const units: Unit[] = [];
  for (const id of ungrouped) units.push({ ids: [id], bounds: unionBounds([id]) });
  for (const ids of groupBuckets.values()) units.push({ ids, bounds: unionBounds(ids) });

  // Single-unit selection (e.g. drag-area holding one big group) has
  // nothing to arrange — return the shapes untouched.
  if (units.length < 2) return shapes;

  let selMinX = Infinity, selMinY = Infinity, selMaxX = -Infinity, selMaxY = -Infinity;
  let cellW = 0, cellH = 0;
  for (const u of units) {
    if (u.bounds.minX < selMinX) selMinX = u.bounds.minX;
    if (u.bounds.minY < selMinY) selMinY = u.bounds.minY;
    if (u.bounds.maxX > selMaxX) selMaxX = u.bounds.maxX;
    if (u.bounds.maxY > selMaxY) selMaxY = u.bounds.maxY;
    cellW = Math.max(cellW, u.bounds.maxX - u.bounds.minX);
    cellH = Math.max(cellH, u.bounds.maxY - u.bounds.minY);
  }
  const centerX = centerPoint ? centerPoint.x : (selMinX + selMaxX) / 2;
  const centerY = centerPoint ? centerPoint.y : (selMinY + selMaxY) / 2;

  // Sort units by current reading order — row-band grouping uses ~60%
  // of the tallest cell as the band tolerance so slightly-misaligned
  // rows still read as one row, then left-to-right inside each band.
  const tolerance = Math.max(cellH * 0.6, 1);
  units.sort((a, b) => {
    const dy = a.bounds.minY - b.bounds.minY;
    if (Math.abs(dy) > tolerance) return dy;
    return a.bounds.minX - b.bounds.minX;
  });

  const n = units.length;
  const colCount = Math.max(1, Math.min(n, cols ?? Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / colCount);

  const totalW = colCount * cellW + (colCount - 1) * gap;
  const totalH = rows * cellH + (rows - 1) * gap;
  const startX = centerX - totalW / 2;
  const startY = centerY - totalH / 2;

  const deltas = new Map<string, { dx: number; dy: number }>();
  units.forEach((u, idx) => {
    const col = idx % colCount;
    const row = Math.floor(idx / colCount);
    const cellCx = startX + col * (cellW + gap) + cellW / 2;
    const cellCy = startY + row * (cellH + gap) + cellH / 2;
    const currCx = (u.bounds.minX + u.bounds.maxX) / 2;
    const currCy = (u.bounds.minY + u.bounds.maxY) / 2;
    const dx = cellCx - currCx;
    const dy = cellCy - currCy;
    for (const id of u.ids) deltas.set(id, { dx, dy });
  });

  return shapes.map((s) => {
    const d = deltas.get(s.id);
    if (!d || (d.dx === 0 && d.dy === 0)) return s;
    return shiftShape(s, d.dx, d.dy);
  });
}

function shiftShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "draw":
      return {
        ...shape,
        points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy, pressure: p.pressure, t: p.t })),
      };
    case "text":
    case "image":
    case "drag-area":
      return {
        ...shape,
        position: {
          x: shape.position.x + dx,
          y: shape.position.y + dy,
        },
      };
  }
}

// === Pocket ===

/** Width of the pocket drop zone, measured inward from the shelf edge. */
export const POCKET_ZONE_WIDTH = 80;

/** Width of the visible pocket tray strip pinned to the shelf edge. */
export const POCKET_TRAY_WIDTH = 20;

export interface PocketEntry {
  shapes: Shape[];
  offsetX: number;
  offsetY: number;
  scale: number;
  screenBounds: Bounds;
}

export interface PocketLayout {
  entries: PocketEntry[];
  pocketedIds: Set<string>;
}

/**
 * Compute screen-space layout for pocketed shapes, stacked vertically on
 * the right (just inboard of the shelf). Groups shapes by groupId and
 * includes children of pocketed drag areas.
 *
 * `canvasWidth` is the visible canvas width and `rightInset` is the
 * shelf's pixel footprint — the tray sits flush against `canvasWidth -
 * rightInset`, so an open shelf nudges the cards inward to stay clear.
 */
export function computePocketLayout(allShapes: Shape[], canvasWidth: number, fontFamily?: string, rightInset = 0): PocketLayout {
  const pocketed = allShapes.filter((s) => s.pocketed);
  if (pocketed.length === 0) return { entries: [], pocketedIds: new Set() };

  const groups: Shape[][] = [];
  const seen = new Set<string>();

  for (const s of pocketed) {
    if (seen.has(s.id)) continue;
    const group: Shape[] = [];

    if (s.groupId) {
      for (const ps of pocketed) {
        if (ps.groupId === s.groupId && !seen.has(ps.id)) {
          seen.add(ps.id);
          group.push(ps);
        }
      }
    } else {
      seen.add(s.id);
      group.push(s);
    }

    // Include children of pocketed drag areas
    const dragAreaIds = new Set(group.filter((g) => g.type === "drag-area").map((g) => g.id));
    for (const child of allShapes) {
      if (child.parentId && dragAreaIds.has(child.parentId) && !seen.has(child.id)) {
        seen.add(child.id);
        group.push(child);
      }
    }

    groups.push(group);
  }

  const MARGIN_RIGHT = 4;
  const MARGIN_TOP = 60;
  const GAP = 16;
  const MAX_SIZE = 140;
  let y = MARGIN_TOP;

  // Tray sits flush against the shelf's left edge. Cards sit just to
  // the left of the tray strip with a small breathing margin.
  const shelfEdge = canvasWidth - rightInset;
  const cardRightAnchor = shelfEdge - POCKET_TRAY_WIDTH - MARGIN_RIGHT;

  const entries: PocketEntry[] = [];
  const pocketedIds = new Set(seen);

  for (const group of groups) {
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    for (const s of group) {
      const b = getShapeBounds(s, fontFamily);
      gMinX = Math.min(gMinX, b.minX);
      gMinY = Math.min(gMinY, b.minY);
      gMaxX = Math.max(gMaxX, b.maxX);
      gMaxY = Math.max(gMaxY, b.maxY);
    }

    const width = gMaxX - gMinX;
    const height = gMaxY - gMinY;

    const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
    const sw = width * scale;
    const sh = height * scale;

    // Anchor card's right edge against `cardRightAnchor` so the cluster
    // hangs off the shelf side. Left edge is derived from the scaled width.
    const x = cardRightAnchor - sw;

    entries.push({
      shapes: group,
      offsetX: x - gMinX * scale,
      offsetY: y - gMinY * scale,
      scale,
      screenBounds: { minX: x, minY: y, maxX: x + sw, maxY: y + sh },
    });

    y += sh + GAP;
  }

  return { entries, pocketedIds };
}
