/**
 * Thumbnail grid over the viewer — every page at a glance, with Zotero's
 * annotations painted in by the same painter as the pages
 * (pdf-annot-raster.js).
 */
import { drawAnnotations } from "./pdf-annot-raster.js";
import { releaseCanvas } from "./pdf-viewer-render.js";

const THUMB_WIDTH = 180;

/**
 * @param {HTMLElement} root       The pdf-viewer root element
 * @param {HTMLElement} scrollArea The scroll container (for goToPage context)
 * @param {object} viewerState     { getPages, getPdfDoc, isDestroyed, getAnnotations, goToPage,
 *                                   onHide } — onHide: a page pick closed the grid
 */
export function createThumbnailManager(root, viewerState) {
  let thumbPanel = null;
  let thumbVisible = false;
  let thumbObserver = null;

  function toggle() {
    thumbVisible = !thumbVisible;
    if (thumbVisible) show();
    else hide();
    return thumbVisible;
  }

  function show() {
    const pages = viewerState.getPages();
    if (thumbPanel) { thumbPanel.style.display = ""; setupObserver(); return; }
    thumbPanel = document.createElement("div");
    thumbPanel.className = "pdf-thumbnail-overlay";

    const thumbScroll = document.createElement("div");
    thumbScroll.className = "pdf-thumbnail-scroll";
    thumbPanel.appendChild(thumbScroll);

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const vp = p.viewport;
      const aspect = vp.height / vp.width;
      const thumbH = Math.round(THUMB_WIDTH * aspect);

      const cell = document.createElement("div");
      cell.className = "pdf-thumb-cell";
      cell.dataset.thumbIdx = i;
      cell.style.width = THUMB_WIDTH + "px";
      cell.style.height = thumbH + "px";

      const placeholder = document.createElement("div");
      placeholder.className = "pdf-thumb-placeholder";
      cell.appendChild(placeholder);

      const label = document.createElement("div");
      label.className = "pdf-thumb-label";
      label.textContent = i + 1;
      cell.appendChild(label);

      cell.addEventListener("click", () => {
        viewerState.goToPage(i + 1);
        toggle();
        viewerState.onHide?.();
      });

      thumbScroll.appendChild(cell);
    }

    root.appendChild(thumbPanel);
    setupObserver();
  }

  function setupObserver() {
    if (thumbObserver) thumbObserver.disconnect();
    const thumbScroll = thumbPanel?.querySelector(".pdf-thumbnail-scroll");
    if (!thumbScroll) return;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const idx = parseInt(entry.target.dataset.thumbIdx, 10);
        if (isNaN(idx)) continue;
        if (entry.isIntersecting) renderThumb(idx);
        // Scrolled-away thumbnails drop their canvas — a large PDF's
        // grid would otherwise accumulate one per page browsed.
        else clearThumb(entry.target);
      }
    }, { root: thumbScroll, rootMargin: "300px" });
    for (const cell of thumbScroll.children) thumbObserver.observe(cell);
  }

  function clearThumb(cell) {
    if (!cell?.dataset.thumbRendered) return;
    delete cell.dataset.thumbRendered;
    const canvas = cell.querySelector(".pdf-thumb-canvas");
    releaseCanvas(canvas);
    canvas?.remove();
    // And what pdf.js parsed to draw it: a grid scrolled end to end
    // would otherwise keep every page of the book.
    const idx = Number(cell.dataset.thumbIdx);
    viewerState.getPdfDoc()?.getPage(idx + 1).then((page) => page.cleanup()).catch(() => {});
    if (!cell.querySelector(".pdf-thumb-placeholder")) {
      const placeholder = document.createElement("div");
      placeholder.className = "pdf-thumb-placeholder";
      cell.insertBefore(placeholder, cell.firstChild);
    }
  }

  function hide() {
    if (!thumbPanel) return;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    // Drop the whole panel rather than display:none-ing it — the grid
    // is rebuilt lazily on the next show, and keeping it alive would
    // pin every rendered thumbnail canvas for the rest of the session.
    thumbPanel.remove();
    thumbPanel = null;
  }

  async function renderThumb(idx) {
    const pages = viewerState.getPages();
    const pdfDoc = viewerState.getPdfDoc();
    if (!pdfDoc || viewerState.isDestroyed() || idx < 0 || idx >= pages.length) return;
    const cell = thumbPanel?.querySelector(`[data-thumb-idx="${idx}"]`);
    if (!cell || cell.dataset.thumbRendered) return;
    cell.dataset.thumbRendered = "1";

    try {
      const page = await pdfDoc.getPage(idx + 1);
      if (viewerState.isDestroyed()) return;
      const vp = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / vp.width;
      const svp = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(svp.width);
      canvas.height = Math.round(svp.height);
      canvas.className = "pdf-thumb-canvas";

      await page.render({ canvas, viewport: svp, background: "#ffffff" }).promise;
      // Evicted (scrolled away) or torn down while rendering — drop it.
      if (viewerState.isDestroyed() || !cell.isConnected || !cell.dataset.thumbRendered) {
        releaseCanvas(canvas);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (ctx) drawAnnotations(ctx, svp, viewerState.getAnnotations(), idx);

      const ph = cell.querySelector(".pdf-thumb-placeholder");
      if (ph) ph.remove();
      cell.insertBefore(canvas, cell.firstChild);
    } catch (e) {
      console.error(`Failed to render thumbnail ${idx + 1}:`, e);
    }
  }

  function destroy() {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (thumbPanel) { thumbPanel.remove(); thumbPanel = null; }
    thumbVisible = false;
  }

  return {
    toggle,
    show,
    hide,
    destroy,
    get visible() { return thumbVisible; },
  };
}
