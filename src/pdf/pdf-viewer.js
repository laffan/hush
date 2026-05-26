/**
 * PDF.js interactive viewer — renders a scrollable, zoomable PDF inside
 * a container. Supports both the main editor area and floating panes.
 *
 * Pages are lazily rendered via IntersectionObserver: only visible pages
 * (plus a small buffer) are rendered to canvas; off-screen pages are
 * freed to keep memory usage bounded for large PDFs.
 *
 * Annotation overlays from Zotero can be painted on top of each page
 * via the `setAnnotations` method.
 */

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
const PAGE_GAP = 12;
const RENDER_BUFFER = 2;

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.mode]  "main" or "pane"
 * @returns {{ loadPdf, destroy, setZoom, getZoom, goToPage, getPageCount,
 *             getScrollTop, setScrollTop, onScroll, setAnnotations, refreshAnnotations }}
 */
export function createPdfViewer(container, opts = {}) {
  let pdfDoc = null;
  let pages = [];
  let zoom = -1; // -1 = fit-to-width
  let annotations = [];
  let scrollListeners = [];
  let destroyed = false;

  const root = document.createElement("div");
  root.className = "pdf-viewer";

  const toolbar = document.createElement("div");
  toolbar.className = "pdf-zoom-toolbar";
  toolbar.innerHTML = `
    <button class="pdf-zoom-btn pdf-zoom-out" title="Zoom out">−</button>
    <span class="pdf-zoom-label">Fit</span>
    <button class="pdf-zoom-btn pdf-zoom-in" title="Zoom in">+</button>
    <button class="pdf-zoom-btn pdf-zoom-fit" title="Fit to width">↔</button>
    <span class="pdf-page-indicator"></span>
  `;
  root.appendChild(toolbar);

  const scrollArea = document.createElement("div");
  scrollArea.className = "pdf-scroll-area";
  root.appendChild(scrollArea);

  container.appendChild(root);

  const zoomOutBtn = toolbar.querySelector(".pdf-zoom-out");
  const zoomInBtn = toolbar.querySelector(".pdf-zoom-in");
  const zoomFitBtn = toolbar.querySelector(".pdf-zoom-fit");
  const zoomLabel = toolbar.querySelector(".pdf-zoom-label");
  const pageIndicator = toolbar.querySelector(".pdf-page-indicator");

  zoomOutBtn.addEventListener("click", () => {
    const current = getEffectiveZoom();
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < current - 0.01) { setZoom(ZOOM_LEVELS[i]); return; }
    }
  });
  zoomInBtn.addEventListener("click", () => {
    const current = getEffectiveZoom();
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      if (ZOOM_LEVELS[i] > current + 0.01) { setZoom(ZOOM_LEVELS[i]); return; }
    }
  });
  zoomFitBtn.addEventListener("click", () => setZoom(-1));

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
    }, { root: scrollArea, rootMargin: "200px 0px" });

    for (const p of pages) {
      if (p.wrapper) observer.observe(p.wrapper);
    }
  }

  function getEffectiveZoom() {
    if (zoom > 0) return zoom;
    if (!pages.length || !pdfDoc) return 1;
    const containerWidth = scrollArea.clientWidth - 40;
    const firstPage = pages[0];
    if (!firstPage?.viewport) return 1;
    return containerWidth / firstPage.viewport.width;
  }

  function updateZoomLabel() {
    const z = getEffectiveZoom();
    zoomLabel.textContent = zoom < 0 ? "Fit" : `${Math.round(z * 100)}%`;
  }

  function updatePageIndicator() {
    if (!pages.length) { pageIndicator.textContent = ""; return; }
    const scrollTop = scrollArea.scrollTop;
    const scrollMid = scrollTop + scrollArea.clientHeight / 2;
    let currentPage = 1;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].wrapper && pages[i].wrapper.offsetTop <= scrollMid) {
        currentPage = i + 1;
      }
    }
    pageIndicator.textContent = `${currentPage} / ${pages.length}`;
  }

  scrollArea.addEventListener("scroll", () => {
    updatePageIndicator();
    for (const cb of scrollListeners) cb();
  });

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

      paintAnnotationsOnPage(idx);
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
    const annotLayer = p.wrapper.querySelector(".pdf-annot-layer");
    if (annotLayer) annotLayer.remove();
    const placeholder = document.createElement("div");
    placeholder.className = "pdf-page-placeholder";
    p.wrapper.insertBefore(placeholder, p.wrapper.firstChild);
    p.rendered = false;
    p.renderedZoom = null;
  }

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

    for (let i = 0; i < pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });

      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page-wrapper";
      wrapper.dataset.pageIndex = i;

      const scale = getEffectiveZoom();
      const scaledW = Math.round(viewport.width * scale);
      const scaledH = Math.round(viewport.height * scale);
      wrapper.style.width = `${scaledW}px`;
      wrapper.style.height = `${scaledH}px`;

      const placeholder = document.createElement("div");
      placeholder.className = "pdf-page-placeholder";
      wrapper.appendChild(placeholder);

      scrollArea.appendChild(wrapper);
      pages.push({ wrapper, viewport, rendered: false, rendering: false, canvas: null, renderedZoom: null });
    }

    setupObserver();
    updateZoomLabel();
    updatePageIndicator();
  }

  function setZoom(level) {
    zoom = level;
    updateZoomLabel();
    rerenderAllPages();
  }

  function getZoom() { return zoom; }

  function rerenderAllPages() {
    if (!pdfDoc || !pages.length) return;
    const scale = getEffectiveZoom();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const scaledW = Math.round(p.viewport.width * scale);
      const scaledH = Math.round(p.viewport.height * scale);
      p.wrapper.style.width = `${scaledW}px`;
      p.wrapper.style.height = `${scaledH}px`;
      if (p.rendered) {
        clearPage(i);
      }
    }
    if (observer) observer.disconnect();
    setupObserver();
  }

  function goToPage(n) {
    const idx = Math.max(0, Math.min(n - 1, pages.length - 1));
    if (pages[idx]?.wrapper) {
      pages[idx].wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function getPageCount() {
    return pdfDoc ? pdfDoc.numPages : 0;
  }

  function getScrollTop() { return scrollArea.scrollTop; }
  function setScrollTop(v) { scrollArea.scrollTop = v; }
  function onScroll(cb) {
    scrollListeners.push(cb);
    return () => { scrollListeners = scrollListeners.filter(c => c !== cb); };
  }

  function setAnnotations(annots) {
    annotations = annots || [];
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
  }

  function refreshAnnotations() {
    for (let i = 0; i < pages.length; i++) {
      const layer = pages[i].wrapper?.querySelector(".pdf-annot-layer");
      if (layer) layer.remove();
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
  }

  function paintAnnotationsOnPage(pageIdx) {
    const p = pages[pageIdx];
    if (!p?.rendered || !p.canvas) return;

    let layer = p.wrapper.querySelector(".pdf-annot-layer");
    if (layer) layer.remove();
    layer = document.createElement("div");
    layer.className = "pdf-annot-layer";

    const pageAnnots = annotations.filter(a => {
      const pos = parseAnnotationPosition(a);
      return pos && pos.pageIndex === pageIdx;
    });

    if (!pageAnnots.length) return;

    const scale = getEffectiveZoom();
    for (const annot of pageAnnots) {
      const pos = parseAnnotationPosition(annot);
      if (!pos?.rects?.length) continue;

      for (const rect of pos.rects) {
        const [x1, y1, x2, y2] = rect;
        const div = document.createElement("div");
        div.className = "pdf-annot-highlight";
        const pageHeight = p.viewport.height;
        div.style.left = `${x1 * scale}px`;
        div.style.bottom = `${y1 * scale}px`;
        div.style.width = `${(x2 - x1) * scale}px`;
        div.style.height = `${(y2 - y1) * scale}px`;
        div.style.backgroundColor = annot.color || "#ffff00";
        if (annot.comment) div.title = annot.comment;
        layer.appendChild(div);
      }
    }

    if (layer.children.length) p.wrapper.appendChild(layer);
  }

  function parseAnnotationPosition(annot) {
    if (annot._parsedPosition !== undefined) return annot._parsedPosition;
    let pos = null;
    try {
      const raw = annot._raw?.data?.annotationPosition;
      if (typeof raw === "string") pos = JSON.parse(raw);
      else if (raw && typeof raw === "object") pos = raw;
    } catch (_) {}
    annot._parsedPosition = pos;
    return pos;
  }

  async function destroy() {
    destroyed = true;
    if (observer) { observer.disconnect(); observer = null; }
    scrollListeners = [];
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
    pages = [];
    root.remove();
  }

  // Handle container resize to recompute fit-to-width
  let resizeObserver = null;
  try {
    resizeObserver = new ResizeObserver(() => {
      if (zoom < 0 && pages.length) rerenderAllPages();
    });
    resizeObserver.observe(scrollArea);
  } catch (_) {}

  return {
    loadPdf,
    destroy: async () => {
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      await destroy();
    },
    setZoom,
    getZoom,
    goToPage,
    getPageCount,
    getScrollTop,
    setScrollTop,
    onScroll,
    setAnnotations,
    refreshAnnotations,
    get element() { return root; },
  };
}
