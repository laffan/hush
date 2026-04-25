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
 *   3. Call `renderForExport()` in renderer.ts to paint shapes
 *      (optional background).
 *   4. Blit the drawing layer's done canvas so engine strokes appear
 *      on top of the shape layer (matching the live DOM z-order).
 *   5. Hand back a canvas or encoded bytes depending on format.
 */

import type { NotesCanvas } from "./notes-canvas";
import { renderForExport } from "./renderer";
import { getShapeBounds } from "./utils";
import type { Bounds } from "./types";

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

  const raster = rasterizeNotebook(canvas, opts);
  if (opts.format === "png") {
    return canvasToBytes(raster, "image/png");
  }
  if (opts.format === "jpg") {
    return canvasToBytes(raster, "image/jpeg", 0.92);
  }
  // pdf: wrap the JPEG (smaller than PNG for photo-like pages) in a
  // minimal single-page PDF.
  const jpeg = await canvasToBytes(raster, "image/jpeg", 0.92);
  return wrapJpegAsPdf(jpeg, raster.width, raster.height);
}

// ───────────────────── raster pipeline ─────────────────────

function rasterizeNotebook(canvas: NotesCanvas, opts: ExportOptions): HTMLCanvasElement {
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
      // Empty notebook: fall back to a small margin-only square so the
      // output is still a valid image.
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

  // A single scale(scale, scale) baseline means every downstream draw
  // call can think in CSS pixels — matches the live renderer's mental
  // model.
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

  return out;
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
  // Self-describing JSON wrapper so future versions can evolve without
  // colliding with the raw shapes array stored in the backing file.
  const payload = {
    format: "hushnote",
    version: 1,
    shapes: canvas.getShapes(),
    layers: canvas.state.layers,
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

// ───────────────────── minimal PDF encoder ─────────────────────
//
// Wraps a single JPEG into a valid 1-page PDF. One image XObject
// (DCTDecode) + a page whose content stream draws it at page size.
// No fonts, metadata, or compression beyond the embedded JPEG.
// Page dims equal the pixel dims of the raster at 72 dpi — consumers
// that want a physical size can scale in their viewer.

function wrapJpegAsPdf(jpeg: Uint8Array, pxW: number, pxH: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
    return bytes.length;
  };
  const markObj = () => { offsets.push(length); };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  // Object 1: catalog
  markObj();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Object 2: pages
  markObj();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  // Object 3: page
  markObj();
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pxW} ${pxH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  // Object 4: image XObject (DCTDecode = JPEG)
  markObj();
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");

  // Object 5: content stream: draw image at page size.
  const content = `q\n${pxW} 0 0 ${pxH} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentBytes = enc.encode(content);
  markObj();
  push(`5 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  push("\nendstream\nendobj\n");

  // xref
  const xrefOffset = length;
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (const o of offsets) {
    push(o.toString().padStart(10, "0") + " 00000 n \n");
  }

  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  // Concatenate
  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
