/**
 * Notebook export pipeline.
 *
 * Produces rasters (PNG / JPEG / PDF), or the notebook's native JSON
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
 *   4. Blit the drawing layer's done canvas so engine strokes appear
 *      on top of the shape layer (matching the live DOM z-order).
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
    return encodeHushnote(canvas);
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

  const scale = opts.scale;
  const out = document.createElement("canvas");
  out.width = cssW * scale;
  out.height = cssH * scale;
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
  const dl = canvas.getDrawingLayer();
  if (dl) {
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    dl.blitDoneCanvasAtWorldOrigin(ctx);
    ctx.restore();
  }

  return { canvas: out, cssW, cssH, camera };
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

function encodeHushnote(canvas: NotesCanvas): Uint8Array {
  // Same envelope shape used by autosave (see notebook-content.ts), but
  // pretty-printed for the export-to-disk file. Keeps a single source
  // of truth for what a `.hushnote` file contains.
  const payload = {
    format: "hushnote",
    version: 1,
    shapes: canvas.getShapes(),
    layers: canvas.state.layers,
    flowEdges: canvas.state.flowchart.serialize(),
  };
  const json = JSON.stringify(payload, null, 2);
  return new TextEncoder().encode(json);
}

async function canvasToBytes(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, quality));
  if (!blob) throw new Error("Canvas encoding failed for " + mime);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// PDF encoding now lives in `notebook-pdf.ts` (vector-text variant).
