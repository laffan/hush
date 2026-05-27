/**
 * PDF.js interactive viewer — renders a scrollable, zoomable PDF inside
 * a container. Supports both the main editor area and floating panes.
 *
 * Layout modes:
 *   - horizontal fit (default): pages fit container height, horizontal scroll
 *   - vertical fit: single column, pages fill available width, vertical scroll
 *   - vertical fit-2: two columns of pages, vertical scroll
 *   - vertical fit-3: three columns of pages, vertical scroll
 *   - fixed zoom (50%-200%): explicit scale via +/- controls
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

const MODE_FIT = "fit";
const MODE_FIT_2 = "fit-2";
const MODE_FIT_3 = "fit-3";
const MODE_FIXED = "fixed";
const MODE_HORIZONTAL = "horizontal";
const MODE_VERTICAL = "vertical";

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string}  [opts.mode]          "main" or "pane"
 * @param {string}  [opts.zoteroAttKey]  Zotero attachment key
 */
export function createPdfViewer(container, opts = {}) {
  let pdfDoc = null;
  let pages = [];
  let layoutMode = MODE_HORIZONTAL;
  let fitMode = MODE_FIT;
  let fixedZoom = 1.0;
  let scrollListeners = [];
  let destroyed = false;
  const root = document.createElement("div");
  root.className = "pdf-viewer";

  // ── Main body: scroll area + shelf side-by-side ──────────────────
  const body = document.createElement("div");
  body.className = "pdf-viewer-body";

  const scrollArea = document.createElement("div");
  scrollArea.className = "pdf-scroll-area pdf-layout-horizontal";
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

  // Scroll direction toggle: two icons side-by-side
  const scrollToggleWrap = document.createElement("span");
  scrollToggleWrap.className = "pdf-toggle-group";
  const scrollHBtn = svgBtn("pdf-toggle-option active", "Horizontal scroll", HORIZONTAL_ICON);
  const scrollVBtn = svgBtn("pdf-toggle-option", "Vertical scroll", VERTICAL_ICON);
  scrollToggleWrap.append(scrollHBtn, scrollVBtn);

  // Fit mode toggle: Fit / Fit 2 / Fit 3 — only visible in vertical mode
  const fitToggleWrap = document.createElement("span");
  fitToggleWrap.className = "pdf-toggle-group";
  fitToggleWrap.style.display = "none";
  const fitOneBtn = svgBtn("pdf-toggle-option active", "Fit one page", FIT_ONE_ICON);
  const fitTwoBtn = svgBtn("pdf-toggle-option", "Fit two pages", FIT_TWO_ICON);
  const fitThreeBtn = svgBtn("pdf-toggle-option", "Fit three pages", FIT_THREE_ICON);

  fitToggleWrap.append(fitOneBtn, fitTwoBtn, fitThreeBtn);

  const pageIndicator = document.createElement("span");
  pageIndicator.className = "pdf-page-indicator";

  const zoteroLink = document.createElement("a");
  zoteroLink.className = "pdf-zotero-link";
  zoteroLink.textContent = "Open in Zotero ↗";
  zoteroLink.style.display = "none";

  const thumbnailBtn = svgBtn("pdf-zoom-btn pdf-thumbnail-btn", "Thumbnail view", THUMBNAIL_ICON);

  const toolbarInfo = document.createElement("span");
  toolbarInfo.className = "pdf-toolbar-info";

  toolbar.append(zoomOutBtn, zoomLabel, zoomInBtn, scrollToggleWrap, fitToggleWrap, thumbnailBtn, toolbarInfo, pageIndicator, zoteroLink);
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

  // Tauri webviews swallow clicks on <a href> with custom schemes —
  // hand the URL to the opener plugin instead.
  zoteroLink.addEventListener("click", async (e) => {
    e.preventDefault();
    const url = zoteroLink.href;
    if (!url) return;
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  });

  // ── Thumbnail view (full-screen overlay with async rendering) ─────
  const THUMB_WIDTH = 180;
  let thumbPanel = null;
  let thumbVisible = false;
  let thumbObserver = null;

  function toggleThumbnails() {
    thumbVisible = !thumbVisible;
    thumbnailBtn.classList.toggle("active", thumbVisible);
    if (thumbVisible) showThumbnails();
    else hideThumbnails();
  }

  function showThumbnails() {
    if (thumbPanel) { thumbPanel.style.display = ""; setupThumbObserver(); return; }
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
        goToPage(i + 1);
        toggleThumbnails();
      });

      thumbScroll.appendChild(cell);
    }

    root.appendChild(thumbPanel);
    setupThumbObserver();
  }

  function setupThumbObserver() {
    if (thumbObserver) thumbObserver.disconnect();
    const thumbScroll = thumbPanel?.querySelector(".pdf-thumbnail-scroll");
    if (!thumbScroll) return;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = parseInt(entry.target.dataset.thumbIdx, 10);
        if (!isNaN(idx)) renderThumb(idx);
      }
    }, { root: thumbScroll, rootMargin: "300px" });
    for (const cell of thumbScroll.children) thumbObserver.observe(cell);
  }

  function hideThumbnails() {
    if (!thumbPanel) return;
    thumbPanel.style.display = "none";
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  }

  function parseThumbAnnotPos(annot) {
    try {
      const raw = annot._raw?.data?.annotationPosition;
      if (typeof raw === "string") return JSON.parse(raw);
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }

  async function renderThumb(idx) {
    if (!pdfDoc || destroyed || idx < 0 || idx >= pages.length) return;
    const cell = thumbPanel?.querySelector(`[data-thumb-idx="${idx}"]`);
    if (!cell || cell.dataset.thumbRendered) return;
    cell.dataset.thumbRendered = "1";

    try {
      const page = await pdfDoc.getPage(idx + 1);
      if (destroyed) return;
      const vp = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / vp.width;
      const svp = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(svp.width);
      canvas.height = Math.round(svp.height);
      canvas.className = "pdf-thumb-canvas";

      await page.render({ canvas, viewport: svp, background: "#ffffff" }).promise;
      if (destroyed) return;

      // Paint all annotation types onto the thumbnail
      const allAnnots = annotLayer.getAnnotations();
      if (allAnnots.length) {
        const ctx = canvas.getContext("2d");
        for (const ann of allAnnots) {
          const pos = parseThumbAnnotPos(ann);
          if (!pos || pos.pageIndex !== idx) continue;

          // Highlight / underline rects
          if (pos.rects?.length && ann.type !== "ink") {
            const color = ann.color || "#ffff00";
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.3;
            for (const rect of pos.rects) {
              const [x1, y1, x2, y2] = rect;
              const rx = x1 * scale;
              const ry = (vp.height - y2) * scale;
              const rw = (x2 - x1) * scale;
              const rh = (y2 - y1) * scale;
              ctx.fillRect(rx, ry, rw, rh);
            }
            ctx.globalAlpha = 1.0;
          }

          // Ink / pen annotations
          if (ann.type === "ink" && pos.paths?.length) {
            ctx.strokeStyle = ann.color || "#ff0000";
            ctx.lineWidth = Math.max(0.5, scale * 0.8);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (const pathPoints of pos.paths) {
              if (!pathPoints || pathPoints.length < 2) continue;
              ctx.beginPath();
              for (let pi = 0; pi < pathPoints.length; pi += 2) {
                const px = pathPoints[pi] * scale;
                const py = (vp.height - pathPoints[pi + 1]) * scale;
                if (pi === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              }
              ctx.stroke();
            }
          }
        }
      }

      const ph = cell.querySelector(".pdf-thumb-placeholder");
      if (ph) ph.remove();
      cell.insertBefore(canvas, cell.firstChild);
    } catch (e) {
      console.error(`Failed to render thumbnail ${idx + 1}:`, e);
    }
  }

  function destroyThumbnails() {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (thumbPanel) { thumbPanel.remove(); thumbPanel = null; }
    thumbVisible = false;
  }

  thumbnailBtn.addEventListener("click", toggleThumbnails);

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

  scrollHBtn.addEventListener("click", () => {
    if (layoutMode === MODE_HORIZONTAL) return;
    fitMode = MODE_FIT;
    switchToScrollDir("horizontal");
  });
  scrollVBtn.addEventListener("click", () => {
    if (layoutMode === MODE_VERTICAL) return;
    switchToScrollDir("vertical");
  });
  fitOneBtn.addEventListener("click", () => {
    if (fitMode === MODE_FIT && layoutMode !== MODE_FIXED) return;
    fitMode = MODE_FIT;
    switchToFitMode();
  });
  fitTwoBtn.addEventListener("click", () => {
    if (fitMode === MODE_FIT_2 && layoutMode !== MODE_FIXED) return;
    fitMode = MODE_FIT_2;
    switchToFitMode();
  });
  fitThreeBtn.addEventListener("click", () => {
    if (fitMode === MODE_FIT_3 && layoutMode !== MODE_FIXED) return;
    fitMode = MODE_FIT_3;
    switchToFitMode();
  });

  // ── Keyboard zoom (Cmd+/- while viewer is mounted) ──────────────
  function onKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoomIn(); }
    else if (e.key === "-") { e.preventDefault(); stepZoomOut(); }
    else if (e.key === "0") { e.preventDefault(); fitMode = MODE_FIT; layoutMode = MODE_HORIZONTAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); }
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
    const pad = 40;
    const gap = 12;
    if (layoutMode === MODE_VERTICAL) {
      const availW = scrollArea.clientWidth - pad;
      if (fitMode === MODE_FIT_2) return (availW - gap - 4) / (first.viewport.width * 2);
      if (fitMode === MODE_FIT_3) return (availW - gap * 2 - 4) / (first.viewport.width * 3);
      return availW / first.viewport.width;
    }
    if (layoutMode === MODE_HORIZONTAL) {
      return (scrollArea.clientHeight - pad) / first.viewport.height;
    }
    return fixedZoom;
  }

  function updateToolbarState() {
    const z = getEffectiveZoom();
    const isFit = layoutMode !== MODE_FIXED;
    const isVert = layoutMode === MODE_VERTICAL;
    const isHoriz = layoutMode === MODE_HORIZONTAL;
    if (isFit) {
      const labels = { [MODE_FIT]: "Fit", [MODE_FIT_2]: "Fit 2", [MODE_FIT_3]: "Fit 3" };
      zoomLabel.textContent = (isVert ? labels[fitMode] : "Fit") || "Fit";
    } else {
      zoomLabel.textContent = `${Math.round(z * 100)}%`;
    }
    scrollHBtn.classList.toggle("active", isHoriz);
    scrollVBtn.classList.toggle("active", isVert);
    fitToggleWrap.style.display = isVert ? "" : "none";
    fitOneBtn.classList.toggle("active", fitMode === MODE_FIT);
    fitTwoBtn.classList.toggle("active", fitMode === MODE_FIT_2);
    fitThreeBtn.classList.toggle("active", fitMode === MODE_FIT_3);
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
  function switchToScrollDir(dir) {
    if (dir === "horizontal") {
      layoutMode = MODE_HORIZONTAL;
    } else {
      layoutMode = MODE_VERTICAL;
    }
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function switchToFitMode() {
    if (layoutMode === MODE_FIXED) {
      layoutMode = MODE_VERTICAL;
    }
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
    if (layoutMode === MODE_VERTICAL) {
      if (fitMode === MODE_FIT_2 || fitMode === MODE_FIT_3) {
        scrollArea.classList.add("pdf-layout-fixed");
      } else {
        scrollArea.classList.add("pdf-layout-fit");
      }
    } else if (layoutMode === MODE_HORIZONTAL) {
      scrollArea.classList.add("pdf-layout-horizontal");
    } else {
      scrollArea.classList.add("pdf-layout-fixed");
    }
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
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.className = "pdf-page-canvas";

      const cssW = Math.round(viewport.width / dpr);
      const cssH = Math.round(viewport.height / dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const renderTask = page.render({ canvas, viewport, background: "#ffffff" });
      await renderTask.promise;
      if (destroyed) return;

      p.wrapper.style.width = `${cssW}px`;
      p.wrapper.style.height = `${cssH}px`;
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
        const cssW = Math.round(p.viewport.width * scale);
        const cssH = Math.round(p.viewport.height * scale);
        p.wrapper.style.width = `${cssW}px`;
        p.wrapper.style.height = `${cssH}px`;
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
      const cssW = Math.round(viewport.width * scale);
      const cssH = Math.round(viewport.height * scale);
      wrapper.style.width = `${cssW}px`;
      wrapper.style.height = `${cssH}px`;
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
    if (level === -1) { fitMode = MODE_FIT; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -2) { fitMode = MODE_FIT; layoutMode = MODE_HORIZONTAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -3) { fitMode = MODE_FIT_2; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -4) { fitMode = MODE_FIT_3; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    applyFixedZoom(level);
  }
  function getZoom() {
    if (layoutMode === MODE_HORIZONTAL) return -2;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT) return -1;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT_2) return -3;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT_3) return -4;
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
  function getScrollLeft() { return scrollArea.scrollLeft; }
  function setScrollLeft(v) { scrollArea.scrollLeft = v; }
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
    destroyThumbnails();
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
    destroyThumbnails();
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
    getScrollLeft,
    setScrollLeft,
    onScroll,
    setAnnotations: annotLayer.setAnnotations,
    refreshAnnotations: annotLayer.refreshAnnotations,
    setZoteroAttKey,
    setToolbarInfo: (title, author) => {
      if (!title) { toolbarInfo.textContent = ""; toolbarInfo.style.display = "none"; return; }
      toolbarInfo.style.display = "";
      toolbarInfo.innerHTML = "";
      const t = document.createElement("span");
      t.className = "pdf-toolbar-info-title";
      t.textContent = title;
      toolbarInfo.appendChild(t);
      if (author) {
        const a = document.createElement("span");
        a.className = "pdf-toolbar-info-author";
        a.textContent = author;
        toolbarInfo.appendChild(a);
      }
    },
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

// Vertical scroll: pages stacked
const VERTICAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="1" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="3" y="9" width="10" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Horizontal scroll: pages side by side
const HORIZONTAL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="3" width="6" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="3" width="6" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Thumbnail grid
const THUMBNAIL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="1" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="9" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Fit one: single page outline with corner arrows
const FIT_ONE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="1" width="10" height="14" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;

// Fit two: two pages side by side
const FIT_TWO_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="2" width="6" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="9" y="2" width="6" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;

// Fit three: three pages in a row
const FIT_THREE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="0.5" y="2" width="4" height="12" rx="0.8" fill="none" stroke="currentColor" stroke-width="1"/><rect x="6" y="2" width="4" height="12" rx="0.8" fill="none" stroke="currentColor" stroke-width="1"/><rect x="11.5" y="2" width="4" height="12" rx="0.8" fill="none" stroke="currentColor" stroke-width="1"/></svg>`;
