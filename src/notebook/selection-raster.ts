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
import type { Bounds, DrawShape, Shape } from "./types";
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
 * Render `shapes` into an offscreen canvas at `opts.scale`
 * (RASTER_SCALE by default).
 *
 * `includeBackground` fills the theme canvas colour first — used by
 * the recognition path so strokes always sit on their intended
 * background (an "auto" white stroke on a dark theme stays legible).
 * The rasterize-group path leaves it transparent so the canvas
 * background shows through the resulting ImageShape. `margin` pads
 * extra world px around the content bbox (the recognizer reads
 * better with whitespace around the ink).
 */
export function rasterizeShapes(
  source: RasterSource,
  shapes: Shape[],
  opts: { includeBackground: boolean; scale?: number; margin?: number },
): SelectionRaster | null {
  const { state, imageCache, drawingLayer } = source;
  if (!shapes.length) return null;
  const contentBounds = rasterBounds(shapes, state.fontFamily);
  if (!contentBounds) return null;
  const m = opts.margin ?? 0;
  const bounds = {
    minX: contentBounds.minX - m, minY: contentBounds.minY - m,
    maxX: contentBounds.maxX + m, maxY: contentBounds.maxY + m,
  };
  const scale = opts.scale ?? RASTER_SCALE;

  const cssW = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
  const cssH = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
  const camera = { x: -bounds.minX, y: -bounds.minY, zoom: 1 };

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cssW * scale));
  out.height = Math.max(1, Math.round(cssH * scale));
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

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

/** Recognizers read best around a ~1600 px long side: small ink gets
 *  upscaled (glyph detail), huge canvases aren't rendered at a
 *  wasteful 6×. Hard-capped so the raster never exceeds 4096 px. */
function recognitionScale(bounds: Bounds): number {
  const maxSide = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
  const scale = Math.max(1, Math.min(6, 1600 / maxSide));
  return Math.min(scale, 4096 / maxSide);
}

/** Vision is noticeably weaker on light-ink-on-dark rasters. Sample a
 *  corner pixel (guaranteed pure background thanks to the margin) and,
 *  when the background reads dark, invert the raster in place so the
 *  recognizer always sees dark-on-light. Pixel loop rather than
 *  ctx.filter="invert(1)" for older-WebKit safety. */
function normalizeForRecognition(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const corner = ctx.getImageData(0, 0, 1, 1).data;
  const luma = 0.299 * corner[0] + 0.587 * corner[1] + 0.114 * corner[2];
  if (luma >= 128) return;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(img, 0, 0);
}

/** "Recognize handwriting": rasterize the ink in the selection —
 *  strokes plus images, so already-rasterized handwriting stays
 *  recognizable — and run it through the recognition engine
 *  (src/recognition/). Background on, so "auto" white ink on a dark
 *  theme stays legible (then normalized to dark-on-light). For now
 *  the recognized text lands as a TextShape beneath the ink; a later
 *  pass will offer replacing it outright. */
export async function recognizeSelectionHandwriting(source: RasterSource): Promise<void> {
  const shapes = collectRasterShapes(source.state)
    .filter((s) => s.type === "draw" || s.type === "image");
  if (!shapes.length) return;
  const contentBounds = rasterBounds(shapes, source.state.fontFamily);
  if (!contentBounds) return;
  const raster = rasterizeShapes(source, shapes, {
    includeBackground: true,
    scale: recognitionScale(contentBounds),
    margin: 24,
  });
  if (!raster) return;
  normalizeForRecognition(raster.canvas);
  const { recognizeHandwriting } = await import("../recognition/handwriting");
  const text = (await recognizeHandwriting(raster.canvas)).trim();
  if (!text) return;
  source.state.addTextShapeAtPosition(text, { x: contentBounds.minX, y: contentBounds.maxY + 16 });
}

/** "Recognize handwriting (ML Kit)": the stroke-based Google backend,
 *  kept beside the Vision one for comparison. No raster — the
 *  DrawShapes' actual point sequences go to the recognizer, shifted
 *  to the selection bbox origin with the bbox as the writing area.
 *  Timestamps are synthesized (~15 ms per point, 300 ms between
 *  strokes) since Hush doesn't record pen timing; stroke order comes
 *  from state.shapes, which appends in drawing order. Strokes only —
 *  images can't feed a stroke-based recognizer. iPad-only (Google
 *  doesn't ship ML Kit for macOS). */
export async function recognizeSelectionInkMlkit(state: DrawingState): Promise<void> {
  const shapes = collectRasterShapes(state)
    .filter((s): s is DrawShape => s.type === "draw");
  if (!shapes.length) return;
  const bounds = rasterBounds(shapes, state.fontFamily);
  if (!bounds) return;
  let t = 0;
  const strokes = shapes.map((s) => {
    const points = s.points.map((p) => ({
      x: p.x - bounds.minX,
      y: p.y - bounds.minY,
      t: (t += 15),
    }));
    t += 300; // pen-lift gap between strokes
    return { points };
  });
  const { recognizeHandwritingInk } = await import("../recognition/handwriting");
  const text = (await recognizeHandwritingInk(strokes, {
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  })).trim();
  if (!text) return;
  state.addTextShapeAtPosition(text, { x: bounds.minX, y: bounds.maxY + 16 });
}
