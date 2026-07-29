/**
 * Page raster policy for the PDF viewer — extracted from pdf-viewer.js.
 *
 * Owns which pages hold a live canvas, at what resolution, and when
 * they let go of it. Two constraints pull against each other:
 *
 *  - **Memory must stay bounded** — the pre-rework viewer never freed a
 *    page, so reading a large PDF accumulated canvases until iPadOS
 *    killed the webview.
 *  - **Scrolling must stay cheap** — the first cut of the fix evicted
 *    everything a couple of pages outside the viewport, per frame, so
 *    ordinary reading re-rasterised constantly and janked the scroll.
 *
 * The resolution here:
 *
 *  - The scroll path does **zero DOM reads**: page offsets are cached
 *    once per geometry change (`ensureGeometry`) and the visible range
 *    is a binary search over that cache. The page indicator reads the
 *    same cache (`pageAtViewCenter`).
 *  - Rendering is a small **priority queue** — visible pages first,
 *    then the buffer by distance — drained with limited concurrency
 *    (1 on iOS, 2 elsewhere) and rebuilt on every update, so a fling
 *    never stacks up stale raster work; in-flight renders whose page
 *    left the window are cancelled.
 *  - Rendered pages are **kept** until a canvas-byte budget (tighter on
 *    iOS) or a page-count cap is exceeded, and eviction runs only when
 *    scrolling goes idle — never per frame. Scrolling back over
 *    recently-read pages costs nothing, exactly like the old viewer,
 *    but the total canvas footprint stays bounded.
 *  - Canvas resolution is capped per page (`capRenderScale`) — iOS
 *    enforces hard canvas-memory limits.
 *  - `scheduleSettle()` is the post-resize/zoom crisp pass: the viewer
 *    only *stretches* existing rasters during a drag (CSS transform),
 *    and the settle pass re-renders at the true scale once the
 *    geometry has been still for a beat.
 *
 * Page records live on the viewer's shared `pages[]` array; this module
 * reads them through `env.getPages()` so a reload (which reassigns the
 * array) needs no re-wiring.
 */

const RENDER_BUFFER = 2;    // pages rendered beyond the visible range
const VISIBLE_MARGIN = 200; // px of scroll slack counted as "visible"
const SETTLE_MS = 200;      // quiet period before the crisp re-render
const EVICT_IDLE_MS = 300;  // quiet period before over-budget eviction

const IS_IOS = typeof navigator !== "undefined" && (
  /iP(ad|hone|od)/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Hard ceiling on canvas pixels per page. iOS WKWebView enforces a
 *  total canvas-memory budget well below desktop's, so cap earlier. */
export const MAX_CANVAS_PIXELS = IS_IOS ? 8_000_000 : 16_777_216;

/** Total canvas bytes kept across rendered pages before idle eviction
 *  starts trimming the farthest-away ones, plus a count cap so a sea
 *  of tiny fit-3 pages can't hoard thousands of small canvases. */
const KEEP_BUDGET_BYTES = IS_IOS ? 192_000_000 : 512_000_000;
const KEEP_MAX_PAGES = IS_IOS ? 24 : 48;
const MAX_CONCURRENT_RENDERS = IS_IOS ? 1 : 2;

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
 * @param {function} [env.onUpdate]        () => void — after each render-set update (page indicator)
 */
export function createPageRenderer(scrollArea, env) {
  let updateRaf = 0;
  let settleTimer = null;
  let idleTimer = null;
  // Cached page geometry along the scroll axis — starts/sizes read from
  // the DOM once per invalidation, then every scroll-path query is pure
  // arithmetic. Content swaps (render/evict) never change wrapper
  // geometry, so the cache stays valid across them.
  let geom = null;
  let renderedBytes = 0;
  let queue = [];
  let inFlight = 0;
  const inFlightIdx = new Set();
  let lastRange = null;

  function invalidateGeometry() { geom = null; }

  function ensureGeometry() {
    const pages = env.getPages();
    if (geom && geom.pages === pages && geom.count === pages.length) return geom;
    const horiz = env.getLayoutMode() === "horizontal";
    const starts = new Float64Array(pages.length);
    const sizes = new Float64Array(pages.length);
    for (let i = 0; i < pages.length; i++) {
      const w = pages[i].wrapper;
      if (!w) continue;
      starts[i] = horiz ? w.offsetLeft : w.offsetTop;
      sizes[i] = horiz ? w.offsetWidth : w.offsetHeight;
    }
    geom = { pages, count: pages.length, horiz, starts, sizes };
    return geom;
  }

  /** Rightmost index whose start ≤ `pos` (starts are laid out in order,
   *  so they're non-decreasing). */
  function indexAt(g, pos) {
    let lo = 0, hi = g.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Visible page index range [first, last], or null when nothing is. */
  function visibleRange() {
    const g = ensureGeometry();
    if (!g.count) return null;
    const size = g.horiz ? scrollArea.clientWidth : scrollArea.clientHeight;
    if (!size) return null;
    const start = (g.horiz ? scrollArea.scrollLeft : scrollArea.scrollTop) - VISIBLE_MARGIN;
    const end = start + size + VISIBLE_MARGIN * 2;
    let last = indexAt(g, end);
    if (g.starts[last] > end) return null; // everything starts past the window
    let first = last;
    // Walk left while the preceding page still reaches into the window
    // (also covers fit-2/3 rows, whose members share a start).
    while (first > 0 && g.starts[first - 1] + g.sizes[first - 1] >= start) first--;
    while (first < last && g.starts[first] + g.sizes[first] < start) first++;
    return [first, last];
  }

  /** 1-based page number at the viewport's centre (page indicator). */
  function pageAtViewCenter() {
    const g = ensureGeometry();
    if (!g.count) return 1;
    const mid = g.horiz
      ? scrollArea.scrollLeft + scrollArea.clientWidth / 2
      : scrollArea.scrollTop + scrollArea.clientHeight / 2;
    return indexAt(g, mid) + 1;
  }

  /** Recompute the render window and the raster queue. No eviction here
   *  — that waits for idle (`scheduleIdleEvict`) so scrolling never
   *  pays for DOM teardown mid-frame. */
  function update() {
    if (env.isDestroyed() || env.isSuspended() || env.isFolded()) return;
    const range = visibleRange();
    if (!range) return;
    lastRange = range;
    const pages = env.getPages();
    const [first, last] = range;
    const rFrom = Math.max(0, first - RENDER_BUFFER);
    const rTo = Math.min(pages.length - 1, last + RENDER_BUFFER);
    // Priority: visible pages in order, then buffer pages by distance
    // (ahead-of-scroll before behind).
    const wanted = [];
    for (let i = first; i <= last; i++) wanted.push(i);
    for (let b = 1; b <= RENDER_BUFFER; b++) {
      if (last + b <= rTo) wanted.push(last + b);
      if (first - b >= rFrom) wanted.push(first - b);
    }
    queue = wanted.filter((i) => {
      const p = pages[i];
      return p && !p.rendered && !p.rendering;
    });
    // A fling can leave a render in flight for a page that's now far
    // away — cancel it rather than finishing raster work nobody sees.
    for (const i of [...inFlightIdx]) {
      if (i < rFrom || i > rTo) clearPage(i);
    }
    pump();
    // Belt-and-braces: a long fling can render pages faster than idle
    // eviction reclaims them; far over budget, trim inline.
    if (renderedBytes > KEEP_BUDGET_BYTES * 1.5) evictOverBudget();
    scheduleIdleEvict();
    env.onUpdate?.();
  }

  function scheduleUpdate() {
    if (updateRaf) return;
    updateRaf = requestAnimationFrame(() => { updateRaf = 0; update(); });
  }

  function pump() {
    while (inFlight < MAX_CONCURRENT_RENDERS && queue.length) {
      const idx = queue.shift();
      const p = env.getPages()[idx];
      if (!p || p.rendered || p.rendering) continue;
      inFlight++;
      inFlightIdx.add(idx);
      renderPage(idx).catch(() => {}).finally(() => {
        inFlight--;
        inFlightIdx.delete(idx);
        pump();
      });
    }
  }

  /** Crisp pass after zoom / resize: drop every raster whose scale no
   *  longer matches (they're CSS-stretched in the meantime), then
   *  re-render the window. */
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

  /** Trim the farthest-from-view rendered pages once over budget.
   *  Runs on scroll idle, after settle, and inline only when far past
   *  the ceiling. Pages inside the render window are never evicted. */
  function evictOverBudget() {
    if (!lastRange) return;
    const pages = env.getPages();
    const rendered = [];
    for (let i = 0; i < pages.length; i++) if (pages[i].rendered) rendered.push(i);
    if (renderedBytes <= KEEP_BUDGET_BYTES && rendered.length <= KEEP_MAX_PAGES) return;
    const [first, last] = lastRange;
    const rFrom = first - RENDER_BUFFER;
    const rTo = last + RENDER_BUFFER;
    const dist = (i) => (i < first ? first - i : i > last ? i - last : 0);
    rendered.sort((a, b) => dist(b) - dist(a)); // farthest first
    let count = rendered.length;
    for (const i of rendered) {
      if (i >= rFrom && i <= rTo) break; // reached the protected window
      clearPage(i);
      count--;
      if (renderedBytes <= KEEP_BUDGET_BYTES * 0.9 && count <= KEEP_MAX_PAGES) break;
    }
  }

  function scheduleIdleEvict() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; evictOverBudget(); }, EVICT_IDLE_MS);
  }

  async function renderPage(idx) {
    const pages = env.getPages();
    const p = pages[idx];
    if (!p || p.rendered || p.rendering || env.isDestroyed() || env.isFolded()) return;
    const pdfDoc = env.getPdfDoc();
    if (!pdfDoc) return;
    p.rendering = true;
    p.cancelled = false;
    // Spinner only on placeholders actually being worked on — an idle
    // (evicted / not-yet-reached) placeholder animating costs style
    // recalcs across the whole document for nothing.
    p.wrapper.querySelector(".pdf-page-placeholder")?.classList.add("loading");
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
          invalidateGeometry(); // downstream offsets shifted
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
      p.canvasBytes = canvas.width * canvas.height * 4;
      renderedBytes += p.canvasBytes;
      // Wrapper resized while we rendered (mid-drag) — stretch to match.
      const curW = parseFloat(p.wrapper.style.width) || cssW;
      if (Math.abs(curW - cssW) > 0.5) content.style.transform = `scale(${curW / cssW})`;
      env.onPageRendered(idx, page);
    } catch (e) {
      if (!isCancelError(e)) console.error(`Failed to render page ${idx + 1}:`, e);
    } finally {
      p.rendering = false;
      p.renderTask = null;
      if (!p.rendered) p.wrapper.querySelector(".pdf-page-placeholder")?.classList.remove("loading");
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
    if (p.rendered) renderedBytes -= p.canvasBytes || 0;
    p.canvasBytes = 0;
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
    renderedBytes = 0;
  }

  /** Forget everything cached about the current document — call before
   *  a (re)load swaps the pages array out. */
  function reset() {
    queue = [];
    lastRange = null;
    renderedBytes = 0;
    invalidateGeometry();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  }

  function destroy() {
    if (updateRaf) { cancelAnimationFrame(updateRaf); updateRaf = 0; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  return {
    update, scheduleUpdate, scheduleSettle,
    clearPage, clearAll, reset, destroy,
    invalidateGeometry, pageAtViewCenter,
  };
}
