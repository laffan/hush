/**
 * Baking Zotero annotations into a rasterized PDF page.
 *
 * Zotero annotations are **not** in the PDF file. They are child items of
 * the attachment, fetched from the Zotero API and cached locally
 * (`zotero-annotations.js`), and the viewer paints them as a DOM overlay
 * over each rendered page (`pdf-viewer-annotations.js`). So anything that
 * rasterizes a page through pdfjs and expects the marks to come along —
 * a shelf cover, a proofread notebook — gets a clean, unannotated page
 * unless it paints them itself. This module is that painter, in canvas
 * form, shared so the two bakers can't drift apart.
 *
 * Geometry matches the overlay exactly: positions are raw PDF user space,
 * and `viewport.convertToViewportPoint` is what honours a non-(0,0)
 * CropBox origin and any page `/Rotate`. A plain `y → height − y` flip
 * paints every mark offset by the crop origin on such documents — right
 * relative to each other, wrong against the page.
 */

import { parseAnnotationPosition } from "./pdf-viewer-annotations.js";

/** Highlight fill alpha. Matches `.pdf-annot-highlight`'s opacity. */
const HIGHLIGHT_ALPHA = 0.3;

/**
 * Paint every annotation belonging to `pageIndex` (0-based, as Zotero
 * stores it) into `ctx`.
 *
 * `viewport` must be the same one the page was rendered with, so its
 * `convertToViewportPoint` lands in the canvas's own pixel space, and
 * `scale` is that viewport's scale — ink line width tracks it so a
 * stroke is the same visual weight at any raster size.
 *
 * Non-ink annotations with rects (highlight, underline, note, image) all
 * paint as translucent blocks. That is what the viewer shows, and a
 * baked page that disagrees with the viewer is worse than one that
 * renders an underline a little too generously.
 */
export function drawAnnotationsOnPage(ctx, viewport, scale, annots, pageIndex = 0) {
  if (!ctx || !annots || !annots.length) return;
  for (const ann of annots) {
    const pos = parseAnnotationPosition(ann);
    if (!pos || pos.pageIndex !== pageIndex) continue;

    if (pos.rects?.length && ann.type !== "ink") {
      ctx.save();
      // `multiply`, not plain alpha — the overlay uses
      // `mix-blend-mode: multiply`, which is what keeps the text under a
      // highlight black instead of washing it toward the highlight
      // colour. Over white paper the two agree; over glyphs they don't.
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillStyle = ann.color || "#ffff00";
      for (const rect of pos.rects) {
        if (!Array.isArray(rect) || rect.length < 4) continue;
        const [ax, ay] = viewport.convertToViewportPoint(rect[0], rect[1]);
        const [bx, by] = viewport.convertToViewportPoint(rect[2], rect[3]);
        ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
      ctx.restore();
    }

    if (ann.type === "ink" && pos.paths?.length) {
      ctx.save();
      ctx.strokeStyle = ann.color || "#ff0000";
      ctx.lineWidth = Math.max(0.5, scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const pathPoints of pos.paths) {
        if (!pathPoints || pathPoints.length < 4) continue;
        ctx.beginPath();
        for (let i = 0; i < pathPoints.length; i += 2) {
          const [px, py] = viewport.convertToViewportPoint(pathPoints[i], pathPoints[i + 1]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/** True when any annotation in the list falls on `pageIndex`. Lets a
 *  caller skip the paint (and, for a proof, the extra canvas work)
 *  without walking the list twice. */
export function hasAnnotationsOnPage(annots, pageIndex) {
  if (!annots || !annots.length) return false;
  for (const ann of annots) {
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
    if (opts.userId && opts.apiKey) {
      const res = await zotero.getAnnotations(attKey, opts.userId, opts.apiKey);
      return res?.annotations || [];
    }
    return (await zotero.getCachedAnnotations(attKey)) || [];
  } catch {
    return [];
  }
}
