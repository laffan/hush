import { FONT_FAMILY, LINE_HEIGHT_RATIO, COLOR_PALETTE } from "./types";
import type { Camera, DragAreaShape, ImageShape, Layer, Point, SelectionBox, Shape, TextShape } from "./types";
import type { CanvasTheme } from "./themes";
import { computePocketLayout, getShapeBounds, POCKET_ZONE_WIDTH, POCKET_TRAY_WIDTH } from "./utils";
import type { PocketEntry } from "./utils";
import { parseText } from "./markdown";
import { drawSelectionHighlight, drawStrokeBoundsHighlight, drawGroupHighlight, drawSelectionBox, drawCropOverlay } from "./renderer-selection";
import { drawBackground } from "./renderer-background";

export interface RenderState {
  shapes: Shape[];
  selectedIds: Set<string>;
  camera: Camera;
  selectionBox: SelectionBox | null;
  creatingDragArea: { start: Point; end: Point } | null;
  editingShapeId: string | null;
  imageCache: Map<string, HTMLImageElement>;
  theme: CanvasTheme;
  croppingImageId: string | null;
  backgroundPattern: "grid" | "dot-grid" | "blank";
  gridSpacing: number;
  gridOpacity: number;
  fontFamily: string;
  isDragging: boolean;
  // Proximity-based pocket reveal. 0 = tray hidden, 1 = cursor inside zone.
  pocketProximity?: number;
  // True while the drag cursor sits inside the pocket drop zone.
  pocketInZone?: boolean;
  leftInset: number;
  /** Layer list, top-first. Used to iterate shapes in layer order
   *  and skip shapes on hidden layers. Optional: falls back to
   *  single-pass iteration when absent (tests, legacy callers). */
  layers?: Layer[];
  /** Style override for the canvas background. Empty / unset falls
   *  back to `theme.canvasBackground`. */
  canvasBackgroundOverride?: string;
  /** Optional drawing-layer handle. When present the pocket / shelf
   *  thumbnail paths blit grouped-drawing regions directly from the
   *  done canvas instead of re-stamping strokes per-frame. */
  drawingLayer?: {
    blitWorldRegion(
      ctx: CanvasRenderingContext2D,
      worldBbox: { minX: number; minY: number; maxX: number; maxY: number },
    ): void;
  };
  /** Device pixel ratio. Injected by the caller (notes-canvas.ts reads
   *  `window.devicePixelRatio`) so this module stays free of global
   *  reads — it only needs to render. */
  dpr?: number;
}

/** Paint shapes + (optional) background into an arbitrary ctx at an
 *  arbitrary camera. Skips every piece of editor chrome — selection
 *  highlights, creating-drag-area preview, selection box, pocket tray,
 *  pocketed cards. Used by the notebook export path. The caller owns
 *  the ctx's base transform; `outWidth`/`outHeight` describe the
 *  target surface in CSS pixels (before DPR scaling, which the caller
 *  has already applied via setTransform if desired). Drawing strokes
 *  are NOT painted here — the export path blits them from the drawing
 *  layer's done canvas afterwards. */
export function renderForExport(
  ctx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
  opts: {
    shapes: Shape[];
    camera: Camera;
    imageCache: Map<string, HTMLImageElement>;
    theme: CanvasTheme;
    backgroundPattern: "grid" | "dot-grid" | "blank";
    gridSpacing: number;
    gridOpacity: number;
    fontFamily: string;
    layers?: Layer[];
    includeBackground: boolean;
    canvasBackgroundOverride?: string;
  },
): void {
  const { shapes, camera, imageCache, theme, backgroundPattern, gridSpacing, gridOpacity, fontFamily, layers, includeBackground, canvasBackgroundOverride } = opts;

  if (includeBackground) {
    ctx.fillStyle = canvasBackgroundOverride || theme.canvasBackground;
    ctx.fillRect(0, 0, outWidth, outHeight);
    if (backgroundPattern !== "blank" && gridOpacity > 0) {
      drawBackground(ctx, camera, outWidth, outHeight, theme.foreground, backgroundPattern, gridSpacing, gridOpacity * 0.8);
    }
  }

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  // Same layer-ordering logic as the live render path, minus pocket /
  // selection / in-flight creation chrome.
  const layerOrder: { id: string; hidden: boolean }[] = layers && layers.length
    ? [...layers].reverse().map((l) => ({ id: l.id, hidden: l.hidden }))
    : [{ id: "__single__", hidden: false }];
  const shapesByLayer = new Map<string, Shape[]>();
  for (const l of layerOrder) shapesByLayer.set(l.id, []);
  for (const s of shapes) {
    if (s.pocketed) continue; // pocketed shapes never appear in an export
    const bucketId = layers && layers.length ? (s.layerId || layerOrder[layerOrder.length - 1].id) : "__single__";
    const bucket = shapesByLayer.get(bucketId) || shapesByLayer.get(layerOrder[layerOrder.length - 1].id);
    if (bucket) bucket.push(s);
  }

  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") drawDragArea(ctx, shape);
    }
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") continue;
      if (shape.type === "draw") continue; // drawing layer handled separately
      if (shape.type === "text") drawTextShape(ctx, shape, theme, fontFamily);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, false);
    }
  }

  ctx.restore();
}

export function render(canvas: HTMLCanvasElement, state: RenderState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = state.dpr ?? 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const { camera, shapes, selectedIds, selectionBox, creatingDragArea, editingShapeId, imageCache, theme, backgroundPattern, gridSpacing, gridOpacity, canvasBackgroundOverride } = state;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = canvasBackgroundOverride || theme.canvasBackground;
  ctx.fillRect(0, 0, w, h);

  if (backgroundPattern !== "blank" && gridOpacity > 0) {
    // Use foreground color at scaled opacity (100% slider = 80% alpha of foreground)
    drawBackground(ctx, camera, w, h, theme.foreground, backgroundPattern, gridSpacing, gridOpacity * 0.8);
  }

  // Compute pocket layout once for this frame. While the user is dragging
  // into the pocket zone, treat the selected shapes as already pocketed so
  // they render in pocket-card style mid-drag.
  const effectiveShapes = state.pocketInZone && selectedIds.size > 0
    ? shapes.map((s) => selectedIds.has(s.id) ? { ...s, pocketed: true } : s)
    : shapes;
  const pocketLayout = computePocketLayout(effectiveShapes, w, state.fontFamily);
  const pocketedIds = pocketLayout.pocketedIds;

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  // Build layer order (bottom-first for paint order). If no layers
  // were provided, fall back to a single synthetic layer that contains
  // every shape — same visual result as the pre-layers behavior.
  const layerOrder: { id: string; hidden: boolean }[] = state.layers && state.layers.length
    ? [...state.layers].reverse().map((l) => ({ id: l.id, hidden: l.hidden }))
    : [{ id: "__single__", hidden: false }];
  const shapesByLayer = new Map<string, Shape[]>();
  for (const l of layerOrder) shapesByLayer.set(l.id, []);
  for (const s of shapes) {
    const bucketId = state.layers && state.layers.length ? (s.layerId || layerOrder[layerOrder.length - 1].id) : "__single__";
    const bucket = shapesByLayer.get(bucketId) || shapesByLayer.get(layerOrder[layerOrder.length - 1].id);
    if (bucket) bucket.push(s);
  }

  // Paint each visible layer bottom-first. Within a layer, drag-areas
  // render behind their contents; drawings are handled by the
  // drawing-layer canvas and intentionally skipped here.
  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area" && !pocketedIds.has(shape.id)) drawDragArea(ctx, shape);
    }
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") continue;
      if (shape.id === editingShapeId) continue;
      if (pocketedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue; // drawing layer owns strokes
      if (shape.type === "text") drawTextShape(ctx, shape, theme, state.fontFamily);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, shape.id === state.croppingImageId);
    }
  }

  if (creatingDragArea) {
    const { start, end } = creatingDragArea;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const rw = Math.abs(end.x - start.x);
    const rh = Math.abs(end.y - start.y);
    ctx.save();
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.fillStyle = "rgba(107, 114, 128, 0.08)";
    ctx.beginPath();
    roundRect(ctx, x, y, rw, rh, 12);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (selectedIds.size > 0) {
    // Draw group bounding boxes first (behind individual highlights)
    const groupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const shape of shapes) {
      if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id) || !shape.groupId) continue;
      const b = getShapeBounds(shape, state.fontFamily);
      const existing = groupBounds.get(shape.groupId);
      if (existing) {
        existing.minX = Math.min(existing.minX, b.minX);
        existing.minY = Math.min(existing.minY, b.minY);
        existing.maxX = Math.max(existing.maxX, b.maxX);
        existing.maxY = Math.max(existing.maxY, b.maxY);
      } else {
        groupBounds.set(shape.groupId, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      }
    }
    for (const bounds of groupBounds.values()) {
      drawGroupHighlight(ctx, bounds, camera.zoom, theme.accent);
    }

    // Strokes never get per-stroke resize handles — the drawing engine
    // owns their transform, so a handled highlight from the canvas
    // renderer is non-functional chrome. When more than one stroke is
    // selected outside a named group, collapse them into a single
    // combined dashed bbox so the user sees "one selection" instead of
    // a field of individual stroke boxes.
    const looseStrokes: Shape[] = [];
    for (const shape of shapes) {
      if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id)) continue;
      if (shape.type !== "draw") continue;
      if (shape.groupId && groupBounds.has(shape.groupId)) continue;
      looseStrokes.push(shape);
    }
    if (looseStrokes.length >= 2) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of looseStrokes) {
        const b = getShapeBounds(s, state.fontFamily);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      drawGroupHighlight(ctx, { minX, minY, maxX, maxY }, camera.zoom, theme.accent);
    } else if (looseStrokes.length === 1) {
      drawStrokeBoundsHighlight(ctx, looseStrokes[0], camera.zoom, theme.accent, state.fontFamily);
    }

    for (const shape of shapes) {
      if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue; // handled above (group or loose-stroke bbox)
      if (shape.id === state.croppingImageId && shape.type === "image") {
        drawCropOverlay(ctx, shape, camera.zoom);
      } else {
        drawSelectionHighlight(ctx, shape, camera.zoom, theme.accent, state.fontFamily);
      }
    }
  }

  ctx.restore();

  // Draw pocket tray on left edge, offset by sidebar inset.
  // Proximity-based glow: tray fades in as the drag cursor approaches the
  // pocket zone. Fully visible inside the zone.
  const hasPocketed = pocketLayout.entries.length > 0;
  const leftInset = state.leftInset || 0;
  const proximity = state.pocketProximity ?? (state.isDragging ? 1 : 0);
  if (hasPocketed || proximity > 0) {
    drawPocketTray(ctx, w, h, state.isDragging, hasPocketed, leftInset, proximity);
  }

  // Draw pocketed shapes at fixed screen positions, offset by sidebar inset.
  // Also includes the in-flight selected shapes when the cursor is in the
  // zone (via effectiveShapes above).
  if (pocketLayout.entries.length > 0) {
    ctx.save();
    ctx.translate(leftInset, 0);
    drawPocketEntries(ctx, pocketLayout.entries, selectedIds, theme, state.fontFamily, imageCache, state.drawingLayer);
    ctx.restore();
  }

  if (selectionBox) drawSelectionBox(ctx, selectionBox, camera);
}

// === Draw helpers (pure Canvas 2D — no framework dependencies) ===

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawDragArea(ctx: CanvasRenderingContext2D, shape: DragAreaShape) {
  const { position, width, height, strokeColor, backgroundColor, borderRadius } = shape;
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.fillStyle = backgroundColor;
  ctx.beginPath();
  roundRect(ctx, position.x, position.y, width, height, borderRadius);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawTextShape(ctx: CanvasRenderingContext2D, shape: TextShape, theme: CanvasTheme, fontFamily: string) {
  const baseFontSize = shape.fontSize;
  const ff = `${fontFamily}, ${FONT_FAMILY}`;

  // Measure function using the render context for accurate width
  const measure = (text: string, fontSize: number): number => {
    ctx.font = `${fontSize}px ${ff}`;
    return ctx.measureText(text).width;
  };

  // Parse markdown into styled lines
  const parsedLines = parseText(
    shape.text,
    shape.width && shape.width > 0 ? shape.width : undefined,
    baseFontSize,
    measure,
  );

  // Resolve text color: use theme foreground if shape uses default black
  const isDefaultColor = shape.color === "#000000";
  const textColor = isDefaultColor ? theme.foreground : shape.color;
  const headingColor = isDefaultColor ? theme.headingColor : shape.color;

  // Draw background if set
  if (shape.backgroundColor) {
    const hex = COLOR_PALETTE[shape.backgroundColor] || shape.backgroundColor;
    const bounds = getShapeBounds(shape, fontFamily);
    const pad = 4;
    ctx.save();
    ctx.fillStyle = hex;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(bounds.minX - pad, bounds.minY - pad, bounds.maxX - bounds.minX + pad * 2, bounds.maxY - bounds.minY + pad * 2);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  ctx.save();
  ctx.textBaseline = "top";

  // Per-line indentation for blockquotes and tasks. A blockquote adds
  // a fixed gutter that hosts the left rule; a task line adds a
  // checkbox-width gutter. Both can stack ("> - [ ] item"), but we
  // render whichever is more prominent first.
  const BLOCKQUOTE_GUTTER = baseFontSize * 0.9;     // padding-left
  const BLOCKQUOTE_BORDER = 2;                       // px width of the rule
  const CHECKBOX_SIZE = baseFontSize * 0.85;
  const CHECKBOX_GAP = baseFontSize * 0.4;

  let y = shape.position.y;
  for (const line of parsedLines) {
    const lineScale = line.sizeScale;
    const lineFontSize = baseFontSize * lineScale;
    const lineH = lineFontSize * LINE_HEIGHT_RATIO;
    const isHeading = lineScale > 1;
    let x = shape.position.x;

    if (line.blockquote) {
      // 50% opacity left rule using the text colour. Hex strings
      // become rgba via a quick parse; non-hex falls back to a
      // neutral colour-mix-equivalent.
      ctx.save();
      ctx.fillStyle = textColor;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, y, BLOCKQUOTE_BORDER, lineH);
      ctx.globalAlpha = 1;
      ctx.restore();
      x += BLOCKQUOTE_GUTTER;
    }

    if (line.task !== undefined) {
      // Reserve a checkbox-sized gutter on every task-related line
      // (first or continuation). Only the first line draws the box.
      if (line.task) {
        const cy = y + (lineFontSize - CHECKBOX_SIZE) / 2;
        ctx.save();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;
        ctx.strokeRect(x, cy, CHECKBOX_SIZE, CHECKBOX_SIZE);
        if (line.taskChecked) {
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = textColor;
          // Tick: two strokes meeting at a 45° corner.
          ctx.beginPath();
          ctx.moveTo(x + CHECKBOX_SIZE * 0.22, cy + CHECKBOX_SIZE * 0.55);
          ctx.lineTo(x + CHECKBOX_SIZE * 0.42, cy + CHECKBOX_SIZE * 0.78);
          ctx.lineTo(x + CHECKBOX_SIZE * 0.82, cy + CHECKBOX_SIZE * 0.25);
          ctx.lineWidth = 2;
          ctx.strokeStyle = textColor;
          ctx.stroke();
        }
        ctx.restore();
      }
      x += CHECKBOX_SIZE + CHECKBOX_GAP;
    }

    ctx.fillStyle = isHeading ? headingColor : textColor;

    for (const run of line.runs) {
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      const fontSize = baseFontSize * run.sizeScale;
      ctx.font = `${style} ${weight} ${fontSize}px ${ff}`;
      if (run.highlight) {
        ctx.save();
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x, y, ctx.measureText(run.text).width, fontSize + 2);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      if (run.link) ctx.fillStyle = theme.accent;
      else ctx.fillStyle = isHeading ? headingColor : textColor;
      ctx.fillText(run.text, x, y);
      const runW = ctx.measureText(run.text).width;
      if (run.link) {
        ctx.beginPath();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1;
        ctx.moveTo(x, y + fontSize + 1);
        ctx.lineTo(x + runW, y + fontSize + 1);
        ctx.stroke();
      }
      x += runW;
    }

    y += lineH;
  }
  ctx.restore();
}

function drawImageShape(ctx: CanvasRenderingContext2D, shape: ImageShape, imageCache: Map<string, HTMLImageElement>, isCropping?: boolean) {
  const img = imageCache.get(shape.id);
  if (img && img.complete) {
    const c = shape.crop || { x: 0, y: 0, w: 1, h: 1 };
    if (isCropping) {
      // Show the full image at 50% opacity behind the crop
      const fullW = shape.width / c.w, fullH = shape.height / c.h;
      const fullX = shape.position.x - c.x * fullW, fullY = shape.position.y - c.y * fullH;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(img, fullX, fullY, fullW, fullH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    const sx = c.x * img.naturalWidth, sy = c.y * img.naturalHeight;
    const sw = c.w * img.naturalWidth, sh = c.h * img.naturalHeight;
    ctx.drawImage(img, sx, sy, sw, sh, shape.position.x, shape.position.y, shape.width, shape.height);
  } else {
    ctx.save();
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.strokeRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shape.name || "Image", shape.position.x + shape.width / 2, shape.position.y + shape.height / 2);
    ctx.restore();
  }
  ctx.restore();
}

const POCKET_BLUE = "rgba(66, 153, 225, 0.18)";
const POCKET_BLUE_HIGHLIGHT = "rgba(66, 153, 225, 0.30)";

function drawPocketTray(
  ctx: CanvasRenderingContext2D, _w: number, h: number,
  isDragging: boolean, hasPocketed: boolean, leftInset = 0,
  proximity = 0,
) {
  ctx.save();
  const x = leftInset;
  // While dragging, the tray fades in with proximity (0 when far, 0.5 over
  // the pocket itself). Outside of drags, use the idle/hasPocketed treatment.
  if (isDragging) {
    ctx.globalAlpha = 0.5 * proximity;
    ctx.fillStyle = POCKET_BLUE;
    ctx.fillRect(x, 0, POCKET_TRAY_WIDTH, h);
  } else {
    ctx.fillStyle = POCKET_BLUE;
    ctx.fillRect(x, 0, POCKET_TRAY_WIDTH, h);
    if (hasPocketed) {
      const gradient = ctx.createLinearGradient(x + POCKET_TRAY_WIDTH, 0, x + POCKET_TRAY_WIDTH + 6, 0);
      gradient.addColorStop(0, "rgba(66, 153, 225, 0.06)");
      gradient.addColorStop(1, "transparent");
      ctx.fillStyle = gradient;
      ctx.fillRect(x + POCKET_TRAY_WIDTH, 0, 6, h);
    }
  }
  ctx.restore();
}

function drawPocketEntries(
  ctx: CanvasRenderingContext2D, entries: PocketEntry[], selectedIds: Set<string>,
  theme: CanvasTheme, fontFamily: string, imageCache: Map<string, HTMLImageElement>,
  drawingLayer?: RenderState["drawingLayer"],
) {
  for (const entry of entries) {
    const b = entry.screenBounds;
    const pad = 6;

    // Light blue card background
    ctx.save();
    ctx.fillStyle = POCKET_BLUE;
    ctx.shadowColor = "rgba(0,0,0,0.08)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    roundRect(ctx, b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2, 6);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(66, 153, 225, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Draw shapes with offset + scale transform
    ctx.save();
    ctx.translate(entry.offsetX, entry.offsetY);
    if (entry.scale !== 1) ctx.scale(entry.scale, entry.scale);
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") drawDragArea(ctx, shape);
    }
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") continue;
      if (shape.type === "text") drawTextShape(ctx, shape, theme, fontFamily);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, false);
      // DrawShapes are handled in one pass below — we blit the whole
      // group's world bbox from the done canvas at once instead of
      // re-stamping strokes per-frame.
    }
    // Grouped drawings: one drawImage from the drawing layer's done
    // canvas per entry. Cheap (single blit) and pixel-accurate.
    if (drawingLayer) {
      const drawShapesInEntry: Shape[] = [];
      for (const shape of entry.shapes) {
        if (shape.type === "draw") drawShapesInEntry.push(shape);
      }
      if (drawShapesInEntry.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of drawShapesInEntry) {
          const b = getShapeBounds(s, fontFamily);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
        }
        drawingLayer.blitWorldRegion(ctx, { minX, minY, maxX, maxY });
      }
    }
    // Selection highlights for pocketed shapes. Accumulate group
    // bounds first (for grouped selections), then draw per-shape
    // highlights for anything not in a selected-group — DrawShapes
    // in a selected group don't get per-stroke boxes on top of the
    // group bbox (matches main-canvas behavior).
    const pocketGroupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const shape of entry.shapes) {
      if (!selectedIds.has(shape.id) || !shape.groupId) continue;
      const b = getShapeBounds(shape, fontFamily);
      const existing = pocketGroupBounds.get(shape.groupId);
      if (existing) {
        existing.minX = Math.min(existing.minX, b.minX);
        existing.minY = Math.min(existing.minY, b.minY);
        existing.maxX = Math.max(existing.maxX, b.maxX);
        existing.maxY = Math.max(existing.maxY, b.maxY);
      } else {
        pocketGroupBounds.set(shape.groupId, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      }
    }
    for (const bounds of pocketGroupBounds.values()) {
      drawGroupHighlight(ctx, bounds, 1 / entry.scale, theme.accent);
    }
    for (const shape of entry.shapes) {
      if (!selectedIds.has(shape.id)) continue;
      if (shape.type === "draw" && shape.groupId && pocketGroupBounds.has(shape.groupId)) continue;
      drawSelectionHighlight(ctx, shape, 1 / entry.scale, theme.accent, fontFamily);
    }
    ctx.restore();
  }
}

