/**
 * Link layer for the PDF viewer — makes the PDF's own links work.
 *
 * pdfjs exposes a page's `Link` annotations (table-of-contents rows,
 * "see Section 4" cross-references, DOIs in the bibliography) through
 * `page.getAnnotations()`, but the viewer never asked for them, so
 * within-PDF links were dead. This module lays a transparent overlay of
 * clickable boxes over each rendered page:
 *
 *  - **Internal links** (a `dest` naming a page) navigate in place via
 *    `goToPage` — the destination page index resolves lazily on click
 *    (named destinations need an async `getDestination` round trip).
 *  - **External links** (a `url`) open in the system browser through
 *    the opener plugin, exactly like the toolbar's Zotero link.
 *
 * The overlay joins the page's content box (`.pdf-page-content`), so it
 * stretches with the raster during a drag-resize and dies with it on
 * eviction. Annotation lists are cached per page record — a page that
 * re-renders after eviction reuses the fetch.
 */

import { pdfPointToViewport } from "./pdf-viewer-annotations.js";

async function openExternal(url) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

/**
 * @param {object} env
 * @param {function} env.getPdfDoc   () => pdfjs doc | null
 * @param {function} env.getPages    () => pages[]
 * @param {function} env.goToPage    (n: number) => void
 * @param {function} env.isDestroyed () => boolean
 */
export function createLinkLayerManager(env) {
  /** Resolve a link annotation to a 1-based page number, or null. */
  async function resolveDestPage(annot) {
    const pdfDoc = env.getPdfDoc();
    if (!pdfDoc) return null;
    try {
      let dest = annot.dest;
      if (typeof dest === "string") dest = await pdfDoc.getDestination(dest);
      if (!Array.isArray(dest) || dest[0] == null) return null;
      const ref = dest[0];
      const idx = typeof ref === "object" ? await pdfDoc.getPageIndex(ref) : ref;
      return typeof idx === "number" && idx >= 0 ? idx + 1 : null;
    } catch {
      return null;
    }
  }

  function onLinkClick(annot, e) {
    e.preventDefault();
    e.stopPropagation();
    if (annot.url) { void openExternal(annot.url); return; }
    void resolveDestPage(annot).then((n) => {
      if (n != null && !env.isDestroyed()) env.goToPage(n);
    });
  }

  /** Build the overlay for page `idx` — called after each successful
   *  page render, with the pdfjs page proxy already in hand. */
  async function attach(idx, page) {
    const p = env.getPages()[idx];
    if (!p || !p.contentEl) return;
    if (!p.linkAnnots) {
      try {
        const annots = await page.getAnnotations({ intent: "display" });
        p.linkAnnots = annots.filter(
          (a) => a.subtype === "Link" && Array.isArray(a.rect) && (a.url || a.dest));
      } catch {
        p.linkAnnots = [];
      }
      if (env.isDestroyed()) return;
    }
    if (!p.linkAnnots.length || !p.contentEl || !p.contentEl.isConnected) return;
    p.contentEl.querySelector(".pdf-link-layer")?.remove();

    const layer = document.createElement("div");
    layer.className = "pdf-link-layer";
    const z = p.renderedZoom || 1;
    for (const a of p.linkAnnots) {
      const [x1, y1, x2, y2] = a.rect;
      const [ax, ay] = pdfPointToViewport(p.viewport, x1, y1);
      const [bx, by] = pdfPointToViewport(p.viewport, x2, y2);
      const el = document.createElement("a");
      el.className = "pdf-link";
      el.style.left = `${Math.min(ax, bx) * z}px`;
      el.style.top = `${Math.min(ay, by) * z}px`;
      el.style.width = `${Math.abs(bx - ax) * z}px`;
      el.style.height = `${Math.abs(by - ay) * z}px`;
      if (a.url) {
        el.href = a.url;
        el.title = a.url;
      } else {
        el.href = "#";
      }
      el.addEventListener("click", (e) => onLinkClick(a, e));
      layer.appendChild(el);
    }
    p.contentEl.appendChild(layer);
  }

  return { attach };
}
