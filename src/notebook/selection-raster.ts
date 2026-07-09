/**
 * Selection rasterizer.
 *
 * Renders an arbitrary set of shapes (a selection, a group, a
 * drag-area with its contents) into an offscreen canvas at 2× scale.
 * Two consumers:
 *
 *   - "Rasterize group" on the selection toolbar — the raster replaces
 *     the shapes with a single ImageShape sized to the original
 *     bounding box (so the 2× pixels display scaled back down, crisp
 *     on HiDPI).
 *   - Handwriting recognition — the raster of a stroke selection is
 *     handed to the recognition engine (src/recognition/) which runs
 *     it through Apple's Vision framework on the Rust side.
 *
 * The pipeline mirrors notebook-export.ts: `renderForExport()` paints
 * text / image / drag-area shapes, then the drawing layer re-renders
 * the selected strokes on top via `renderStrokesTo()` — per-stroke, so
 * unselected strokes overlapping the same region never leak in.
 */

import type { DrawingState } from "./state";
import type { DrawingLayer } from "./drawing/drawing-layer-types";
import type { Bounds, Shape } from "./types";
import { renderForExport } from "./renderer-export";
import { getShapeBounds } from "./utils";

export const RASTER_SCALE = 2;

export interface RasterSource {
  state: DrawingState;
  imageCache: Map<string, HTMLImageElement>;
  drawingLayer: DrawingLayer | null;
}

export interface SelectionRaster {
  canvas: HTMLCanvasElement;
  /** World-space bounds the raster covers (content bbox + pad). */
  bounds: Bounds;
}

/** Expand a selection to everything the raster should swallow: the
 *  selected shapes plus, for any selected drag-area, its transitive
 *  children — rasterizing a container captures its contents. Returned
 *  in `state.shapes` order so z-stacking is preserved. */
export function collectRasterShapes(state: DrawingState): Shape[] {
  const ids = new Set(state.selectedIds);
  if (!ids.size) return [];
  // Transitive parentId closure (drag-areas can nest).
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of state.shapes) {
      if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return state.shapes.filter((s) => ids.has(s.id) && !s.pocketed);
}

/** Union bbox of the given shapes, padded so soft stroke edges aren't
 *  clipped (stroke bounds come from raw points; stamps extend ~size/2
 *  past them). */
export function rasterBounds(shapes: Shape[], fontFamily: string): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let pad = 2;
  for (const s of shapes) {
    const b = getShapeBounds(s, fontFamily);
    if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    if (s.type === "draw") pad = Math.max(pad, s.size / 2 + 2);
  }
  if (minX === Infinity) return null;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/**
 * Render `shapes` into an offscreen canvas at RASTER_SCALE.
 *
 * `includeBackground` fills the theme canvas colour first — used by
 * the recognition path so strokes always sit on their intended
 * background (an "auto" white stroke on a dark theme stays legible).
 * The rasterize-group path leaves it transparent so the canvas
 * background shows through the resulting ImageShape.
 */
export function rasterizeShapes(
  source: RasterSource,
  shapes: Shape[],
  opts: { includeBackground: boolean },
): SelectionRaster | null {
  const { state, imageCache, drawingLayer } = source;
  if (!shapes.length) return null;
  const bounds = rasterBounds(shapes, state.fontFamily);
  if (!bounds) return null;

  const cssW = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
  const cssH = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
  const camera = { x: -bounds.minX, y: -bounds.minY, zoom: 1 };

  const out = document.createElement("canvas");
  out.width = cssW * RASTER_SCALE;
  out.height = cssH * RASTER_SCALE;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(RASTER_SCALE, 0, 0, RASTER_SCALE, 0, 0);

  renderForExport(ctx, cssW, cssH, {
    shapes,
    camera,
    imageCache,
    theme: state.theme,
    backgroundPattern: "blank",
    gridSpacing: state.gridSpacing,
    gridOpacity: 0,
    fontFamily: state.fontFamily,
    layers: state.layers,
    includeBackground: opts.includeBackground,
    canvasBackgroundOverride: state.canvasBackgroundOverride,
    flowchart: state.flowchart,
  });

  // Strokes render above shapes in the live view — match that here.
  const drawIds = shapes.filter((s) => s.type === "draw").map((s) => s.id);
  if (drawIds.length && drawingLayer) {
    ctx.save();
    ctx.translate(camera.x, camera.y);
    drawingLayer.renderStrokesTo(ctx, drawIds);
    ctx.restore();
  }

  return { canvas: out, bounds };
}

// ───────────────────── toolbar actions ─────────────────────

function rasterFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Raster-${p(d.getDate())}${p(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}-${p(d.getHours())}${p(d.getMinutes())}.png`;
}

/** "Rasterize group": bake the current selection — plus any selected
 *  drag-area's contents — into a single ImageShape. Rendered at 2× and
 *  sized back to the original bounding box so it stays crisp on HiDPI.
 *  Transparent background so the canvas shows through. */
export function rasterizeSelectionToImage(source: RasterSource): void {
  const shapes = collectRasterShapes(source.state);
  if (!shapes.length) return;
  const raster = rasterizeShapes(source, shapes, { includeBackground: false });
  if (!raster) return;
  const dataUrl = raster.canvas.toDataURL("image/png");
  source.state.replaceShapesWithImage(
    new Set(shapes.map((s) => s.id)), dataUrl, rasterFileName(), raster.bounds,
  );
}

/** "Recognize handwriting": rasterize the selected strokes (background
 *  on, so "auto" white ink on a dark theme stays legible) and run them
 *  through the recognition engine (src/recognition/). For now the
 *  recognized text lands as a TextShape beneath the strokes; a later
 *  pass will offer replacing the ink outright. */
export async function recognizeSelectionHandwriting(source: RasterSource): Promise<void> {
  const shapes = collectRasterShapes(source.state).filter((s) => s.type === "draw");
  if (!shapes.length) return;
  const raster = rasterizeShapes(source, shapes, { includeBackground: true });
  if (!raster) return;
  const { recognizeHandwriting } = await import("../recognition/handwriting");
  const text = (await recognizeHandwriting(raster.canvas)).trim();
  if (!text) return;
  source.state.addTextShapeAtPosition(text, { x: raster.bounds.minX, y: raster.bounds.maxY + 16 });
}
