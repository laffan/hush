import { createAnnotationLayer } from "./pdf-viewer-annotations.js";
import { createThumbnailManager } from "./pdf-viewer-thumbnails.js";
import { POPOUT_ICON } from "./pdf-viewer-icons.js";
import { buildPdfToolbar } from "./pdf-toolbar-build.js";

let pdfjsPromise = null;

export async function getPdfjs() {
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
  let _zoteroAttKey = opts.zoteroAttKey || null;
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

  // Bottom-bar toolbar: DOM-only, no closures. Event handlers wired below.
  const {
    toolbar,
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollHBtn, scrollVBtn,
    fitOneBtn, fitTwoBtn, fitThreeBtn, fitToggleWrap,
    pageIndicator, zoteroLink, thumbnailBtn, toolbarInfo,
  } = buildPdfToolbar();
  root.appendChild(toolbar);
  container.appendChild(root);

  // ── Zotero link setup ────────────────────────────────────────────
  function setZoteroAttKey(attKey) {
    _zoteroAttKey = attKey || null;
    if (attKey) {
      zoteroLink.href = `zotero://open-pdf/library/items/${attKey}`;
      zoteroLink.style.display = "";
    } else {
      zoteroLink.style.display = "none";
    }
  }
  if (opts.zoteroAttKey) setZoteroAttKey(opts.zoteroAttKey);

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

  // ── Thumbnail manager ─────────────────────────────────────────────
  const thumbs = createThumbnailManager(root, {
    getPages: () => pages,
    getPdfDoc: () => pdfDoc,
    isDestroyed: () => destroyed,
    getAnnotations: () => annotLayer.getAnnotations(),
    goToPage: (n) => goToPage(n),
  });

  function toggleThumbnails() {
    thumbnailBtn.classList.toggle("active", thumbs.toggle());
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
    // Skip events fired by the suspend/resume teardown — clearing
    // scrollArea.innerHTML resets scrollTop to 0, and we don't want
    // that synthetic 0 to leak out and overwrite the host pane's saved
    // scroll position before resume has put it back.
    if (suspended || resuming) return;
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

      if (_zoteroAttKey) {
        const pageNum = i + 1;
        const zBtn = document.createElement("button");
        zBtn.className = "pdf-page-zotero-btn";
        zBtn.title = `Open page ${pageNum} in Zotero`;
        zBtn.innerHTML = POPOUT_ICON;
        zBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const url = `zotero://open-pdf/library/items/${_zoteroAttKey}?page=${pageNum}`;
          import("@tauri-apps/plugin-opener").then(o => o.openUrl(url)).catch(() => window.open(url, "_blank"));
        });
        wrapper.appendChild(zBtn);

        wrapper.addEventListener("mousemove", (e) => {
          const r = wrapper.getBoundingClientRect();
          const inZone = (r.right - e.clientX) < 100 && (r.bottom - e.clientY) < 100;
          zBtn.classList.toggle("visible", inZone);
        });
        wrapper.addEventListener("mouseleave", () => zBtn.classList.remove("visible"));
      }

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
  // The captured _suspend* values let resume() restore the user's
  // pre-suspend viewport — without them resume reloads at scrollTop=0
  // and host panes lose their scroll on every doc-switch.
  let suspended = false;
  let resuming = false;
  let suspendImg = null;
  let _suspendScrollTop = 0;
  let _suspendScrollLeft = 0;
  let _suspendZoomLevel = null;
  let cachedPdfData = null;

  function suspend() {
    if (suspended || destroyed || !pdfDoc) return;
    _suspendScrollTop = scrollArea.scrollTop;
    _suspendScrollLeft = scrollArea.scrollLeft;
    try { _suspendZoomLevel = getZoom(); } catch (_) { _suspendZoomLevel = null; }
    suspended = true;
    thumbs.destroy();
    window.removeEventListener("keydown", onKeydown);
    if (resizeObserver) resizeObserver.disconnect();
    if (observer) { observer.disconnect(); observer = null; }

    const savedScroll = _suspendScrollTop;
    const savedScrollLeft = _suspendScrollLeft;

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
    resuming = true;
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

    // Re-apply zoom before scroll: a horizontal layout clamps scrollTop
    // to 0 (and vice versa for vertical), so the wrong axis would be
    // lost if zoom isn't restored first. The rAF gap lets the new pages
    // settle so scrollHeight reflects them before scroll is assigned.
    if (_suspendZoomLevel != null) {
      try { setZoom(_suspendZoomLevel); } catch (_) {}
    }
    requestAnimationFrame(() => {
      try {
        scrollArea.scrollTop = _suspendScrollTop;
        scrollArea.scrollLeft = _suspendScrollLeft;
      } catch (_) {}
      resuming = false;
    });
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
    thumbs.destroy();
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


