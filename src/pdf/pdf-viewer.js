/**
 * The PDF viewer — plain DOM under one root, mounted by the main PDF
 * view (pdf-bridge.js), floating panes (pane-media.js) and stack columns.
 *
 * Layout modes: horizontal scroll (pages fit to height), vertical scroll
 * (fit one, two or three pages across), fixed zoom (wrapping rows), and
 * the folded view. Either scroll direction can also be paged: a set of
 * one to three pages at a time, swiped through set by set
 * (pdf-viewer-layout.js). Outside the folded view, the pages' edges are
 * trimmed if the reader has trimmed them (pdf-viewer-crop.js). A
 * relayout only resizes page wrappers and CSS-stretches existing
 * rasters, keeping the reader's place (pdf-viewer-anchor.js); the
 * renderer's settle pass re-renders crisp once the geometry stops moving.
 *
 * Around the pages: the bottom bar (pdf-toolbar-build.js), the
 * annotation shelf, the outline panel, the find bar, the thumbnail grid,
 * bookmarks, and the keyboard (pdf-viewer-keys.js). Zotero's annotations
 * are painted into the rasters (pdf-annot-raster.js); a text layer makes
 * the words selectable. The view is kept per PDF on this device
 * (pdf-viewer-view-state.js); inactive panes suspend to a snapshot
 * (pdf-viewer-suspend.js).
 */
import { createAnnotationLayer, extractEmbedded } from "./pdf-viewer-annotations.js";
import { drawAnnotations, pageSignatures } from "./pdf-annot-raster.js";
import { createFoldLayer } from "./pdf-viewer-folds.js";
import { createPdfSuspendManager } from "./pdf-viewer-suspend.js";
import { createThumbnailManager } from "./pdf-viewer-thumbnails.js";
import { createPageRenderer } from "./pdf-viewer-render.js";
import { createLinkLayerManager } from "./pdf-viewer-links.js";
import { buildPdfToolbar, applyToolbarInfo, syncToolbar, showZoteroLink, wireZoteroLink } from "./pdf-toolbar-build.js";
import { attachTooltips } from "./pdf-viewer-tooltips.js";
import { createToolbarBookmarkButton } from "./pdf-bookmarks.js";
import { createPageRecords, drawPagesSnapshot, pdfInput, scrollToPage } from "./pdf-viewer-pages.js";
import { applyLayoutClasses, attachPagedWheel, fitZoom, sizePage, sizePagedGap } from "./pdf-viewer-layout.js";
import { centerPagePoint, pageFracAtCenter, restoreAnchor, scrollToPagePoint, viewAnchor } from "./pdf-viewer-anchor.js";
import { createReadingCrop } from "./pdf-viewer-crop.js";
import { attachViewerKeys } from "./pdf-viewer-keys.js";
import { attachSelectionCopy, attachTextLayer, releaseTextLayers } from "./pdf-viewer-text.js";
import { createPdfSearch } from "./pdf-viewer-search.js";
import { createFindBar } from "./pdf-viewer-find-bar.js";
import { createOutlinePanel, readOutline } from "./pdf-viewer-outline.js";
import {
  createViewReporter, decodeZoom, encodeZoom, initialLayout, loadPdfView, loadViewPrefs,
  savePdfView, saveViewPrefs,
} from "./pdf-viewer-view-state.js";
import { getPdfjs, PDFJS_ASSETS } from "./pdfjs-loader.js";

// Re-exported for existing consumers.
export { getPdfjs };

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string}  [opts.mode]          "main" or "pane" — the main viewer keeps its
 *                                       view per PDF and reopens as it was left
 * @param {string}  [opts.zoteroAttKey]  Zotero attachment key
 * @param {string}  [opts.fileId]        Hush fileId — enables bookmarks and the per-PDF view
 */
export function createPdfViewer(container, opts = {}) {
  const _fileId = opts.fileId || null;
  const isMain = opts.mode === "main";
  const record = loadPdfView(_fileId);
  const savedMain = isMain ? record?.main || null : null;
  const start = initialLayout(savedMain, isMain ? loadViewPrefs() : null,
    isMain && container.clientHeight > container.clientWidth);
  let pdfDoc = null;
  let pages = [];
  let layoutMode = start.layoutMode;
  let fitMode = start.fitMode;
  let folded = start.folded;
  let foldedZoom = start.foldedZoom; // multiplier on the folded fit-width scale
  let fixedZoom = start.fixedZoom;
  let paged = start.paged; // sets of pages, in either scroll direction
  // A folded place to return to, once the folds are built (they wait for
  // the annotations, which arrive after the pages).
  let pendingFoldAt = (folded && savedMain?.foldAt) || null;
  let scrollListeners = [];
  let destroyed = false;
  let _zoteroAttKey = opts.zoteroAttKey || null;
  const isPaged = () => paged && !folded && layoutMode !== "fixed";
  /** Pages to a set in the paged view: the fit buttons' one, two, three. */
  const perSet = () => (fitMode === "fit-3" ? 3 : fitMode === "fit-2" ? 2 : 1);
  /** The page in view — in the paged view, its set's first page. */
  const leadPage = () => {
    const page = currentPage();
    return isPaged() ? page - ((page - 1) % perSet()) : page;
  };

  const root = document.createElement("div");
  root.className = "pdf-viewer";
  const body = document.createElement("div");
  body.className = "pdf-viewer-body";
  const scrollArea = document.createElement("div");
  scrollArea.className = "pdf-scroll-area pdf-layout-horizontal";
  // Focusable, so the keyboard follows a click on the pages.
  scrollArea.tabIndex = 0;
  body.appendChild(scrollArea);

  const annotLayer = createAnnotationLayer(scrollArea, body, {
    getPages: () => pages,
    getEffectiveZoom: () => getEffectiveZoom(),
    getLayoutMode: () => layoutMode,
    goToPage: (n) => goToPage(n),
    scrollToFold: (annot) => (folded ? foldLayer.scrollToAnnotation(annot) : false),
    isPaged,
    getZoteroAttKey: () => _zoteroAttKey,
    getPdfDoc: () => pdfDoc,
    extractAnnotations: () => extractEmbeddedAnnotations(),
  });
  const foldLayer = createFoldLayer(scrollArea, {
    getPages: () => pages,
    getPdfDoc: () => pdfDoc,
    getAnnotations: () => annotLayer.getAnnotations(),
    getEffectiveZoom: () => getEffectiveZoom(),
    isDestroyed: () => destroyed,
    getFileId: () => _fileId,
    onFilterChange: () => {
      savePdfView(_fileId, { foldFilter: foldLayer.getFilter() });
      viewReporter.changed();
    },
  });
  if (record?.foldFilter) foldLayer.setFilter(record.foldFilter);
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
    sizePage: (p, scale) => sizePage(p, scale, layoutState().crop),
    getLayoutMode: () => layoutMode,
    isFolded: () => folded,
    isDestroyed: () => destroyed,
    isSuspended: () => suspendMgr.isSuspended(),
    paintPage: (idx, ctx, viewport) => drawAnnotations(ctx, viewport, annotLayer.getAnnotations(), idx),
    onPageRendered: (idx, page) => {
      void linkMgr.attach(idx, page);
      void attachTextLayer(pages[idx], page);
    },
    onUpdate: () => updatePageIndicator(),
  });
  root.appendChild(body);

  // Bottom bar: DOM only; handlers wired below. The bookmarks join the
  // outline and find (hidden for viewers with no fileId).
  const tb = buildPdfToolbar();
  const bookmarksBtn = createToolbarBookmarkButton({ getFileId: () => _fileId, goToPage: (n) => goToPage(n) });
  if (!_fileId) bookmarksBtn.style.display = "none";
  tb.navWrap.insertBefore(bookmarksBtn, tb.findBtn);
  root.appendChild(tb.toolbar);
  container.appendChild(root);
  const detachTooltips = attachTooltips(tb.toolbar, root);
  foldLayer.attachFilterUI(tb.foldFilterBtn, root);
  attachSelectionCopy(root);

  // The main viewer's view, for opening this PDF the same way next time —
  // not while a folded place is still waiting to be restored.
  const viewReporter = createViewReporter(() => {
    if (!isMain || !reportView || !pages.length || pendingFoldAt || suspendMgr.isSuspended()) return null;
    const v = { layoutMode, fitMode, fixedZoom, paged, folded, foldedZoom, outline: outlinePanel.isOpen() };
    if (folded) v.foldAt = foldLayer.viewAnchor() || undefined;
    else v.at = viewAnchor(scrollArea, pages, layoutMode === "horizontal") || undefined;
    return v;
  }, (v) => savePdfView(_fileId, { main: v }));

  // The reading crop: adjusting it shows the pages whole, ending the
  // adjustment lays them out trimmed — at the same place.
  const cropper = createReadingCrop({
    scrollArea,
    host: body,
    getPages: () => pages,
    active: () => !folded && !suspendMgr.isSuspended(),
    initial: record?.crop || null,
    onChange: () => {
      const page = leadPage();
      applyLayoutClass();
      relayoutPages();
      if (isPaged()) goToPage(page, { instant: true });
      savePdfView(_fileId, { crop: cropper.get() });
      viewReporter.changed();
    },
  });

  // ── Zotero link (opens at the page in view) ──────────────────────
  const setZoteroAttKey = (attKey) => { _zoteroAttKey = attKey || null; showZoteroLink(tb.zoteroLink, _zoteroAttKey); };
  if (opts.zoteroAttKey) setZoteroAttKey(opts.zoteroAttKey);
  wireZoteroLink(tb.zoteroLink, () => _zoteroAttKey, () => currentPage());

  // The shelf's Extract Annotations: the file's own annotations, beside
  // whatever Zotero's API supplied.
  async function extractEmbeddedAnnotations() {
    if (!pdfDoc) return 0;
    const { list, count } = await extractEmbedded(pdfDoc, _zoteroAttKey, _fileId, annotLayer.getAnnotations());
    setAnnotations(list);
    return count;
  }

  /** Replace the annotations. Only pages whose marks changed are
   *  repainted, so a refresh that touched nothing here costs nothing. */
  function setAnnotations(list) {
    const before = pageSignatures(annotLayer.getAnnotations());
    const after = pageSignatures(list);
    annotLayer.setAnnotations(list);
    const changed = new Set();
    for (const [i, sig] of after) if (before.get(i) !== sig) changed.add(i);
    for (const i of before.keys()) if (!after.has(i)) changed.add(i);
    if (changed.size) renderer.repaint(changed);
    foldLayer.onAnnotationsChanged();
    restorePendingFold();
    if (!list?.length) pendingFoldAt = null; // nothing to fold back to
  }
  function restorePendingFold() {
    if (pendingFoldAt && folded && foldLayer.restoreAnchor(pendingFoldAt)) pendingFoldAt = null;
  }

  // ── Thumbnails, find, outline ────────────────────────────────────
  const thumbs = createThumbnailManager(body, {
    getPages: () => pages,
    getPdfDoc: () => pdfDoc,
    isDestroyed: () => destroyed,
    getAnnotations: () => annotLayer.getAnnotations(),
    goToPage: (n) => goToPage(n),
    onHide: () => tb.thumbnailBtn.classList.remove("active"),
  });
  tb.thumbnailBtn.addEventListener("click", () => tb.thumbnailBtn.classList.toggle("active", thumbs.toggle()));

  const search = createPdfSearch({
    getPdfDoc: () => pdfDoc,
    getPages: () => pages,
    isDestroyed: () => destroyed,
    reveal: (idx, x, y) => {
      exitFolded();
      if (isPaged()) { goToPage(idx + 1); return; }
      const w = pages[idx]?.wrapper;
      if (!w) return;
      const wr = w.getBoundingClientRect();
      const ar = scrollArea.getBoundingClientRect();
      const left = scrollArea.scrollLeft + wr.left - ar.left + x * wr.width - scrollArea.clientWidth / 2;
      const top = scrollArea.scrollTop + wr.top - ar.top + y * wr.height - scrollArea.clientHeight / 3;
      scrollArea.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: "smooth" });
    },
  });
  const findBar = createFindBar(body, search, () => scrollArea.focus({ preventScroll: true }));
  tb.findBtn.addEventListener("click", () => (findBar.isOpen() ? findBar.close() : findBar.open()));

  const outlinePanel = createOutlinePanel(body, {
    goTo: (idx, top) => goToPosition(idx, top),
    currentPage: () => currentPage(),
    onToggle: (on) => {
      tb.outlineBtn.classList.toggle("active", on);
      viewReporter.changed();
    },
  });
  tb.outlineBtn.addEventListener("click", () => outlinePanel.toggle());

  // ── Zoom & modes ─────────────────────────────────────────────────
  // While folded, a zoom step scales the folds in place via a multiplier
  // on the folded fit-width scale rather than leaving the folded view.
  function stepZoom(dir) {
    const cur = folded ? foldedZoom : getEffectiveZoom();
    const next = dir > 0
      ? ZOOM_LEVELS.find((z) => z > cur + 0.01)
      : [...ZOOM_LEVELS].reverse().find((z) => z < cur - 0.01);
    if (next == null) return;
    if (folded) { foldedZoom = next; foldLayer.refresh(); updateToolbarState(); }
    else applyFixedZoom(next);
  }
  tb.zoomOutBtn.addEventListener("click", () => stepZoom(-1));
  tb.zoomInBtn.addEventListener("click", () => stepZoom(1));
  tb.scrollHBtn.addEventListener("click", () => {
    if (layoutMode === "horizontal" && !folded) return;
    // Side by side, continuous pages fit the height; paged sets keep
    // their size.
    if (!paged) fitMode = "fit";
    switchLayout("horizontal");
  });
  tb.scrollVBtn.addEventListener("click", () => {
    if (layoutMode === "vertical" && !folded) return;
    switchLayout("vertical");
  });
  const fitBtn = (b, mode) => b.addEventListener("click", () => {
    if (!folded && fitMode === mode && (layoutMode === "vertical" || isPaged())) return;
    const page = leadPage();
    fitMode = mode;
    exitFolded(true);
    if (layoutMode === "fixed") layoutMode = "vertical";
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
    if (isPaged()) goToPage(page, { instant: true });
  });
  fitBtn(tb.fitOneBtn, "fit");
  fitBtn(tb.fitTwoBtn, "fit-2");
  fitBtn(tb.fitThreeBtn, "fit-3");

  function enterFolded() {
    if (folded) return;
    // The place at the centre of the view, to centre the folds on.
    const at = pages.length ? currentPage() - 1 : -1;
    const place = pages[at] ? { pageIndex: at, frac: pageFracAtCenter(scrollArea, pages[at]) } : null;
    folded = true;
    foldedZoom = 1.0;
    layoutMode = "vertical";
    fitMode = "fit";
    // The pages are hidden while folded; their rasters (up to the
    // renderer's whole budget) would sit beside the folds' all along.
    renderer.clearAll();
    applyLayoutClass();
    foldLayer.enable();
    if (place) foldLayer.centerOn(place);
    updateToolbarState();
    updatePageIndicator();
  }

  function exitFolded(skipRelayout = false) {
    if (!folded) return;
    // The place at the centre of the view (on the open page, if that is
    // what is in view) stays there — unless the caller places the view
    // itself, after its own relayout.
    const place = skipRelayout ? null : foldLayer.centerPlace();
    folded = false;
    pendingFoldAt = null;
    foldLayer.disable();
    applyLayoutClass();
    updateToolbarState();
    if (!skipRelayout) relayoutPages();
    if (place && pages[place.pageIndex]) {
      if (isPaged()) goToPage(place.pageIndex + 1, { instant: true });
      else centerPagePoint(scrollArea, pages[place.pageIndex], place.frac, layoutMode === "horizontal");
    }
    updatePageIndicator();
  }
  tb.foldBtn.addEventListener("click", () => (folded ? exitFolded() : enterFolded()));

  // Paged sets or continuous; either leaves the folded view. A fixed
  // zoom has no direction to swipe in, so Paged goes to vertical fit.
  function setPageMode(on) {
    if (!folded && on === isPaged()) return;
    const page = leadPage();
    paged = on;
    exitFolded(true);
    if (layoutMode === "fixed") layoutMode = "vertical";
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
    goToPage(page, { instant: true });
  }
  tb.pagedBtn.addEventListener("click", () => setPageMode(true));
  tb.continuousBtn.addEventListener("click", () => setPageMode(false));

  const keys = attachViewerKeys({
    root, scrollArea, tb,
    isSuspended: () => suspendMgr.isSuspended(),
    isFolded: () => folded,
    foldElements: () => foldLayer.foldElements(),
    stepZoom,
    resetZoom: () => { exitFolded(true); fitMode = "fit"; switchLayout("horizontal"); },
    pageCount: () => pages.length,
    stepSize: () => (isPaged() ? perSet() : 1),
    currentPage: () => currentPage(),
    goToPage: (n) => goToPage(n),
    openFind: () => findBar.open(),
  });
  attachPagedWheel(scrollArea, isPaged, keys.stepPage);

  /** The modes, as pdf-viewer-layout.js reads them. */
  const layoutState = () => ({
    layoutMode, fitMode, folded, paged: isPaged(), perSet: perSet(), foldedZoom, fixedZoom,
    crop: cropper.effective(),
  });
  function getEffectiveZoom() {
    const first = pages[0];
    return first?.viewport && pdfDoc ? fitZoom(scrollArea, first.viewport, layoutState()) : 1;
  }

  function updateToolbarState() {
    syncToolbar(tb, { layoutMode, fitMode, folded, paged: isPaged(), foldedZoom, zoom: getEffectiveZoom });
    if (isMain && !folded && pdfDoc) saveViewPrefs({ layoutMode, fitMode, fixedZoom, paged });
    viewReporter.changed();
    // Persist view-state changes (fit / direction / fixed zoom) the
    // instant they happen, not only on a later scroll. Guarded so
    // restore + initial load don't echo back.
    if (!suspendMgr.isSuspended() && !suspendMgr.isResuming()) for (const cb of scrollListeners) cb();
  }

  function currentPage() {
    if (!pages.length) return 1;
    return folded ? foldLayer.getCurrentPage() : renderer.pageAtViewCenter();
  }

  let reportView = false;
  function updatePageIndicator() {
    if (!pages.length) { tb.pageIndicator.textContent = ""; return; }
    // A paged set of several pages shows as its range ("7–9 / 13").
    const lead = leadPage();
    const last = isPaged() ? Math.min(pages.length, lead + perSet() - 1) : lead;
    tb.pageIndicator.textContent = `${last > lead ? `${lead}–${last}` : currentPage()} / ${pages.length}`;
    outlinePanel.onPage();
    viewReporter.changed();
  }

  let indicatorRaf = 0;
  scrollArea.addEventListener("scroll", () => {
    // Skip events fired by the suspend/resume teardown — clearing
    // scrollArea.innerHTML resets scrollTop to 0, and that synthetic 0
    // mustn't overwrite the host pane's saved scroll before resume has
    // put it back.
    if (suspendMgr.isSuspended() || suspendMgr.isResuming()) return;
    // The render-set update is rAF-coalesced and refreshes the page
    // indicator itself; folded mode short-circuits the renderer, so the
    // indicator is coalesced here.
    if (!folded) renderer.scheduleUpdate();
    else if (!indicatorRaf) {
      indicatorRaf = requestAnimationFrame(() => { indicatorRaf = 0; updatePageIndicator(); });
    }
    for (const cb of scrollListeners) cb();
  });

  // The page at the start of the view stays there: the anchor
  // relayoutPages keeps is measured along the new direction, against the
  // old layout. (Not the page at the centre — goToPage puts a page at the
  // start, so that would creep a page on with every switch.)
  function switchLayout(mode) {
    const lead = folded ? null : viewAnchor(scrollArea, pages, layoutMode === "horizontal");
    const page = lead ? lead.idx + 1 + (lead.frac > 0.5 ? 1 : 0) : currentPage();
    exitFolded(true);
    layoutMode = mode;
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
    goToPage(page, { instant: true });
  }

  function applyFixedZoom(level) {
    exitFolded(true);
    paged = false;
    fixedZoom = level;
    layoutMode = "fixed";
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }

  function applyLayoutClass() {
    applyLayoutClasses(scrollArea, layoutState());
  }

  // ── Page layout ──────────────────────────────────────────────────
  // Geometry only — rasterisation lives in pdf-viewer-render.js. A
  // relayout resizes every wrapper and *stretches* the existing canvas
  // sandwich (CSS transform, no canvas work), so a drag-resize costs
  // style writes alone; the settle pass re-renders crisp at the final
  // scale once the geometry has been still for a beat.
  let relayoutGuard = false;
  function relayoutPages() {
    if (relayoutGuard || !pdfDoc || !pages.length || suspendMgr.isSuspended()) return;
    if (folded) { foldLayer.refresh(); return; }
    relayoutGuard = true;
    try {
      const anchor = viewAnchor(scrollArea, pages, layoutMode === "horizontal");
      const scale = getEffectiveZoom();
      const state = layoutState();
      for (const p of pages) {
        sizePage(p, scale, state.crop);
        if (p.contentEl && p.contentW) {
          const k = Math.round(p.viewport.width * scale) / p.contentW;
          p.contentEl.style.transform = Math.abs(k - 1) > 0.001 ? `scale(${k})` : "";
        }
      }
      sizePagedGap(scrollArea, pages, scale, state);
      cropper.relaidOut();
      if (anchor) restoreAnchor(scrollArea, pages, layoutMode === "horizontal", anchor);
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
    reportView = false;
    if (pdfDoc) { await pdfDoc.destroy(); pdfDoc = null; }
    renderer.reset();
    pages = [];
    scrollArea.innerHTML = "";

    const doc = await pdfjs.getDocument({ ...pdfInput(data), ...PDFJS_ASSETS }).promise;
    if (destroyed) { await doc.destroy(); return; }
    pdfDoc = doc;
    applyLayoutClass();

    // Only page 1's dimensions are fetched up front — the rest of the
    // wrappers are seeded from them (pdf-viewer-pages.js).
    const firstPage = await doc.getPage(1);
    if (destroyed || pdfDoc !== doc) return;
    pages = createPageRecords(scrollArea, doc.numPages, firstPage.getViewport({ scale: 1 }),
      { zoteroAttKey: _zoteroAttKey, fileId: _fileId });
    const scale = getEffectiveZoom();
    const state = layoutState();
    for (const p of pages) sizePage(p, scale, state.crop);
    sizePagedGap(scrollArea, pages, scale, state);
    renderer.update();
    // A reload while folded (e.g. resume) wiped the fold DOM with
    // scrollArea.innerHTML above — rebuild it against the new pages.
    if (folded) { foldLayer.enable(); restorePendingFold(); }
    else if (savedMain?.at && !suspendMgr.isResuming() && savedMain.at.idx < pages.length) {
      // The main viewer reopening this PDF: its place, once now and once
      // the container has settled.
      const at = savedMain.at;
      restoreAnchor(scrollArea, pages, layoutMode === "horizontal", at);
      requestAnimationFrame(() => restoreAnchor(scrollArea, pages, layoutMode === "horizontal", at));
    }
    updateToolbarState();
    updatePageIndicator();
    // From the next frames on, the view is reported (main viewer).
    requestAnimationFrame(() => requestAnimationFrame(() => { reportView = true; }));
    readOutline(doc).then((o) => {
      if (destroyed || pdfDoc !== doc) return;
      tb.outlineBtn.style.display = o.length ? "" : "none";
      outlinePanel.setOutline(o);
      if (savedMain?.outline && !outlinePanel.isOpen()) outlinePanel.setOpen(true);
    });
    search.rerun();
    // The main viewer takes the keyboard as it opens, unless the reader
    // is typing somewhere.
    const focused = document.activeElement;
    if (isMain && !(focused && (focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)))) {
      scrollArea.focus({ preventScroll: true });
    }
  }

  // ── The encoded zoom (hosts' persistence, suspend / resume) ──────
  function setZoom(level) {
    const d = decodeZoom(level);
    if (d.folded) { enterFolded(); return; }
    exitFolded(true);
    paged = d.paged;
    layoutMode = d.layoutMode;
    if (d.fitMode) fitMode = d.fitMode;
    if (d.fixedZoom) fixedZoom = d.fixedZoom;
    applyLayoutClass();
    updateToolbarState();
    relayoutPages();
  }
  const getZoom = () => encodeZoom({ layoutMode, fitMode, folded, paged: isPaged(), fixedZoom });

  function goToPage(n, o = {}) {
    if (folded) { foldLayer.goToPage(n); return; }
    let idx = Math.max(0, Math.min(n - 1, pages.length - 1));
    // Paged: the set holding the page, by its first page (its snap point).
    if (isPaged()) idx -= idx % perSet();
    const w = pages[idx]?.wrapper;
    if (!w) return;
    // `instant`: deterministic positioning for deep links landing right
    // after a mount — a smooth scroll started that early can be
    // cancelled by the container unhiding / first renders.
    scrollToPage(scrollArea, w, layoutMode === "horizontal", !o.instant);
  }

  /** A place on a page: `top` in PDF user space (y up), null for the
   *  page's top. Side by side, or a set at a time, only the page counts. */
  function goToPosition(pageIndex, top) {
    const p = pages[pageIndex];
    if (!p) return;
    if (top == null || folded || layoutMode === "horizontal" || isPaged()) goToPage(pageIndex + 1);
    else scrollToPagePoint(scrollArea, p, top);
  }

  function onScroll(cb) {
    scrollListeners.push(cb);
    return () => { scrollListeners = scrollListeners.filter((c) => c !== cb); };
  }

  // ── Suspend / Resume (lightweight snapshot for inactive panes) ────
  // pdf-viewer-suspend.js; env callbacks bridge into this closure.
  const suspendMgr = createPdfSuspendManager(scrollArea, {
    isDestroyed: () => destroyed,
    hasDoc: () => !!pdfDoc,
    getData: () => (pdfDoc ? pdfDoc.getData() : Promise.reject(new Error("no doc"))),
    getZoom: () => getZoom(),
    setZoom: (level) => setZoom(level),
    relayoutPages: () => relayoutPages(),
    drawSnapshot: (ctx, w, h) => (folded ? foldLayer.drawSnapshot(ctx, w, h) : drawPagesSnapshot(scrollArea, pages, ctx, h)),
    onSuspendStart: () => {
      viewReporter.flush();
      thumbs.destroy();
      tb.thumbnailBtn.classList.remove("active");
      findBar.close();
      resizeObserver?.disconnect();
      renderer.destroy();
    },
    teardownContent: () => {
      // Folded state was captured via getZoom (-5) already; drop the
      // live fold DOM with everything else. Resume's restoreView(-5)
      // re-enters folded mode after the reload.
      if (folded) { folded = false; foldLayer.disable(); applyLayoutClass(); }
      renderer.clearAll();
      renderer.reset();
      if (pdfDoc) { try { pdfDoc.destroy(); } catch (_) {} pdfDoc = null; }
      pages = [];
      scrollArea.innerHTML = "";
    },
    onResumeStart: () => {
      try { resizeObserver?.observe(scrollArea); } catch (_) {}
    },
    reload: async (data) => {
      const saved = annotLayer.getAnnotations().slice();
      await loadPdf(data);
      if (saved.length) setAnnotations(saved);
    },
  });

  // ── Resize ───────────────────────────────────────────────────────
  let resizeObserver = null;
  let resizeTimer = null;
  try {
    resizeObserver = new ResizeObserver(() => {
      if (!pages.length || suspendMgr.isSuspended()) return;
      // Render-set refresh always (covers a hidden container gaining
      // size, where no scroll event fires); fit-mode geometry follows
      // behind a short debounce. A container resize can re-wrap
      // fixed-zoom rows, so the cached page geometry is stale either way.
      renderer.invalidateGeometry();
      renderer.scheduleUpdate();
      if (layoutMode === "fixed") return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { resizeTimer = null; relayoutPages(); }, 80);
    });
    resizeObserver.observe(scrollArea);
  } catch (_) {}

  // ── Cleanup ──────────────────────────────────────────────────────
  async function destroy() {
    viewReporter.dispose();
    destroyed = true;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeTimer) clearTimeout(resizeTimer);
    keys.detach();
    cropper.destroy();
    foldLayer.destroy();
    thumbs.destroy();
    renderer.destroy();
    findBar.destroy();
    outlinePanel.destroy();
    detachTooltips();
    scrollListeners = [];
    const doc = pdfDoc;
    pdfDoc = null;
    pages = [];
    root.remove();
    if (doc) { try { await doc.destroy(); } catch (_) {} }
    await releaseTextLayers();
  }

  return {
    loadPdf,
    destroy,
    suspend: suspendMgr.suspend,
    resume: suspendMgr.resume,
    get suspended() { return suspendMgr.isSuspended(); },
    setZoom,
    getZoom,
    goToPage,
    goToPosition,
    getPageCount: () => (pdfDoc ? pdfDoc.numPages : 0),
    currentPage: () => currentPage(),
    getScrollTop: () => scrollArea.scrollTop,
    setScrollTop: (v) => { scrollArea.scrollTop = v; },
    getScrollLeft: () => scrollArea.scrollLeft,
    setScrollLeft: (v) => { scrollArea.scrollLeft = v; },
    restoreView: suspendMgr.restoreView,
    onScroll,
    setAnnotations,
    refreshAnnotations: () => {
      renderer.repaint(pages.map((_, i) => i));
      annotLayer.refreshList();
      foldLayer.refresh(true);
    },
    setZoteroAttKey,
    setToolbarInfo: (title, author) => applyToolbarInfo(tb.toolbarInfo, title, author),
    toggleShelf: annotLayer.toggleShelf,
    setNotes: annotLayer.setNotes,
    /** Report a view change still waiting out its pause. */
    flushView: () => viewReporter.flush(),
    get element() { return root; },
  };
}
