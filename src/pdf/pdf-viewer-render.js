/**
 * Page raster policy for the PDF viewer — extracted from pdf-viewer.js.
 *
 * Owns which pages hold a live canvas and at what resolution. The old
 * IntersectionObserver pipeline only ever *rendered* pages as they
 * scrolled into view and never let go of them, so reading through a
 * large PDF accumulated every page's devicePixelRatio-sized canvas
 * until iPadOS killed the webview. This module replaces it with one
 * explicit render set:
 *
 *  - `update()` computes the visible page range from the scroll
 *    position, renders the range plus RENDER_BUFFER pages either side,
 *    and **evicts** rendered pages outside a slightly wider keep range
 *    — memory stays bounded by the window, not the document.
 *  - `scheduleUpdate()` is the rAF-coalesced scroll driver.
 *  - `scheduleSettle()` is the post-resize/zoom crisp pass: while a
 *    pane is being drag-resized the viewer only *stretches* the
 *    existing rasters (CSS transform — no canvas work at all), and the
 *    settle pass re-renders at the true scale once the geometry has
 *    been still for a beat.
 *  - In-flight pdfjs render tasks are cancelled when their page is
 *    cleared, so a resize burst can't pile canvases up mid-drag.
 *  - Canvas resolution is capped (`capRenderScale`) — iOS enforces
 *    hard canvas-memory limits, and an uncapped scale × dpr render of
 *    a large page can blow straight past them.
 *
 * Page records live on the viewer's shared `pages[]` array; this module
 * reads them through `env.getPages()` so a reload (which reassigns the
 * array) needs no re-wiring.
 */

const RENDER_BUFFER = 2;    // pages rendered beyond the visible range
const KEEP_EXTRA = 2;       // extra pages kept before eviction kicks in
const VISIBLE_MARGIN = 200; // px of scroll slack counted as "visible"
const SETTLE_MS = 200;      // quiet period before the crisp re-render

const IS_IOS = typeof navigator !== "undefined" && (
  /iP(ad|hone|od)/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Hard ceiling on canvas pixels per page. iOS WKWebView enforces a
 *  total canvas-memory budget well below desktop's, so cap earlier. */
export const MAX_CANVAS_PIXELS = IS_IOS ? 8_000_000 : 16_777_216;

/** Clamp a render scale so `viewport1` (scale-1 viewport) rasterised at
 *  the returned scale stays under MAX_CANVAS_PIXELS. */
export function capRenderScale(scale, viewport1) {
  const px = viewport1.width * viewport1.height * scale * scale;
  return px > MAX_CANVAS_PIXELS ? scale * Math.sqrt(MAX_CANVAS_PIXELS / px) : scale;
}

function isCancelError(e) {
  return e && (e.name === "RenderingCancelledException" || /cancelled/i.test(e.message || ""));
}

/**
 * @param {HTMLElement} scrollArea
 * @param {object} env
 * @param {function} env.getPages          () => pages[]
 * @param {function} env.getPdfDoc         () => pdfjs doc | null
 * @param {function} env.getEffectiveZoom  () => number (CSS scale)
 * @param {function} env.getLayoutMode     () => "horizontal" | "vertical" | "fixed"
 * @param {function} env.isFolded          () => boolean
 * @param {function} env.isDestroyed       () => boolean
 * @param {function} env.isSuspended       () => boolean
 * @param {function} env.onPageRendered    (idx, pageProxy) => void — annotation + link layers
 */
export function createPageRenderer(scrollArea, env) {
  let updateRaf = 0;
  let settleTimer = null;

  /** Visible page index range [first, last], or null when nothing is. */
  function visibleRange() {
    const pages = env.getPages();
    if (!pages.length) return null;
    const horiz = env.getLayoutMode() === "horizontal";
    const size = horiz ? scrollArea.clientWidth : scrollArea.clientHeight;
    if (!size) return null;
    const start = (horiz ? scrollArea.scrollLeft : scrollArea.scrollTop) - VISIBLE_MARGIN;
    const end = start + size + VISIBLE_MARGIN * 2;
    let first = -1, last = -1;
    for (let i = 0; i < pages.length; i++) {
      const w = pages[i].wrapper;
      if (!w) continue;
      const a = horiz ? w.offsetLeft : w.offsetTop;
      const b = a + (horiz ? w.offsetWidth : w.offsetHeight);
      if (b >= start && a <= end) { if (first < 0) first = i; last = i; }
      // Pages are laid out in order — once we're past the window (and
      // have a range) nothing later can re-enter it.
      else if (first >= 0 && a > end) break;
    }
    return first < 0 ? null : [first, last];
  }

  /** Render the visible range (+buffer), evict outside the keep range. */
  function update() {
    if (env.isDestroyed() || env.isSuspended() || env.isFolded()) return;
    const pages = env.getPages();
    const range = visibleRange();
    if (!range) return;
    const [first, last] = range;
    const rFrom = Math.max(0, first - RENDER_BUFFER);
    const rTo = Math.min(pages.length - 1, last + RENDER_BUFFER);
    const keepFrom = rFrom - KEEP_EXTRA;
    const keepTo = rTo + KEEP_EXTRA;
    for (let i = 0; i < pages.length; i++) {
      if (i >= rFrom && i <= rTo) {
        if (!pages[i].rendered) renderPage(i);
      } else if ((i < keepFrom || i > keepTo) && (pages[i].rendered || pages[i].rendering)) {
        clearPage(i);
      }
    }
  }

  function scheduleUpdate() {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => { updateRaf = 0; update(); });
  }

  /** Crisp pass after zoom / resize: re-render in-range pages whose
   *  raster no longer matches the effective zoom, evict the rest. */
  function scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (env.isDestroyed() || env.isSuspended() || env.isFolded()) return;
      const scale = env.getEffectiveZoom();
      const pages = env.getPages();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        if (p.rendered && Math.abs((p.renderedZoom ?? scale) - scale) > 0.001) clearPage(i);
      }
      update();
    }, SETTLE_MS);
  }

  async function renderPage(idx) {
    const pages = env.getPages();
    const p = pages[idx];
    if (!p || p.rendered || p.rendering || env.isDestroyed() || env.isFolded()) return;
    const pdfDoc = env.getPdfDoc();
    if (!pdfDoc) return;
    p.rendering = true;
    p.cancelled = false;
    try {
      const page = await pdfDoc.getPage(idx + 1);
      if (env.isDestroyed() || p.cancelled || pages !== env.getPages()) return;

      // Wrappers are seeded from page 1's size so opening doesn't have
      // to fetch every page proxy up front; adopt the real dimensions
      // the first time the page actually renders.
      if (!p.realViewport) {
        const vp1 = page.getViewport({ scale: 1 });
        p.realViewport = true;
        if (Math.abs(vp1.width - p.viewport.width) > 0.5 || Math.abs(vp1.height - p.viewport.height) > 0.5) {
          p.viewport = vp1;
          const s = env.getEffectiveZoom();
          p.wrapper.style.width = `${Math.round(vp1.width * s)}px`;
          p.wrapper.style.height = `${Math.round(vp1.height * s)}px`;
        }
      }

      const scale = env.getEffectiveZoom();
      const dpr = window.devicePixelRatio || 1;
      const renderScale = capRenderScale(scale * dpr, p.viewport);
      const viewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.className = "pdf-page-canvas";

      const task = page.render({ canvas, viewport, background: "#ffffff" });
      p.renderTask = task;
      await task.promise;
      p.renderTask = null;
      if (env.isDestroyed() || p.cancelled || pages !== env.getPages()) return;

      // The canvas lives inside a content box sized at paint-time CSS
      // px; annotation + link layers join it there, so a later CSS
      // stretch (drag-resize) scales the whole sandwich coherently.
      const cssW = Math.round(p.viewport.width * scale);
      const cssH = Math.round(p.viewport.height * scale);
      const content = document.createElement("div");
      content.className = "pdf-page-content";
      content.style.width = `${cssW}px`;
      content.style.height = `${cssH}px`;
      content.appendChild(canvas);
      p.wrapper.querySelector(".pdf-page-placeholder")?.remove();
      if (p.contentEl) p.contentEl.remove();
      p.wrapper.insertBefore(content, p.wrapper.firstChild);
      p.contentEl = content;
      p.contentW = cssW;
      p.contentH = cssH;
      p.rendered = true;
      p.renderedZoom = scale;
      p.canvas = canvas;
      // Wrapper resized while we rendered (mid-drag) — stretch to match.
      const curW = parseFloat(p.wrapper.style.width) || cssW;
      if (Math.abs(curW - cssW) > 0.5) content.style.transform = `scale(${curW / cssW})`;
      env.onPageRendered(idx, page);
    } catch (e) {
      if (!isCancelError(e)) console.error(`Failed to render page ${idx + 1}:`, e);
    } finally {
      p.rendering = false;
      p.renderTask = null;
    }
  }

  function clearPage(idx) {
    const p = env.getPages()[idx];
    if (!p) return;
    if (p.rendering) {
      p.cancelled = true;
      try { p.renderTask?.cancel(); } catch (_) {}
    }
    if (!p.rendered && !p.contentEl) return;
    if (p.contentEl) { p.contentEl.remove(); p.contentEl = null; }
    p.canvas = null;
    p.contentW = 0;
    p.contentH = 0;
    if (!p.wrapper.querySelector(".pdf-page-placeholder")) {
      const placeholder = document.createElement("div");
      placeholder.className = "pdf-page-placeholder";
      p.wrapper.insertBefore(placeholder, p.wrapper.firstChild);
    }
    p.rendered = false;
    p.renderedZoom = null;
  }

  function clearAll() {
    const pages = env.getPages();
    for (let i = 0; i < pages.length; i++) clearPage(i);
  }

  function destroy() {
    if (updateRaf) { cancelAnimationFrame(updateRaf); updateRaf = 0; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  }

  return { update, scheduleUpdate, scheduleSettle, renderPage, clearPage, clearAll, destroy };
}
