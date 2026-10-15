/**
 * Zotero's annotations, painted into a rasterized PDF page.
 *
 * Zotero annotations are **not** in the PDF file. They are child items of
 * the attachment, fetched from the Zotero API and cached locally
 * (`zotero-annotations.js`), so nothing pdf.js draws includes them. This
 * is the one painter for every raster that should show them: the
 * viewer's pages, the folded view's strips, the thumbnail grid, a shelf
 * cover, a proofread notebook — so a highlight that shows in one shows
 * in all of them, and a baked page reads like the viewer.
 *
 * Geometry: positions are raw PDF user space, and
 * `viewport.convertToViewportPoint` is what honours a non-(0,0) CropBox
 * origin and any page `/Rotate` (and, for a fold's strip, the viewport's
 * vertical offset). A plain `y → height − y` flip paints every mark
 * offset by the crop origin on such documents — right relative to each
 * other, wrong against the page.
 */

import { parseAnnotationPosition } from "./pdf-viewer-annotations.js";

/** Highlights are drawn the way a highlighter marks paper: multiplied
 *  into the page, so the words stay black under the colour. */
const HIGHLIGHT_ALPHA = 0.3;

const box = (viewport, r) => {
  const [ax, ay] = viewport.convertToViewportPoint(r[0], r[1]);
  const [bx, by] = viewport.convertToViewportPoint(r[2], r[3]);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
};

/**
 * Paint every annotation belonging to `pageIndex` (0-based, as Zotero
 * stores it) into `ctx`.
 *
 * `viewport` must be the one the page was rendered with, so its
 * `convertToViewportPoint` lands in the canvas's own pixel space, and
 * `scale` is that viewport's scale — line widths track it, so a mark is
 * the same visual weight at any raster size.
 *
 * Each type is drawn as itself: a highlight multiplied in, an underline
 * as a rule under its words, an area or a text box outlined (the figure
 * inside stays as it is), a note as its marker, ink at the pen width
 * Zotero recorded.
 */
export function drawAnnotationsOnPage(ctx, viewport, scale, annots, pageIndex = 0) {
  if (!ctx || !annots || !annots.length) return;
  for (const ann of annots) {
    if (ann.embedded) continue; // in the file, so pdfjs drew it already
    const pos = parseAnnotationPosition(ann);
    if (!pos || pos.pageIndex !== pageIndex) continue;
    const color = ann.color || (ann.type === "ink" ? "#ff0000" : "#ffd400");
    ctx.save();
    if (ann.type === "ink" && pos.paths?.length) {
      // Zotero records the pen width in PDF units beside the paths.
      const width = Number(pos.width) || 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.75, width * scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const pts of pos.paths) {
        if (!pts || pts.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const [x, y] = viewport.convertToViewportPoint(pts[i], pts[i + 1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } else if (pos.rects?.length) {
      for (const r of pos.rects) {
        if (!Array.isArray(r) || r.length < 4) continue;
        const b = box(viewport, r);
        if (ann.type === "underline") {
          const t = Math.max(1, 1.2 * scale);
          ctx.fillStyle = color;
          ctx.fillRect(b.x, b.y + b.h - t, b.w, t);
        } else if (ann.type === "image" || ann.type === "text") {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, 1.5 * scale);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        } else if (ann.type === "note") {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(b.x, b.y, b.w, b.h);
        } else {
          ctx.globalCompositeOperation = "multiply";
          ctx.globalAlpha = HIGHLIGHT_ALPHA;
          ctx.fillStyle = color;
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
      }
    }
    ctx.restore();
  }
}

/** The viewer's form: `viewport` carries its own scale. */
export function drawAnnotations(ctx, viewport, annots, pageIndex) {
  drawAnnotationsOnPage(ctx, viewport, viewport.scale, annots, pageIndex);
}

/** A string per page that changes when what is drawn on it does — what
 *  decides whether a rendered page has to be repainted after a refresh.
 *  Only what shows counts: a repaint replaces the page's text layer, and
 *  with it any selection being made there, so a comment edit or a new
 *  version number from Zotero mustn't cause one. */
export function pageSignatures(annots) {
  const out = new Map();
  for (const a of annots || []) {
    const idx = parseAnnotationPosition(a)?.pageIndex;
    if (typeof idx !== "number" || a.embedded) continue;
    const pos = a._raw?.data?.annotationPosition;
    const part = `${a.key}:${a.type}:${a.color}:${typeof pos === "string" ? pos : JSON.stringify(pos)}`;
    out.set(idx, out.has(idx) ? `${out.get(idx)},${part}` : part);
  }
  return out;
}

/** True when any annotation in the list falls on `pageIndex`. Lets a
 *  caller skip the paint (and, for a proof, the extra canvas work)
 *  without walking the list twice. */
export function hasAnnotationsOnPage(annots, pageIndex) {
  if (!annots || !annots.length) return false;
  for (const ann of annots) {
    if (ann.embedded) continue;
    const pos = parseAnnotationPosition(ann);
    if (pos && pos.pageIndex === pageIndex) return true;
  }
  return false;
}

/**
 * Annotation list for a PDF's Zotero attachment.
 *
 * Cache-first, and cache-*only* unless the caller hands over Zotero
 * credentials: a cover re-render runs on shelf hydration and must never
 * reach the network, but a bake the user explicitly asked for (a proof
 * of a PDF they've never opened in the viewer, so nothing has warmed the
 * cache) should be able to fill it. `getAnnotations` is itself
 * cache-first, so passing credentials only costs a fetch when there is
 * genuinely nothing on disk.
 *
 * Empty for non-Zotero PDFs, and empty rather than throwing for anything
 * else that goes wrong: an unannotated page is a fine outcome, a failed
 * bake is not.
 */
export async function loadPdfAnnotations(fileId, opts = {}) {
  if (!fileId) return [];
  try {
    const { getPdfMeta } = await import("../sync/pdf-sync.js");
    const attKey = getPdfMeta(fileId)?.zoteroAttKey;
    if (!attKey) return [];
    const zotero = await import("../zotero-annotations.js");
    let api;
    if (opts.userId && opts.apiKey) {
      const res = await zotero.getAnnotations(attKey, opts.userId, opts.apiKey);
      api = res?.annotations || [];
    } else {
      api = (await zotero.getCachedAnnotations(attKey)) || [];
    }
    // Merged with what was extracted from the file, so an annotation
    // that is both in the library and in the file is flagged embedded —
    // the raster has it already, and painting it again doubles it.
    return zotero.mergeAnnotationLists(api, await zotero.getExtractedAnnotations(fileId));
  } catch {
    return [];
  }
}
