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
import type { CanvasTheme } from "./themes";
import type { Bounds, DrawShape, Shape } from "./types";
import { renderForExport } from "./renderer-export";
import { getShapeBounds } from "./utils";
import { isInkRecognitionAvailable } from "../recognition/handwriting";

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
  opts: {
    includeBackground: boolean; scale?: number; margin?: number;
    /** Render with a specific theme (defaults to the live one). The
     *  dual-appearance raster path passes the light / dark variants. */
    theme?: CanvasTheme;
  },
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
  const theme = opts.theme ?? state.theme;

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
    theme,
    backgroundPattern: "blank",
    gridSpacing: state.gridSpacing,
    gridOpacity: 0,
    fontFamily: state.fontFamily,
    layers: state.layers,
    includeBackground: opts.includeBackground,
    canvasBackgroundOverride: opts.theme ? undefined : state.canvasBackgroundOverride,
    flowchart: state.flowchart,
  });

  // Strokes render above shapes in the live view — match that here.
  // When rendering for a non-live theme, retint theme-tracking strokes
  // to that theme's colours.
  const drawIds = shapes.filter((s) => s.type === "draw").map((s) => s.id);
  if (drawIds.length && drawingLayer) {
    ctx.save();
    ctx.translate(camera.x, camera.y);
    drawingLayer.renderStrokesTo(
      ctx, drawIds,
      opts.theme ? { foreground: theme.foreground, headingColor: theme.headingColor } : undefined,
    );
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

/** True when any shape's colour tracks the theme — auto/heading
 *  strokes, or text / drag-area colour sentinels — i.e. content whose
 *  baked pixels would go stale on a light/dark appearance switch. */
function selectionIsThemeTracking(shapes: Shape[]): boolean {
  for (const s of shapes) {
    if (s.type === "draw" && (s.colorIsAuto || s.colorIsHeading)) return true;
    if (s.color === "auto" || s.color === "heading") return true;
    if (s.type === "text" && (s.backgroundColor === "auto" || s.backgroundColor === "heading"
      || s.borderColor === "auto" || s.borderColor === "heading")) return true;
    if (s.type === "drag-area" && (s.borderColor === "auto" || s.borderColor === "heading")) return true;
  }
  return false;
}

/** "Rasterize group": bake the current selection — plus any selected
 *  drag-area's contents — into a single ImageShape. Rendered at 2× and
 *  sized back to the original bounding box so it stays crisp on HiDPI.
 *  Transparent background so the canvas shows through.
 *
 *  Theme-tracking content (auto/heading strokes and text) is baked
 *  TWICE — once per appearance — and the result becomes an
 *  appearance-aware image (`dataUrl` light, `dataUrlDark` dark) so the
 *  raster keeps following light/dark switches instead of freezing at
 *  the colour it happened to be rasterized under. */
export function rasterizeSelectionToImage(source: RasterSource): void {
  const { state } = source;
  const shapes = collectRasterShapes(state);
  if (!shapes.length) return;

  if (selectionIsThemeTracking(shapes)) {
    const light = rasterizeShapes(source, shapes, { includeBackground: false, theme: state.themeForVariant("light") });
    const dark = rasterizeShapes(source, shapes, { includeBackground: false, theme: state.themeForVariant("dark") });
    if (!light || !dark) return;
    state.replaceShapesWithImage(
      new Set(shapes.map((s) => s.id)),
      light.canvas.toDataURL("image/png"),
      rasterFileName(),
      light.bounds,
      dark.canvas.toDataURL("image/png"),
    );
    return;
  }

  const raster = rasterizeShapes(source, shapes, { includeBackground: false });
  if (!raster) return;
  const dataUrl = raster.canvas.toDataURL("image/png");
  state.replaceShapesWithImage(
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

/** Image branch of Recognize handwriting: rasterize the selected
 *  images (e.g. a previously-rasterized stroke group) and run the
 *  pixels through Apple's Vision recognizer via the recognition
 *  engine (src/recognition/). Background on, so transparent images
 *  sit on their intended canvas colour (then normalized to
 *  dark-on-light). The recognized text lands as a TextShape beneath
 *  the images. */
export async function recognizeSelectionImagesVision(source: RasterSource): Promise<void> {
  const shapes = collectRasterShapes(source.state).filter((s) => s.type === "image");
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
 *  Timing: real capture deltas when the points carry timestamps
 *  (engine delta #21 — the recognizer models pen velocity), rebased
 *  onto one monotonic clock with synthesized 300 ms pen-lift gaps
 *  between strokes; legacy points without timestamps fall back to
 *  ~15 ms per point. Stroke order comes from state.shapes, which
 *  appends in drawing order. Strokes only — images can't feed a
 *  stroke-based recognizer. iPad-only (Google doesn't ship ML Kit
 *  for macOS). */
export async function recognizeSelectionInkMlkit(state: DrawingState): Promise<void> {
  const shapes = collectRasterShapes(state)
    .filter((s): s is DrawShape => s.type === "draw");
  if (!shapes.length) return;
  const bounds = rasterBounds(shapes, state.fontFamily);
  if (!bounds) return;
  let clock = 0;
  const strokes = shapes.map((s) => {
    const points = s.points.map((p, i) => {
      if (i > 0) {
        const prev = s.points[i - 1];
        // Real delta when both ends carry timing, clamped to [1 ms,
        // 1 s] so coalesced same-frame points and mid-stroke pauses
        // don't skew the velocity model.
        let dt = 15;
        if (p.t !== undefined && prev.t !== undefined && Number.isFinite(p.t - prev.t)) {
          dt = Math.min(1000, Math.max(1, p.t - prev.t));
        }
        clock += dt;
      }
      return { x: p.x - bounds.minX, y: p.y - bounds.minY, t: Math.round(clock) };
    });
    clock += 300; // pen-lift gap between strokes
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

/** The single Recognize-handwriting action — one button, two engines
 *  under the hood. Strokes go to Google's stroke-based ML Kit
 *  recognizer (iPad only; on desktop stroke recognition is
 *  intentionally unavailable). Image selections — e.g. a rasterized
 *  stroke group — go through Apple's Vision raster path. A mixed
 *  selection on iPad prefers the strokes. `canRecognizeSelection`
 *  is the matching visibility test for the toolbar button. */
export function canRecognizeSelection(state: DrawingState): boolean {
  const shapes = collectRasterShapes(state);
  const hasStrokes = shapes.some((s) => s.type === "draw");
  if (hasStrokes && isInkRecognitionAvailable()) return true;
  return shapes.some((s) => s.type === "image");
}

export async function recognizeSelection(source: RasterSource): Promise<void> {
  const hasStrokes = collectRasterShapes(source.state).some((s) => s.type === "draw");
  if (hasStrokes && isInkRecognitionAvailable()) {
    return recognizeSelectionInkMlkit(source.state);
  }
  return recognizeSelectionImagesVision(source);
}
