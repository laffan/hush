/**
 * PDF.js interactive viewer — renders a scrollable, zoomable PDF inside
 * a container. Supports both the main editor area and floating panes.
 *
 * Layout modes:
 *   - fit-width (default): pages scale to fill available width, vertical scroll
 *   - fixed zoom (50%-200%): explicit scale; pages wrap when small enough
 *   - horizontal scroll: pages fit container height, horizontal scroll
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
  let annotations = [];
  let scrollListeners = [];
  let destroyed = false;
  let prevModeBeforeHScroll = MODE_FIT_WIDTH;

  const root = document.createElement("div");
  root.className = "pdf-viewer";

  // ── Main body: scroll area + shelf side-by-side ──────────────────
  const body = document.createElement("div");
  body.className = "pdf-viewer-body";

  const scrollArea = document.createElement("div");
  scrollArea.className = "pdf-scroll-area pdf-layout-fit";
  body.appendChild(scrollArea);

  // ── Annotation shelf (right panel) ───────────────────────────────
  const shelf = document.createElement("div");
  shelf.className = "pdf-annot-shelf";

  const shelfGrip = document.createElement("button");
  shelfGrip.className = "pdf-annot-shelf-grip";
  shelfGrip.textContent = "‹";
  shelfGrip.title = "Annotations";
  shelf.appendChild(shelfGrip);

  const shelfContent = document.createElement("div");
  shelfContent.className = "pdf-annot-shelf-content";

  const shelfHeader = document.createElement("div");
  shelfHeader.className = "pdf-annot-shelf-header";
  shelfHeader.textContent = "Annotations";
  shelfContent.appendChild(shelfHeader);

  const shelfSearch = document.createElement("input");
  shelfSearch.type = "text";
  shelfSearch.className = "pdf-annot-shelf-search";
  shelfSearch.placeholder = "Filter...";
  shelfContent.appendChild(shelfSearch);

  const shelfBody = document.createElement("div");
  shelfBody.className = "pdf-annot-shelf-body";
  shelfContent.appendChild(shelfBody);

  shelf.appendChild(shelfContent);
  body.appendChild(shelf);
  root.appendChild(body);

  // ── Toolbar (bottom bar) ─────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-zoom-toolbar";

  const zoomOutBtn = btn("pdf-zoom-btn", "−", "Zoom out");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom-label";
  zoomLabel.textContent = "Fit";
  const zoomInBtn = btn("pdf-zoom-btn", "+", "Zoom in");
  const fitBtn = btn("pdf-zoom-btn pdf-mode-btn active", "↔", "Fit to width");
  const hScrollBtn = btn("pdf-zoom-btn pdf-mode-btn", "⇔", "Horizontal scroll");
  const pageIndicator = document.createElement("span");
  pageIndicator.className = "pdf-page-indicator";

  const zoteroLink = document.createElement("a");
  zoteroLink.className = "pdf-zotero-link";
  zoteroLink.textContent = "Open in Zotero ↗";
  zoteroLink.style.display = "none";

  toolbar.append(zoomOutBtn, zoomLabel, zoomInBtn, fitBtn, hScrollBtn, pageIndicator, zoteroLink);
  root.appendChild(toolbar);

  container.appendChild(root);

  let shelfOpen = false;
  let shelfFilter = "";

  function toggleShelf() {
    shelfOpen = !shelfOpen;
    shelf.classList.toggle("open", shelfOpen);
    shelfGrip.textContent = shelfOpen ? "›" : "‹";
    if (shelfOpen) rebuildShelfList();
  }

  shelfGrip.addEventListener("click", toggleShelf);
  shelfSearch.addEventListener("input", () => {
    shelfFilter = shelfSearch.value.toLowerCase();
    rebuildShelfList();
  });

  function highlightMatches(text, query) {
    if (!query) return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    const lower = text.toLowerCase();
    let last = 0;
    let idx = lower.indexOf(query, last);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className = "pdf-annot-shelf-match";
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      last = idx + query.length;
      idx = lower.indexOf(query, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function rebuildShelfList() {
    shelfBody.innerHTML = "";
    if (!annotations.length) {
      shelfBody.innerHTML = '<div class="pdf-annot-shelf-empty">No annotations</div>';
      return;
    }
    const filtered = shelfFilter
      ? annotations.filter(a => {
          const text = (a.text || "").toLowerCase();
          const comment = (a.comment || "").toLowerCase();
          return text.includes(shelfFilter) || comment.includes(shelfFilter);
        })
      : annotations;

    if (!filtered.length) {
      shelfBody.innerHTML = '<div class="pdf-annot-shelf-empty">No matches</div>';
      return;
    }
    for (const annot of filtered) {
      if (!annot.text && !annot.comment) continue;
      const row = document.createElement("div");
      row.className = "pdf-annot-shelf-row";
      row.style.borderLeftColor = annot.color || "#ffff00";
      row.style.cursor = "pointer";

      row.addEventListener("click", () => scrollToAnnotation(annot));

      if (annot.text) {
        const textEl = document.createElement("div");
        textEl.className = "pdf-annot-shelf-text";
        textEl.appendChild(highlightMatches(annot.text, shelfFilter));
        row.appendChild(textEl);
      }
      if (annot.comment) {
        const commentEl = document.createElement("div");
        commentEl.className = "pdf-annot-shelf-comment";
        commentEl.appendChild(highlightMatches(annot.comment, shelfFilter));
        row.appendChild(commentEl);
      }
      const meta = document.createElement("div");
      meta.className = "pdf-annot-shelf-meta";
      if (annot.pageLabel) {
        const pageTxt = document.createElement("span");
        pageTxt.className = "pdf-annot-shelf-page";
        pageTxt.textContent = `p. ${annot.pageLabel}`;
        meta.appendChild(pageTxt);
      }
      row.appendChild(meta);
      shelfBody.appendChild(row);
    }
  }

  function scrollToAnnotation(annot) {
    const pos = parseAnnotationPosition(annot);
    if (!pos) {
      const pageNum = parseInt(annot.pageLabel, 10);
      if (!isNaN(pageNum)) goToPage(pageNum);
      return;
    }
    const pageIdx = pos.pageIndex;
    if (pageIdx < 0 || pageIdx >= pages.length) return;
    const p = pages[pageIdx];
    if (!p?.wrapper) return;

    const scale = getEffectiveZoom();
    const firstRect = pos.rects?.[0];
    if (!firstRect) {
      p.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const [, y1, , y2] = firstRect;
    const pageH = p.viewport.height;
    const topInPage = (pageH - y2) * scale;

    if (layoutMode === MODE_HORIZONTAL) {
      const targetLeft = p.wrapper.offsetLeft + firstRect[0] * scale - scrollArea.clientWidth / 3;
      scrollArea.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
    } else {
      const targetTop = p.wrapper.offsetTop + topInPage - scrollArea.clientHeight / 3;
      scrollArea.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }

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
  fitBtn.addEventListener("click", () => switchMode(MODE_FIT_WIDTH));
  hScrollBtn.addEventListener("click", () => {
    if (layoutMode === MODE_HORIZONTAL) {
      switchMode(prevModeBeforeHScroll);
    } else {
      prevModeBeforeHScroll = layoutMode;
      switchMode(MODE_HORIZONTAL);
    }
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
    if (layoutMode === MODE_FIT_WIDTH) zoomLabel.textContent = "Fit W";
    else if (layoutMode === MODE_HORIZONTAL) zoomLabel.textContent = "Fit H";
    else zoomLabel.textContent = `${Math.round(z * 100)}%`;
    fitBtn.classList.toggle("active", layoutMode === MODE_FIT_WIDTH);
    hScrollBtn.classList.toggle("active", layoutMode === MODE_HORIZONTAL);
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

  function relayoutPages() {
    if (!pdfDoc || !pages.length) return;
    const scale = getEffectiveZoom();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      p.wrapper.style.width = `${Math.round(p.viewport.width * scale)}px`;
      p.wrapper.style.height = `${Math.round(p.viewport.height * scale)}px`;
      if (p.rendered) clearPage(i);
    }
    if (observer) observer.disconnect();
    setupObserver();
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

  // ── Annotations ──────────────────────────────────────────────────
  function setAnnotations(annots) {
    annotations = annots || [];
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
    shelf.classList.toggle("has-annotations", annotations.length > 0);
    if (shelfOpen) rebuildShelfList();
  }

  function refreshAnnotations() {
    for (let i = 0; i < pages.length; i++) {
      const layer = pages[i].wrapper?.querySelector(".pdf-annot-layer");
      if (layer) layer.remove();
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
    if (shelfOpen) rebuildShelfList();
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
      if (!pos) continue;

      if (annot.type === "ink" && pos.paths?.length) {
        paintInkAnnotation(layer, annot, pos, scale, p.viewport);
      } else if (pos.rects?.length) {
        for (const rect of pos.rects) {
          const [x1, y1, x2, y2] = rect;
          const div = document.createElement("div");
          div.className = "pdf-annot-highlight";
          div.style.left = `${x1 * scale}px`;
          div.style.bottom = `${y1 * scale}px`;
          div.style.width = `${(x2 - x1) * scale}px`;
          div.style.height = `${(y2 - y1) * scale}px`;
          div.style.backgroundColor = annot.color || "#ffff00";
          if (annot.comment) div.title = annot.comment;
          layer.appendChild(div);
        }
      }
    }
    if (layer.children.length) p.wrapper.appendChild(layer);
  }

  function paintInkAnnotation(layer, annot, pos, scale, viewport) {
    const w = Math.round(viewport.width * scale);
    const h = Math.round(viewport.height * scale);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("pdf-annot-ink");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    for (const pathPoints of pos.paths) {
      if (!pathPoints || pathPoints.length < 2) continue;
      let d = "";
      for (let i = 0; i < pathPoints.length; i += 2) {
        const x = pathPoints[i] * scale;
        const y = (viewport.height - pathPoints[i + 1]) * scale;
        d += (i === 0 ? "M" : "L") + `${x},${y} `;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", annot.color || "#ff0000");
      path.setAttribute("stroke-width", String(Math.max(0.5, scale)));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
    }
    layer.appendChild(svg);
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
  try {
    resizeObserver = new ResizeObserver(() => {
      if (layoutMode !== MODE_FIXED && pages.length) relayoutPages();
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
    setZoteroAttKey,
    toggleShelf,
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
