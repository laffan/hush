/**
 * The page records the viewer keeps, one per page, each with its wrapper
 * in the scroll area: a placeholder until the renderer draws it, the
 * hover buttons (bookmark, Open in Zotero) and the clip bookmarks layer
 * (pdf-bookmarks.js). Every page starts at page 1's size; the others
 * adopt their real size on first render (pdf-viewer-render.js), so
 * opening a book isn't a serial walk over every page.
 *
 * A record: `{ wrapper, viewport (scale 1), realViewport, rendered,
 * rendering, canvas, renderedZoom, contentEl, contentW, contentH }` —
 * `contentEl` the canvas and its link and text layers at paint-time
 * size, stretched by a transform until the settle pass re-renders.
 */
import { attachPageHoverButtons, attachPageClipBookmarks } from "./pdf-bookmarks.js";

export function createPageRecords(scrollArea, count, viewport, { zoteroAttKey, fileId }) {
  const pages = [];
  for (let i = 0; i < count; i++) {
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page-wrapper";
    wrapper.dataset.pageIndex = String(i);
    const placeholder = document.createElement("div");
    placeholder.className = "pdf-page-placeholder";
    wrapper.appendChild(placeholder);
    // Hover buttons: bookmark (upper-right) + Zotero pop-out
    // (bottom-right, Zotero-backed PDFs only).
    attachPageHoverButtons(wrapper, i + 1, { zoteroAttKey, fileId });
    // Double-click anywhere on the page to clip that point.
    attachPageClipBookmarks(wrapper, i + 1, { fileId });
    scrollArea.appendChild(wrapper);
    pages.push({
      wrapper, viewport, realViewport: i === 0,
      rendered: false, rendering: false, canvas: null, renderedZoom: null,
      contentEl: null, contentW: 0, contentH: 0,
    });
  }
  return pages;
}

/** pdf.js input from what the hosts hand the viewer: bytes, an
 *  ArrayBuffer, a number array or a data: URL. */
export function pdfInput(data) {
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    return { data: data instanceof ArrayBuffer ? new Uint8Array(data) : data };
  }
  if (typeof data === "string" && data.startsWith("data:")) {
    const raw = atob(data.split(",")[1]);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return { data: arr };
  }
  if (Array.isArray(data)) return { data: new Uint8Array(data) };
  return { data };
}

/** Scroll page `idx`'s wrapper to the start of the view. In the paged
 *  view that is its set's snap point (scroll-padding centres the set). */
export function scrollToPage(scrollArea, w, horizontal, smooth) {
  const behavior = smooth ? "smooth" : "auto";
  if (horizontal) {
    const ar = scrollArea.getBoundingClientRect();
    const r = w.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(scrollArea).scrollPaddingLeft) || 0;
    const margin = parseFloat(getComputedStyle(w).scrollMarginLeft) || 0;
    scrollArea.scrollTo({ left: scrollArea.scrollLeft + r.left - ar.left - pad - margin, behavior });
  } else {
    const ar = scrollArea.getBoundingClientRect();
    const r = w.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(scrollArea).scrollPaddingTop) || 0;
    const margin = parseFloat(getComputedStyle(w).scrollMarginTop) || 0;
    scrollArea.scrollTo({ top: scrollArea.scrollTop + r.top - ar.top - pad - margin, behavior });
  }
}

/** Paint the rendered pages in view into the suspend snapshot canvas —
 *  clipped to what a reading crop leaves of each, as they are shown. */
export function drawPagesSnapshot(scrollArea, pages, ctx, h) {
  const areaRect = scrollArea.getBoundingClientRect();
  const cropped = scrollArea.classList.contains("pdf-cropped");
  const c = (e) => (cropped ? parseFloat(scrollArea.style.getPropertyValue(`--crop-${e}`)) || 0 : 0);
  const [t, r, b, l] = ["t", "r", "b", "l"].map(c);
  for (const p of pages) {
    if (!p.rendered || !p.canvas) continue;
    const rect = p.wrapper.getBoundingClientRect();
    const dx = rect.left - areaRect.left;
    const dy = rect.top - areaRect.top;
    if (dy + rect.height < 0 || dy > h) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx + l * rect.width, dy + t * rect.height, rect.width * (1 - l - r), rect.height * (1 - t - b));
    ctx.clip();
    ctx.drawImage(p.canvas, dx, dy, rect.width, rect.height);
    ctx.restore();
  }
}
