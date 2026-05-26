/**
 * PDF.js interactive viewer — renders a scrollable, zoomable PDF inside
 * a container. Supports both the main editor area and floating panes.
 *
 * Layout modes:
 *   - fit-width (default): pages scale to fill available width, vertical scroll
 *   - fixed zoom (50%-200%): explicit scale; pages wrap when small enough
 *   - horizontal scroll: pages fit container height, horizontal scroll
 */

import { createAnnotationLayer } from "./pdf-viewer-annotations.js";

let pdfjsPromise = null;

async function getPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const RENDER_BUFFER = 2;

const MODE_FIT_WIDTH = "fit-width";
const MODE_FIXED = "fixed";
const MODE_HORIZONTAL = "horizontal";

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string}  [opts.mode]          "main" or "pane"
 * @param {string}  [opts.zoteroAttKey]  Zotero attachment key
 */
export function createPdfViewer(container, opts = {}) {
  let pdfDoc = null;
  let pages = [];
  let layoutMode = MODE_FIT_WIDTH;
  let fixedZoom = 1.0;
  let scrollListeners = [];
  let destroyed = false;
  const root = document.createElement("div");
  root.className = "pdf-viewer";

  // ── Main body: scroll area + shelf side-by-side ──────────────────
  const body = document.createElement("div");
  body.className = "pdf-viewer-body";

  const scrollArea = document.createElement("div");
  scrollArea.className = "pdf-scroll-area pdf-layout-fit";
  body.appendChild(scrollArea);

  // ── Annotation layer (shelf + overlay rendering) ─────────────────
  const viewerState = {
    getPages: () => pages,
    getEffectiveZoom: () => getEffectiveZoom(),
    getLayoutMode: () => layoutMode,
    goToPage: (n) => goToPage(n),
  };
  const annotLayer = createAnnotationLayer(scrollArea, body, viewerState);

  root.appendChild(body);

  // ── Toolbar (bottom bar) ─────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-zoom-toolbar";

  const zoomOutBtn = btn("pdf-zoom-btn", "−", "Zoom out");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom-label";
  zoomLabel.textContent = "Fit";
  const zoomInBtn = btn("pdf-zoom-btn", "+", "Zoom in");

  const fitBtn = svgBtn("pdf-zoom-btn pdf-mode-btn active", "Fit", FIT_ICON);
  const scrollToggle = svgBtn("pdf-zoom-btn pdf-scroll-toggle", "Toggle scroll direction", VERTICAL_ICON);

  const pageIndicator = document.createElement("span");
  pageIndicator.className = "pdf-page-indicator";

  const zoteroLink = document.createElement("a");
  zoteroLink.className = "pdf-zotero-link";
  zoteroLink.textContent = "Open in Zotero ↗";
  zoteroLink.style.display = "none";

  toolbar.append(zoomOutBtn, zoomLabel, zoomInBtn, fitBtn, scrollToggle, pageIndicator, zoteroLink);
  root.appendChild(toolbar);

  container.appendChild(root);

  // ── Zotero link setup ────────────────────────────────────────────
  function setZoteroAttKey(attKey) {
    if (attKey) {
      zoteroLink.href = `zotero://open-pdf/library/items/${attKey}`;
      zoteroLink.style.display = "";
    } else {
      zoteroLink.style.display = "none";
    }
  }
  if (opts.zoteroAttKey) setZoteroAttKey(opts.zoteroAttKey);

  // ── Zoom actions ──────────────────────────────────────────────────
  function stepZoomOut() {
    const cur = getEffectiveZoom();
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < cur - 0.01) { applyFixedZoom(ZOOM_LEVELS[i]); return; }
    }
  }
  function stepZoomIn() {
    const cur = getEffectiveZoom();
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      if (ZOOM_LEVELS[i] > cur + 0.01) { applyFixedZoom(ZOOM_LEVELS[i]); return; }
    }
  }

  zoomOutBtn.addEventListener("click", stepZoomOut);
  zoomInBtn.addEventListener("click", stepZoomIn);
  let scrollDirection = "vertical";
  fitBtn.addEventListener("click", () => {
    switchMode(scrollDirection === "horizontal" ? MODE_HORIZONTAL : MODE_FIT_WIDTH);
  });
  scrollToggle.addEventListener("click", () => {
    switchMode(layoutMode === MODE_HORIZONTAL ? MODE_FIT_WIDTH : MODE_HORIZONTAL);
  });

  // ── Keyboard zoom (Cmd+/- while viewer is mounted) ──────────────
  function onKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoomIn(); }
    else if (e.key === "-") { e.preventDefault(); stepZoomOut(); }
    else if (e.key === "0") { e.preventDefault(); switchMode(MODE_FIT_WIDTH); }
  }
  window.addEventListener("keydown", onKeydown);

  // ── Observer ─────────────────────────────────────────────────────
  let observer = null;

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const idx = parseInt(entry.target.dataset.pageIndex, 10);
        if (isNaN(idx) || !pages[idx]) continue;
        if (entry.isIntersecting) {
          renderPage(idx);
          for (let b = 1; b <= RENDER_BUFFER; b++) {
            if (idx - b >= 0) renderPage(idx - b);
            if (idx + b < pages.length) renderPage(idx + b);
          }
        }
      }
    }, { root: scrollArea, rootMargin: "200px" });
    for (const p of pages) {
      if (p.wrapper) observer.observe(p.wrapper);
    }
    renderVisiblePages();
  }

  function renderVisiblePages() {
    if (!pages.length || !scrollArea.clientHeight) return;
    const areaRect = scrollArea.getBoundingClientRect();
    if (areaRect.width === 0 && areaRect.height === 0) return;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (p.rendered || !p.wrapper) continue;
      const r = p.wrapper.getBoundingClientRect();
      if (r.bottom < areaRect.top - 200 || r.top > areaRect.bottom + 200) continue;
      renderPage(i);
    }
  }

  // ── Zoom calculations ────────────────────────────────────────────
  function getEffectiveZoom() {
    if (!pages.length || !pdfDoc) return 1;
    const first = pages[0];
    if (!first?.viewport) return 1;
    if (layoutMode === MODE_FIT_WIDTH) {
      const pad = 40;
      return (scrollArea.clientWidth - pad) / first.viewport.width;
    }
    if (layoutMode === MODE_HORIZONTAL) {
      const pad = 40;
      return (scrollArea.clientHeight - pad) / first.viewport.height;
    }
    return fixedZoom;
  }

  function updateToolbarState() {
    const z = getEffectiveZoom();
    const isFit = layoutMode === MODE_FIT_WIDTH || layoutMode === MODE_HORIZONTAL;
    zoomLabel.textContent = isFit ? "Fit" : `${Math.round(z * 100)}%`;
    fitBtn.classList.toggle("active", isFit);
    scrollToggle.innerHTML = layoutMode === MODE_HORIZONTAL ? HORIZONTAL_ICON : VERTICAL_ICON;
  }

  function updatePageIndicator() {
    if (!pages.length) { pageIndicator.textContent = ""; return; }
    if (layoutMode === MODE_HORIZONTAL) {
      const scrollMid = scrollArea.scrollLeft + scrollArea.clientWidth / 2;
      let cur = 1;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].wrapper && pages[i].wrapper.offsetLeft <= scrollMid) cur = i + 1;
      }
      pageIndicator.textContent = `${cur} / ${pages.length}`;
    } else {
      const scrollMid = scrollArea.scrollTop + scrollArea.clientHeight / 2;
      let cur = 1;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].wrapper && pages[i].wrapper.offsetTop <= scrollMid) cur = i + 1;
      }
      pageIndicator.textContent = `${cur} / ${pages.length}`;
    }
  }

  scrollArea.addEventListener("scroll", () => {
    updatePageIndicator();
    for (const cb of scrollListeners) cb();
  });

  // ── Mode switching ───────────────────────────────────────────────
  function switchMode(mode) {
    if (mode === layoutMode) return;
    layoutMode = mode;
    if (mode === MODE_HORIZONTAL) scrollDirection = "horizontal";
    else if (mode === MODE_FIT_WIDTH) scrollDirection = "vertical";
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function applyFixedZoom(level) {
    fixedZoom = level;
    layoutMode = MODE_FIXED;
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function applyLayoutClass() {
    scrollArea.classList.remove("pdf-layout-fit", "pdf-layout-fixed", "pdf-layout-horizontal");
    if (layoutMode === MODE_FIT_WIDTH) scrollArea.classList.add("pdf-layout-fit");
    else if (layoutMode === MODE_HORIZONTAL) scrollArea.classList.add("pdf-layout-horizontal");
    else scrollArea.classList.add("pdf-layout-fixed");
  }

  // ── Page rendering ───────────────────────────────────────────────
  async function renderPage(idx) {
    const p = pages[idx];
    if (!p || p.rendered || p.rendering || destroyed) return;
    p.rendering = true;
    try {
      const page = await pdfDoc.getPage(idx + 1);
      if (destroyed) return;
      const scale = getEffectiveZoom();
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.className = "pdf-page-canvas";

      const renderTask = page.render({ canvas, viewport, background: "#ffffff" });
      await renderTask.promise;
      if (destroyed) return;

      p.wrapper.style.width = `${canvas.width}px`;
      p.wrapper.style.height = `${canvas.height}px`;
      const placeholder = p.wrapper.querySelector(".pdf-page-placeholder");
      if (placeholder) placeholder.remove();
      p.wrapper.insertBefore(canvas, p.wrapper.firstChild);
      p.rendered = true;
      p.renderedZoom = scale;
      p.canvas = canvas;
      annotLayer.paintAnnotationsOnPage(idx);
    } catch (e) {
      console.error(`Failed to render page ${idx + 1}:`, e);
    } finally {
      p.rendering = false;
    }
  }

  function clearPage(idx) {
    const p = pages[idx];
    if (!p || !p.rendered) return;
    if (p.canvas) { p.canvas.remove(); p.canvas = null; }
    const annotOverlay = p.wrapper.querySelector(".pdf-annot-layer");
    if (annotOverlay) annotOverlay.remove();
    const placeholder = document.createElement("div");
    placeholder.className = "pdf-page-placeholder";
    p.wrapper.insertBefore(placeholder, p.wrapper.firstChild);
    p.rendered = false;
    p.renderedZoom = null;
  }

  let relayoutGuard = false;
  function relayoutPages() {
    if (relayoutGuard || !pdfDoc || !pages.length || suspended) return;
    relayoutGuard = true;
    try {
      const scale = getEffectiveZoom();
      let zoomChanged = false;
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const w = Math.round(p.viewport.width * scale);
        const h = Math.round(p.viewport.height * scale);
        p.wrapper.style.width = `${w}px`;
        p.wrapper.style.height = `${h}px`;
        if (p.rendered && Math.abs(p.renderedZoom - scale) > 0.001) {
          clearPage(i);
          zoomChanged = true;
        }
      }
      if (zoomChanged || !observer) {
        if (observer) observer.disconnect();
        setupObserver();
      } else {
        renderVisiblePages();
      }
    } finally {
      relayoutGuard = false;
    }
  }

  // ── Load ─────────────────────────────────────────────────────────
  async function loadPdf(data) {
    const pdfjs = await getPdfjs();
    if (destroyed) return;
    if (pdfDoc) { await pdfDoc.destroy(); pdfDoc = null; }
    pages = [];
    scrollArea.innerHTML = "";

    let input;
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      input = { data: data instanceof ArrayBuffer ? new Uint8Array(data) : data };
    } else if (typeof data === "string" && data.startsWith("data:")) {
      const raw = atob(data.split(",")[1]);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      input = { data: arr };
    } else if (Array.isArray(data)) {
      input = { data: new Uint8Array(data) };
    } else {
      input = { data };
    }

    pdfDoc = await pdfjs.getDocument(input).promise;
    if (destroyed) { await pdfDoc.destroy(); pdfDoc = null; return; }

    applyLayoutClass();

    for (let i = 0; i < pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });
      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page-wrapper";
      wrapper.dataset.pageIndex = i;
      const scale = getEffectiveZoom();
      wrapper.style.width = `${Math.round(viewport.width * scale)}px`;
      wrapper.style.height = `${Math.round(viewport.height * scale)}px`;
      const placeholder = document.createElement("div");
      placeholder.className = "pdf-page-placeholder";
      wrapper.appendChild(placeholder);
      scrollArea.appendChild(wrapper);
      pages.push({ wrapper, viewport, rendered: false, rendering: false, canvas: null, renderedZoom: null });
    }

    setupObserver();
    updateToolbarState();
    updatePageIndicator();
  }

  function setZoom(level) {
    if (level < 0) { switchMode(MODE_FIT_WIDTH); return; }
    applyFixedZoom(level);
  }
  function getZoom() {
    if (layoutMode === MODE_FIT_WIDTH) return -1;
    if (layoutMode === MODE_HORIZONTAL) return -2;
    return fixedZoom;
  }

  function goToPage(n) {
    const idx = Math.max(0, Math.min(n - 1, pages.length - 1));
    if (pages[idx]?.wrapper) {
      if (layoutMode === MODE_HORIZONTAL) {
        pages[idx].wrapper.scrollIntoView({ behavior: "smooth", inline: "start" });
      } else {
        pages[idx].wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  function getPageCount() { return pdfDoc ? pdfDoc.numPages : 0; }
  function getScrollTop() { return scrollArea.scrollTop; }
  function setScrollTop(v) { scrollArea.scrollTop = v; }
  function onScroll(cb) {
    scrollListeners.push(cb);
    return () => { scrollListeners = scrollListeners.filter(c => c !== cb); };
  }

  // ── Suspend / Resume (lightweight snapshot for inactive panes) ────
  let suspended = false;
  let suspendImg = null;
  let cachedPdfData = null;

  function suspend() {
    if (suspended || destroyed || !pdfDoc) return;
    suspended = true;
    window.removeEventListener("keydown", onKeydown);
    if (resizeObserver) resizeObserver.disconnect();
    if (observer) { observer.disconnect(); observer = null; }

    const savedScroll = scrollArea.scrollTop;
    const savedScrollLeft = scrollArea.scrollLeft;

    try {
      const snapshot = document.createElement("canvas");
      const w = scrollArea.clientWidth;
      const h = scrollArea.clientHeight;
      if (w > 0 && h > 0) {
        snapshot.width = w;
        snapshot.height = h;
        const ctx = snapshot.getContext("2d");
        ctx.fillStyle = "#f5f5f5";
        ctx.fillRect(0, 0, w, h);
        for (const p of pages) {
          if (!p.rendered || !p.canvas) continue;
          const rect = p.wrapper.getBoundingClientRect();
          const areaRect = scrollArea.getBoundingClientRect();
          const dx = rect.left - areaRect.left;
          const dy = rect.top - areaRect.top;
          if (dy + rect.height < 0 || dy > h) continue;
          ctx.drawImage(p.canvas, dx, dy, rect.width, rect.height);
        }
        suspendImg = document.createElement("img");
        suspendImg.className = "pdf-suspend-snapshot";
        suspendImg.src = snapshot.toDataURL("image/jpeg", 0.85);
        suspendImg.style.width = w + "px";
        suspendImg.style.height = h + "px";
      }
    } catch (_) {}

    for (let i = 0; i < pages.length; i++) clearPage(i);
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
    pages = [];
    scrollArea.innerHTML = "";

    if (suspendImg) {
      scrollArea.appendChild(suspendImg);
      scrollArea.classList.add("pdf-suspended");
    }

    scrollArea.scrollTop = savedScroll;
    scrollArea.scrollLeft = savedScrollLeft;
  }

  async function resume() {
    if (!suspended || destroyed) return;
    suspended = false;
    scrollArea.classList.remove("pdf-suspended");
    if (suspendImg) { suspendImg.remove(); suspendImg = null; }

    window.addEventListener("keydown", onKeydown);
    if (resizeObserver) {
      try { resizeObserver.observe(scrollArea); } catch (_) {}
    }

    if (cachedPdfData) {
      const savedAnnotations = annotLayer.getAnnotations().slice();
      await loadPdf(cachedPdfData);
      if (savedAnnotations.length) annotLayer.setAnnotations(savedAnnotations);
    }
  }

  // Wrap loadPdf to cache the raw data for resume
  const _origLoadPdf = loadPdf;
  async function loadPdfAndCache(data) {
    if (data instanceof Uint8Array) cachedPdfData = new Uint8Array(data);
    else if (Array.isArray(data)) cachedPdfData = new Uint8Array(data);
    else cachedPdfData = data;
    await _origLoadPdf(data);
  }

  // ── Cleanup ──────────────────────────────────────────────────────
  async function destroy() {
    destroyed = true;
    window.removeEventListener("keydown", onKeydown);
    if (observer) { observer.disconnect(); observer = null; }
    scrollListeners = [];
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
    pages = [];
    root.remove();
  }

  let resizeObserver = null;
  let resizeTimer = null;
  try {
    resizeObserver = new ResizeObserver(() => {
      if (layoutMode === MODE_FIXED || !pages.length || suspended) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; relayoutPages(); }, 80);
    });
    resizeObserver.observe(scrollArea);
  } catch (_) {}

  return {
    loadPdf: loadPdfAndCache,
    destroy: async () => {
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      await destroy();
    },
    suspend,
    resume,
    get suspended() { return suspended; },
    setZoom,
    getZoom,
    goToPage,
    getPageCount,
    getScrollTop,
    setScrollTop,
    onScroll,
    setAnnotations: annotLayer.setAnnotations,
    refreshAnnotations: annotLayer.refreshAnnotations,
    setZoteroAttKey,
    toggleShelf: annotLayer.toggleShelf,
    get element() { return root; },
  };
}

function btn(cls, text, title) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.title = title;
  return b;
}

function svgBtn(cls, title, svgContent) {
  const b = document.createElement("button");
  b.className = cls;
  b.title = title;
  b.innerHTML = svgContent;
  return b;
}

// Pages stacked vertically (vertical scroll — current mode indicator)
const VERTICAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="1" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="3" y="9" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Pages side by side (horizontal scroll — current mode indicator)
const HORIZONTAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="3" width="6" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="3" width="6" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Fit: outward-pointing arrows
const FIT_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><polyline points="1,5 1,1 5,1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="11,1 15,1 15,5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="15,11 15,15 11,15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5,15 1,15 1,11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
