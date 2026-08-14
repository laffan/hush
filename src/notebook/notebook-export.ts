/**
 * Notebook export pipeline.
 *
 * Produces rasters (PNG / JPEG / PDF), or the notebook's native zip
 * (.hushnote), from an open NotesCanvas. The modal in
 * `src/sidebar/notebook-export-modal.js` collects the options and
 * hands them to `exportNotebook()`.
 *
 * Scope options:
 *   - "visible": the current viewport at its current camera
 *   - "all":     fit the bbox of every on-canvas shape, with a user
 *                margin added on each side
 *
 * The raster pipeline:
 *   1. Compute target CSS dimensions + camera for the chosen scope.
 *   2. Allocate an offscreen canvas at dims × scale.
 *   3. Call `renderForExport()` in renderer-export.ts to paint shapes
 *      (optional background).
 *   4. Re-render every engine stroke on top of the shape layer
 *      (matching the live DOM z-order). Deliberately not a done-canvas
 *      blit — that canvas only covers a viewport-sized world rect.
 *   5. Hand back a canvas or encoded bytes depending on format.
 */

import type { NotesCanvas } from "./notes-canvas";
import { renderForExport } from "./renderer-export";
import { getShapeBounds } from "./utils";
import type { Bounds } from "./types";
import { composeVectorTextPdf } from "./notebook-pdf";

export type ExportScope = "visible" | "all";
export type ExportFormat = "hushnote" | "png" | "jpg" | "pdf";
export type ExportScale = 1 | 2 | 3;

export interface ExportOptions {
  scope: ExportScope;
  /** All-content margin (CSS px at 1x). Ignored when scope === "visible". */
  margin: number;
  format: ExportFormat;
  scale: ExportScale;
  includeBackground: boolean;
}

/** Union of all extensions we can write. Callers map this to a file
 *  picker filter list. */
export function extensionForFormat(fmt: ExportFormat): string {
  switch (fmt) {
    case "hushnote": return "hushnote";
    case "png": return "png";
    case "jpg": return "jpg";
    case "pdf": return "pdf";
  }
}

/** MIME type for a format. */
export function mimeForFormat(fmt: ExportFormat): string {
  switch (fmt) {
    case "png": return "image/png";
    case "jpg": return "image/jpeg";
    case "pdf": return "application/pdf";
    case "hushnote": return "application/json";
  }
}

/** Produce the export payload for the given NotesCanvas and options.
 *  Returns bytes in a Uint8Array — caller writes to disk (Tauri) or
 *  triggers a browser download.
 *
 *  For the "all" scope on an empty notebook, returns a 1×1 transparent
 *  pixel rather than throwing — keeps the modal's UX predictable. */
export async function exportNotebook(
  canvas: NotesCanvas,
  opts: ExportOptions,
): Promise<Uint8Array> {
  if (opts.format === "hushnote") {
    return await encodeHushnote(canvas);
  }

  if (opts.format === "pdf") {
    // Render the canvas WITHOUT text glyphs (decorations like blockquote
    // rules, link underlines, and highlight backgrounds stay), then
    // overlay vector text in the PDF stream.
    const built = buildExportRaster(canvas, opts, /* omitTextGlyphs */ true);
    const jpeg = await canvasToBytes(built.canvas, "image/jpeg", 0.92);
    return composeVectorTextPdf(jpeg, {
      cssW: built.cssW,
      cssH: built.cssH,
      pxW: built.canvas.width,
      pxH: built.canvas.height,
      camera: built.camera,
      theme: canvas.state.theme,
      fontFamily: canvas.state.fontFamily,
      shapes: canvas.state.shapes,
      layers: canvas.state.layers,
    });
  }
  const raster = rasterizeNotebook(canvas, opts);
  if (opts.format === "png") {
    return canvasToBytes(raster, "image/png");
  }
  // jpg
  return canvasToBytes(raster, "image/jpeg", 0.92);
}

// ───────────────────── raster pipeline ─────────────────────

function rasterizeNotebook(canvas: NotesCanvas, opts: ExportOptions): HTMLCanvasElement {
  return buildExportRaster(canvas, opts, false).canvas;
}

interface ExportRaster {
  canvas: HTMLCanvasElement;
  cssW: number;
  cssH: number;
  camera: { x: number; y: number; zoom: number };
}

/**
 * Shared raster pipeline used by every format. `omitTextGlyphs=true`
 * skips fillText calls for text shapes but keeps every other decoration
 * (text-shape backgrounds, blockquote rules, task checkboxes, link
 * underlines, highlight backgrounds) — used by the PDF path so vector
 * text can be overlaid without doubling-up.
 */
function buildExportRaster(canvas: NotesCanvas, opts: ExportOptions, omitTextGlyphs: boolean): ExportRaster {
  const state = canvas.state;
  const viewport = canvas.container.getBoundingClientRect();

  let camera;
  let cssW: number;
  let cssH: number;

  if (opts.scope === "visible") {
    cssW = Math.max(1, Math.round(viewport.width));
    cssH = Math.max(1, Math.round(viewport.height));
    camera = state.camera;
  } else {
    const bounds = computeContentBounds(state.shapes as never[], state.fontFamily);
    const m = Math.max(0, opts.margin | 0);
    if (!bounds) {
      cssW = Math.max(1, m * 2 || 64);
      cssH = Math.max(1, m * 2 || 64);
      camera = { x: m, y: m, zoom: 1 };
    } else {
      cssW = Math.max(1, Math.ceil(bounds.maxX - bounds.minX) + m * 2);
      cssH = Math.max(1, Math.ceil(bounds.maxY - bounds.minY) + m * 2);
      camera = { x: -bounds.minX + m, y: -bounds.minY + m, zoom: 1 };
    }
  }

  const scale = fitRasterScale(cssW, cssH, opts.scale);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cssW * scale));
  out.height = Math.max(1, Math.round(cssH * scale));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D context");

  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  renderForExport(ctx, cssW, cssH, {
    shapes: state.shapes,
    camera,
    imageCache: canvas.getImageCache(),
    theme: state.theme,
    backgroundPattern: state.backgroundPattern,
    gridSpacing: state.gridSpacing,
    gridOpacity: state.gridOpacity,
    fontFamily: state.fontFamily,
    layers: state.layers,
    includeBackground: opts.includeBackground,
    canvasBackgroundOverride: state.canvasBackgroundOverride,
    flowchart: state.flowchart,
    omitTextGlyphs,
    flagColors: ((window as unknown as { __hushState__?: { settings?: { flagColors?: Record<string, string> } } }).__hushState__)?.settings?.flagColors,
  });

  // Strokes sit above shapes in the live view (drawing wrapper is a
  // sibling appended after the main canvas). Match that z-order here
  // by painting after shapes, under the same camera transform.
  //
  // Re-render every stroke rather than blitting the done canvas: that
  // canvas only backs a viewport-sized world rect that follows the
  // camera, so an "all content" export of anything taller than a screen
  // — a proofread notebook is tens of thousands of world px — would come
  // out with the ink from wherever the camera happened to be and nothing
  // else.
  const dl = canvas.getDrawingLayer();
  if (dl) {
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    dl.renderAllStrokesTo(ctx);
    ctx.restore();
  }

  return { canvas: out, cssW, cssH, camera };
}

/** Browser canvas ceilings. WebKit on iPad is the tight one: a canvas
 *  past roughly 16 M device pixels, or with either side past 8192,
 *  allocates without complaint and then never paints. Both limits are
 *  easy to cross on an "all content" export of a proofread notebook,
 *  whose world is one tall column of full-size pages — and the failure
 *  mode is a blank file rather than an error. */
const MAX_RASTER_SIDE = 8192;
const MAX_RASTER_AREA = 16_777_216;

/** Largest scale at or below `wanted` that keeps the raster inside both
 *  ceilings. Trimming resolution costs sharpness; crossing the ceiling
 *  costs the whole export. */
function fitRasterScale(cssW: number, cssH: number, wanted: number): number {
  const bySide = MAX_RASTER_SIDE / Math.max(cssW, cssH);
  const byArea = Math.sqrt(MAX_RASTER_AREA / Math.max(1, cssW * cssH));
  return Math.max(0.02, Math.min(wanted, bySide, byArea));
}

function computeContentBounds(shapes: { pocketed?: boolean }[], fontFamily: string): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const s of shapes) {
    if (s.pocketed) continue; // pocketed shapes are workspace-only
    const b = getShapeBounds(s as never, fontFamily);
    if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX)) continue;
    if (b.maxX - b.minX <= 0 && b.maxY - b.minY <= 0) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
    any = true;
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}

// ───────────────────── encoders ─────────────────────

async function encodeHushnote(canvas: NotesCanvas): Promise<Uint8Array> {
  // Route through the shared notebook-sync zip writer
  // (sync/notebook-sync.js) so the on-disk .hushnote wire format is a
  // single thing — a zip with data.json + an images/ folder. Image
  // data URLs get extracted into the zip so big binaries don't live
  // inline.
  //
  // The envelope is built by the same encoder the autosave uses, over
  // the same fields: an export that hand-rolled its own envelope was an
  // export that quietly dropped whatever the hand-rolled list didn't
  // mention (camera, background, bookmarks, splits, and the `proof`
  // metadata a proofread notebook is defined by).
  const { encodeNotebookContent } = await import("./notebook-content");
  const envelope = encodeNotebookContent({
    shapes: canvas.getShapes(),
    layers: canvas.state.layers,
    flowEdges: canvas.state.flowchart.serialize(),
    bookmarks: canvas.state.bookmarks,
    camera: canvas.state.camera,
    background: {
      pattern: canvas.state.backgroundPattern,
      spacing: canvas.state.gridSpacing,
      opacity: canvas.state.gridOpacity,
      rotationEnabled: canvas.state.canvasRotationEnabled,
    },
    splits: canvas.state.splits,
    proof: canvas.state.proof ?? undefined,
  });
  const { packNotebook } = await import("../sync/notebook-sync.js");
  return await packNotebook(envelope);
}

async function canvasToBytes(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, quality));
  if (!blob) throw new Error("Canvas encoding failed for " + mime);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// PDF encoding now lives in `notebook-pdf.ts` (vector-text variant).
