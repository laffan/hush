import { createAnnotationLayer } from "./pdf-viewer-annotations.js";
import { createFoldLayer } from "./pdf-viewer-folds.js";
import { createPdfSuspendManager } from "./pdf-viewer-suspend.js";
import { createThumbnailManager } from "./pdf-viewer-thumbnails.js";
import { createPageRenderer } from "./pdf-viewer-render.js";
import { createLinkLayerManager } from "./pdf-viewer-links.js";
import { buildPdfToolbar, applyToolbarInfo } from "./pdf-toolbar-build.js";
import { attachPageHoverButtons, createToolbarBookmarkButton } from "./pdf-bookmarks.js";
import { getPdfjs } from "./pdfjs-loader.js";

// Re-exported for existing consumers (doc-export-render.js).
export { getPdfjs };

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

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
 * @param {string}  [opts.fileId]        Hush fileId — enables bookmarks
 */
export function createPdfViewer(container, opts = {}) {
  let pdfDoc = null;
  let pages = [];
  let layoutMode = MODE_HORIZONTAL;
  let fitMode = MODE_FIT;
  let folded = false; // folded view rides on vertical + fit (encoded as zoom -5)
  let foldedZoom = 1.0; // multiplier on the folded fit-width scale (zoom while folded)
  let fixedZoom = 1.0;
  let scrollListeners = [];
  let destroyed = false;
  let _zoteroAttKey = opts.zoteroAttKey || null;
  const _fileId = opts.fileId || null;
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
    scrollToFold: (annot) => (folded ? foldLayer.scrollToAnnotation(annot) : false),
  };
  const annotLayer = createAnnotationLayer(scrollArea, body, viewerState);

  // ── Folded view (annotation-only regions) ─────────────────────────
  const foldLayer = createFoldLayer(scrollArea, {
    getPages: () => pages,
    getPdfDoc: () => pdfDoc,
    getAnnotations: () => annotLayer.getAnnotations(),
    getEffectiveZoom: () => getEffectiveZoom(),
    isDestroyed: () => destroyed,
    getFileId: () => _fileId,
  });

  // ── Page raster policy + link overlays ────────────────────────────
  // Rendering, eviction, resize settling, and canvas caps live in
  // pdf-viewer-render.js; the PDF's own link annotations (TOC rows,
  // cross-references, external URLs) in pdf-viewer-links.js.
  const linkMgr = createLinkLayerManager({
    getPdfDoc: () => pdfDoc,
    getPages: () => pages,
    goToPage: (n) => goToPage(n),
    isDestroyed: () => destroyed,
  });
  const renderer = createPageRenderer(scrollArea, {
    getPages: () => pages,
    getPdfDoc: () => pdfDoc,
    getEffectiveZoom: () => getEffectiveZoom(),
    getLayoutMode: () => layoutMode,
    isFolded: () => folded,
    isDestroyed: () => destroyed,
    isSuspended: () => suspendMgr.isSuspended(),
    onPageRendered: (idx, page) => {
      annotLayer.paintAnnotationsOnPage(idx);
      void linkMgr.attach(idx, page);
    },
    onUpdate: () => updatePageIndicator(),
  });

  root.appendChild(body);

  // Bottom-bar toolbar: DOM-only, no closures. Event handlers wired below.
  const {
    toolbar,
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollHBtn, scrollVBtn,
    fitOneBtn, fitTwoBtn, fitThreeBtn, fitToggleWrap,
    foldBtn, foldFilterBtn,
    pageIndicator, zoteroLink, thumbnailBtn, toolbarInfo,
  } = buildPdfToolbar();
  // Bookmarks lead the toolbar; hidden for viewers with no fileId.
  const bookmarksBtn = createToolbarBookmarkButton({ getFileId: () => _fileId, goToPage: (n) => goToPage(n) });
  if (!_fileId) bookmarksBtn.style.display = "none";
  toolbar.prepend(bookmarksBtn);
  root.appendChild(toolbar);
  container.appendChild(root);
  foldLayer.attachFilterUI(foldFilterBtn, root);

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
  // While folded, a zoom step scales the folds in place (keeping the
  // folded state) via a multiplier on the folded fit-width scale rather
  // than dropping back to the normal fixed-zoom view.
  function stepZoom(dir) {
    const cur = folded ? foldedZoom : getEffectiveZoom();
    const next = dir > 0
      ? ZOOM_LEVELS.find((z) => z > cur + 0.01)
      : [...ZOOM_LEVELS].reverse().find((z) => z < cur - 0.01);
    if (next == null) return;
    if (folded) { foldedZoom = next; foldLayer.refresh(); updateToolbarState(); }
    else applyFixedZoom(next);
  }
  const stepZoomOut = () => stepZoom(-1);
  const stepZoomIn = () => stepZoom(1);

  zoomOutBtn.addEventListener("click", stepZoomOut);
  zoomInBtn.addEventListener("click", stepZoomIn);

  scrollHBtn.addEventListener("click", () => {
    if (layoutMode === MODE_HORIZONTAL) return;
    fitMode = MODE_FIT;
    switchToScrollDir("horizontal");
  });
  scrollVBtn.addEventListener("click", () => {
    if (layoutMode === MODE_VERTICAL && !folded) return;
    switchToScrollDir("vertical");
  });
  fitOneBtn.addEventListener("click", () => {
    if (!folded && fitMode === MODE_FIT && layoutMode !== MODE_FIXED) return;
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

  // ── Folded view (annotation-only regions) ─────────────────────────
  function enterFolded() {
    if (folded) return;
    folded = true;
    foldedZoom = 1.0;
    layoutMode = MODE_VERTICAL;
    fitMode = MODE_FIT;
    applyLayoutClass();
    foldLayer.enable();
    updateToolbarState();
    updatePageIndicator();
  }

  function exitFolded(skipRelayout = false) {
    if (!folded) return;
    folded = false;
    foldLayer.disable();
    applyLayoutClass();
    updateToolbarState();
    if (!skipRelayout) relayoutPages();
    updatePageIndicator();
  }

  foldBtn.addEventListener("click", () => {
    if (folded) exitFolded();
    else enterFolded();
  });

  // ── Keyboard zoom (Cmd+/- while viewer is mounted) ──────────────
  function onKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoomIn(); }
    else if (e.key === "-") { e.preventDefault(); stepZoomOut(); }
    else if (e.key === "0") { e.preventDefault(); exitFolded(true); fitMode = MODE_FIT; layoutMode = MODE_HORIZONTAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); }
  }
  window.addEventListener("keydown", onKeydown);

  // ── Zoom calculations ────────────────────────────────────────────
  function getEffectiveZoom() {
    if (!pages.length || !pdfDoc) return 1;
    const first = pages[0];
    if (!first?.viewport) return 1;
    const pad = 40;
    const gap = 12;
    if (layoutMode === MODE_VERTICAL) {
      const availW = scrollArea.clientWidth - pad;
      // Folded: fit-width scale × the folded zoom multiplier.
      if (folded) return (availW / first.viewport.width) * foldedZoom;
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
    if (folded) {
      zoomLabel.textContent = Math.abs(foldedZoom - 1) < 0.01 ? "Folded" : `Folded ${Math.round(foldedZoom * 100)}%`;
    } else if (isFit) {
      const labels = { [MODE_FIT]: "Fit", [MODE_FIT_2]: "Fit 2", [MODE_FIT_3]: "Fit 3" };
      zoomLabel.textContent = (isVert ? labels[fitMode] : "Fit") || "Fit";
    } else {
      zoomLabel.textContent = `${Math.round(z * 100)}%`;
    }
    scrollHBtn.classList.toggle("active", isHoriz);
    scrollVBtn.classList.toggle("active", isVert);
    fitToggleWrap.style.display = isVert ? "" : "none";
    fitOneBtn.classList.toggle("active", fitMode === MODE_FIT && !folded);
    fitTwoBtn.classList.toggle("active", fitMode === MODE_FIT_2);
    fitThreeBtn.classList.toggle("active", fitMode === MODE_FIT_3);
    // Folded view is always offered — entering it switches to vertical
    // scroll at single-page width as part of its initialization.
    foldBtn.classList.toggle("active", folded);
    foldFilterBtn.style.display = folded ? "" : "none";
    // Persist view-state changes (fit / direction / fixed zoom) the instant
    // they happen, not only on a later scroll. Guarded so restore + initial
    // load don't echo back.
    if (!suspendMgr.isSuspended() && !suspendMgr.isResuming()) for (const cb of scrollListeners) cb();
  }

  function updatePageIndicator() {
    if (!pages.length) { pageIndicator.textContent = ""; return; }
    if (folded) {
      pageIndicator.textContent = `${foldLayer.getCurrentPage()} / ${pages.length}`;
      return;
    }
    // Pure arithmetic over the renderer's cached page geometry — the
    // old per-page offset walk forced a layout read per page per
    // scroll event.
    pageIndicator.textContent = `${renderer.pageAtViewCenter()} / ${pages.length}`;
  }

  scrollArea.addEventListener("scroll", () => {
    // Skip events fired by the suspend/resume teardown — clearing
    // scrollArea.innerHTML resets scrollTop to 0, and we don't want
    // that synthetic 0 to leak out and overwrite the host pane's saved
    // scroll position before resume has put it back.
    if (suspendMgr.isSuspended() || suspendMgr.isResuming()) return;
    // The render-set update is rAF-coalesced and refreshes the page
    // indicator via env.onUpdate, so the raw handler does no DOM work.
    // Folded mode short-circuits the renderer, so its indicator (a walk
    // over the few folds) updates here instead.
    if (folded) updatePageIndicator();
    else renderer.scheduleUpdate();
    for (const cb of scrollListeners) cb();
  });

  // ── Mode switching ───────────────────────────────────────────────
  function switchToScrollDir(dir) {
    exitFolded(true);
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
    exitFolded(true);
    if (layoutMode === MODE_FIXED) {
      layoutMode = MODE_VERTICAL;
    }
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function applyFixedZoom(level) {
    exitFolded(true);
    fixedZoom = level;
    layoutMode = MODE_FIXED;
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function applyLayoutClass() {
    scrollArea.classList.remove("pdf-layout-fit", "pdf-layout-fixed", "pdf-layout-horizontal", "pdf-layout-folded");
    if (folded) {
      scrollArea.classList.add("pdf-layout-folded");
      return;
    }
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

  // ── Page layout ──────────────────────────────────────────────────
  // Geometry only — rasterisation lives in pdf-viewer-render.js. A
  // relayout resizes every wrapper and *stretches* the existing canvas
  // sandwich (CSS transform, no canvas work), so a drag-resize costs
  // style writes alone; the renderer's settle pass re-renders crisp at
  // the final scale once the geometry has been still for a beat.
  let relayoutGuard = false;
  function relayoutPages() {
    if (relayoutGuard || !pdfDoc || !pages.length || suspendMgr.isSuspended()) return;
    if (folded) { foldLayer.refresh(); return; }
    relayoutGuard = true;
    try {
      const scale = getEffectiveZoom();
      for (const p of pages) {
        const cssW = Math.round(p.viewport.width * scale);
        const cssH = Math.round(p.viewport.height * scale);
        p.wrapper.style.width = `${cssW}px`;
        p.wrapper.style.height = `${cssH}px`;
        if (p.contentEl && p.contentW) {
          const k = cssW / p.contentW;
          p.contentEl.style.transform = Math.abs(k - 1) > 0.001 ? `scale(${k})` : "";
        }
      }
      renderer.invalidateGeometry();
      renderer.scheduleUpdate();
      renderer.scheduleSettle();
    } finally {
      relayoutGuard = false;
    }
  }

  // ── Load ─────────────────────────────────────────────────────────
  async function loadPdf(data) {
    const pdfjs = await getPdfjs();
    if (destroyed) return;
    if (pdfDoc) { await pdfDoc.destroy(); pdfDoc = null; }
    renderer.reset();
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

    // Only page 1's dimensions are fetched up front — the rest of the
    // wrappers are seeded from them and adopt their real size on first
    // render (pdf-viewer-render.js). Fetching every page proxy here made
    // opening a large PDF a serial walk over the whole document.
    const firstPage = await pdfDoc.getPage(1);
    if (destroyed) return;
    const defaultViewport = firstPage.getViewport({ scale: 1 });

    for (let i = 0; i < pdfDoc.numPages; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "pdf-page-wrapper";
      wrapper.dataset.pageIndex = i;
      const placeholder = document.createElement("div");
      placeholder.className = "pdf-page-placeholder";
      wrapper.appendChild(placeholder);

      // Hover buttons: bookmark (upper-right) + Zotero pop-out
      // (bottom-right, Zotero-backed PDFs only).
      attachPageHoverButtons(wrapper, i + 1, { zoteroAttKey: _zoteroAttKey, fileId: _fileId });

      scrollArea.appendChild(wrapper);
      pages.push({
        wrapper, viewport: defaultViewport, realViewport: i === 0,
        rendered: false, rendering: false, canvas: null, renderedZoom: null,
        contentEl: null, contentW: 0, contentH: 0,
      });
    }
    // Size every wrapper at the effective zoom (needs pages[0] in place).
    const scale = getEffectiveZoom();
    for (const p of pages) {
      p.wrapper.style.width = `${Math.round(p.viewport.width * scale)}px`;
      p.wrapper.style.height = `${Math.round(p.viewport.height * scale)}px`;
    }

    renderer.update();
    // A reload while folded (e.g. resume) wiped the fold DOM with
    // scrollArea.innerHTML above — rebuild it against the new pages.
    if (folded) foldLayer.enable();
    updateToolbarState();
    updatePageIndicator();
  }

  function setZoom(level) {
    if (level === -5) { enterFolded(); return; }
    exitFolded(true);
    if (level === -1) { fitMode = MODE_FIT; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -2) { fitMode = MODE_FIT; layoutMode = MODE_HORIZONTAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -3) { fitMode = MODE_FIT_2; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    if (level === -4) { fitMode = MODE_FIT_3; layoutMode = MODE_VERTICAL; applyLayoutClass(); updateToolbarState(); relayoutPages(); return; }
    applyFixedZoom(level);
  }
  function getZoom() {
    if (folded) return -5;
    if (layoutMode === MODE_HORIZONTAL) return -2;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT) return -1;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT_2) return -3;
    if (layoutMode === MODE_VERTICAL && fitMode === MODE_FIT_3) return -4;
    return fixedZoom;
  }

  function goToPage(n, opts = {}) {
    if (folded) { foldLayer.goToPage(n); return; }
    const idx = Math.max(0, Math.min(n - 1, pages.length - 1));
    const w = pages[idx]?.wrapper;
    if (!w) return;
    if (opts.instant) {
      // Deterministic positioning for deep links landing right after a
      // mount — a smooth scrollIntoView started that early can be
      // cancelled by the container unhiding / first renders.
      if (layoutMode === MODE_HORIZONTAL) scrollArea.scrollLeft = w.offsetLeft - 20;
      else scrollArea.scrollTop = w.offsetTop - 20;
      return;
    }
    if (layoutMode === MODE_HORIZONTAL) {
      w.scrollIntoView({ behavior: "smooth", inline: "start" });
    } else {
      w.scrollIntoView({ behavior: "smooth", block: "start" });
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
  // Extracted to pdf-viewer-suspend.js; env callbacks bridge into the
  // factory's closure state. Declared before first use — everything
  // that reads suspendMgr runs after the factory finishes.
  const suspendMgr = createPdfSuspendManager(scrollArea, {
    isDestroyed: () => destroyed,
    hasDoc: () => !!pdfDoc,
    getData: () => (pdfDoc ? pdfDoc.getData() : Promise.reject(new Error("no doc"))),
    getZoom: () => getZoom(),
    setZoom: (level) => setZoom(level),
    relayoutPages: () => relayoutPages(),
    drawSnapshot: (ctx, w, h) => {
      if (folded) { foldLayer.drawSnapshot(ctx, w, h); return; }
      for (const p of pages) {
        if (!p.rendered || !p.canvas) continue;
        const rect = p.wrapper.getBoundingClientRect();
        const areaRect = scrollArea.getBoundingClientRect();
        const dx = rect.left - areaRect.left;
        const dy = rect.top - areaRect.top;
        if (dy + rect.height < 0 || dy > h) continue;
        ctx.drawImage(p.canvas, dx, dy, rect.width, rect.height);
      }
    },
    onSuspendStart: () => {
      thumbs.destroy();
      window.removeEventListener("keydown", onKeydown);
      if (resizeObserver) resizeObserver.disconnect();
      renderer.destroy();
    },
    teardownContent: () => {
      // Folded state was captured via getZoom (-5) already; drop the
      // live fold DOM with everything else. Resume's restoreView(-5)
      // re-enters folded mode after the reload.
      if (folded) {
        folded = false;
        foldLayer.disable();
        applyLayoutClass();
      }
      renderer.clearAll();
      renderer.reset();
      if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
      pages = [];
      scrollArea.innerHTML = "";
    },
    onResumeStart: () => {
      window.addEventListener("keydown", onKeydown);
      if (resizeObserver) {
        try { resizeObserver.observe(scrollArea); } catch (_) {}
      }
    },
    reload: async (data) => {
      const savedAnnotations = annotLayer.getAnnotations().slice();
      await loadPdf(data);
      if (savedAnnotations.length) annotLayer.setAnnotations(savedAnnotations);
    },
  });

  // ── Cleanup ──────────────────────────────────────────────────────
  async function destroy() {
    destroyed = true;
    foldLayer.destroy();
    thumbs.destroy();
    renderer.destroy();
    window.removeEventListener("keydown", onKeydown);
    scrollListeners = [];
    if (pdfDoc) { try { await pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
    pages = [];
    root.remove();
  }

  let resizeObserver = null;
  let resizeTimer = null;
  try {
    resizeObserver = new ResizeObserver(() => {
      if (!pages.length || suspendMgr.isSuspended()) return;
      // Render-set refresh always (covers a hidden container gaining
      // size, where no scroll event fires); fit-mode geometry follows
      // behind a short debounce — the relayout itself is style-only,
      // the crisp re-render waits for the renderer's settle pass. A
      // container resize can re-wrap fixed-zoom rows, so the cached
      // page geometry is stale either way.
      renderer.invalidateGeometry();
      renderer.scheduleUpdate();
      if (layoutMode === MODE_FIXED) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; relayoutPages(); }, 80);
    });
    resizeObserver.observe(scrollArea);
  } catch (_) {}

  return {
    loadPdf,
    destroy: async () => {
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      await destroy();
    },
    suspend: suspendMgr.suspend,
    resume: suspendMgr.resume,
    get suspended() { return suspendMgr.isSuspended(); },
    setZoom,
    getZoom,
    goToPage,
    getPageCount,
    getScrollTop,
    setScrollTop,
    getScrollLeft,
    setScrollLeft,
    restoreView: suspendMgr.restoreView,
    onScroll,
    setAnnotations: (annots) => {
      annotLayer.setAnnotations(annots);
      foldLayer.onAnnotationsChanged();
    },
    refreshAnnotations: () => {
      annotLayer.refreshAnnotations();
      foldLayer.refresh(true);
    },
    setZoteroAttKey,
    setToolbarInfo: (title, author) => applyToolbarInfo(toolbarInfo, title, author),
    toggleShelf: annotLayer.toggleShelf,
    get element() { return root; },
  };
}


