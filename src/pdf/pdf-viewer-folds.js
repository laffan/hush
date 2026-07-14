/**
 * Folded view for the PDF viewer — collapses the document down to just
 * the regions that carry annotations ("folds"). Each fold shows the
 * full page width (so the text stays readable) but only extends a line
 * or two above and below the annotation itself.
 *
 * - Folds are lazy-rendered via IntersectionObserver, mirroring the
 *   main viewer's page rendering. Each fold owns a full-page canvas
 *   clipped by its wrapper, so the hover toggle can reveal the whole
 *   page without a re-render.
 * - A corner toggle (visible on fold hover) temporarily expands the
 *   fold to the full page; clicking again collapses it back.
 * - A filter popup (toolbar funnel button) picks which annotation
 *   type + colour combinations produce folds. Default: red handwriting
 *   (ink) and red highlights.
 */

import { parseAnnotationPosition, paintAnnotationsInto } from "./pdf-viewer-annotations.js";

const FOLD_PAD = 28;   // page units (~2 text lines) above/below the annotation
const MERGE_GAP = 16;  // merge folds whose padded regions come this close

const EXPAND_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 L8 2.5 L12 6"/><path d="M4 10 L8 13.5 L12 10"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5 L8 6 L12 2.5"/><path d="M4 13.5 L8 10 L12 13.5"/></svg>`;

const TYPE_LABELS = {
  highlight: "Highlights",
  underline: "Underlines",
  ink: "Handwriting",
  note: "Notes",
  image: "Areas",
};
const TYPE_ORDER = ["highlight", "underline", "ink", "note", "image"];

/** Zotero red is #ff6666; accept the red family without catching
 *  orange (#f19837) or magenta (#e56eee). */
function isRed(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec((color || "").trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const r = v >> 16, g = (v >> 8) & 0xff, b = v & 0xff;
  return r >= 180 && g < 140 && b < 140;
}

/**
 * @param {HTMLElement} scrollArea  The viewer's scroll container
 * @param {object}      viewer      Live viewer state / helpers
 * @param {function}    viewer.getPages          () => pages[]
 * @param {function}    viewer.getPdfDoc         () => pdfjs document | null
 * @param {function}    viewer.getAnnotations    () => normalized annotations[]
 * @param {function}    viewer.getEffectiveZoom  () => number (vertical-fit scale while folded)
 * @param {function}    viewer.isDestroyed       () => boolean
 */
export function createFoldLayer(scrollArea, viewer) {
  let enabled = false;
  let folds = [];
  let observer = null;
  let emptyMsg = null;

  let filter = null;            // Set of "type:color" keys; null = defaults not seeded
  let filterCustomized = false; // user has touched the filter — stop re-seeding defaults
  let popup = null;
  let filterBtnRef = null;
  let hostRef = null;

  let lastScale = null;
  let lastAnnRef = null;
  let lastFilterSig = null;

  // ── Filter ─────────────────────────────────────────────────────────
  function comboKey(a) {
    return `${a.type}:${(a.color || "").toLowerCase()}`;
  }

  /** Distinct (type, color) combos among positioned annotations. */
  function availableCombos() {
    const map = new Map();
    for (const a of viewer.getAnnotations()) {
      const pos = parseAnnotationPosition(a);
      if (!pos || typeof pos.pageIndex !== "number") continue;
      const key = comboKey(a);
      const entry = map.get(key) || { type: a.type, color: (a.color || "").toLowerCase(), count: 0 };
      entry.count++;
      map.set(key, entry);
    }
    return map;
  }

  function ensureFilter() {
    if (filter) return;
    filter = new Set();
    for (const [key, c] of availableCombos()) {
      if ((c.type === "ink" || c.type === "highlight") && isRed(c.color)) filter.add(key);
    }
  }

  function matchesFilter(a) {
    return filter.has(comboKey(a));
  }

  function filterSig() {
    return [...filter].sort().join(",");
  }

  // ── Fold geometry ──────────────────────────────────────────────────
  /** Vertical extent of an annotation in top-based page units, or null. */
  function annotationExtent(annot, pageH) {
    const pos = parseAnnotationPosition(annot);
    if (!pos) return null;
    let top = Infinity, bottom = -Infinity;
    if (Array.isArray(pos.rects)) {
      for (const r of pos.rects) {
        if (!Array.isArray(r) || r.length < 4) continue;
        top = Math.min(top, pageH - r[3]);
        bottom = Math.max(bottom, pageH - r[1]);
      }
    }
    if (Array.isArray(pos.paths)) {
      for (const path of pos.paths) {
        if (!Array.isArray(path)) continue;
        for (let i = 1; i < path.length; i += 2) {
          const y = pageH - path[i];
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (top === Infinity) return null;
    return { top, bottom };
  }

  /** Padded, per-page-merged fold intervals for the active filter. */
  function computeFolds() {
    ensureFilter();
    const pages = viewer.getPages();
    const byPage = new Map();
    for (const a of viewer.getAnnotations()) {
      if (!matchesFilter(a)) continue;
      const pos = parseAnnotationPosition(a);
      if (!pos || typeof pos.pageIndex !== "number") continue;
      const p = pages[pos.pageIndex];
      if (!p?.viewport) continue;
      const ext = annotationExtent(a, p.viewport.height);
      if (!ext) continue;
      const list = byPage.get(pos.pageIndex) || [];
      list.push({
        top: Math.max(0, ext.top - FOLD_PAD),
        bottom: Math.min(p.viewport.height, ext.bottom + FOLD_PAD),
      });
      byPage.set(pos.pageIndex, list);
    }
    const out = [];
    for (const idx of [...byPage.keys()].sort((a, b) => a - b)) {
      const list = byPage.get(idx).sort((a, b) => a.top - b.top);
      let cur = null;
      for (const iv of list) {
        if (cur && iv.top <= cur.bottom + MERGE_GAP) {
          cur.bottom = Math.max(cur.bottom, iv.bottom);
        } else {
          cur = { pageIndex: idx, top: iv.top, bottom: iv.bottom };
          out.push(cur);
        }
      }
    }
    return out;
  }

  // ── DOM build / teardown ───────────────────────────────────────────
  function teardownDom() {
    if (observer) { observer.disconnect(); observer = null; }
    for (const f of folds) f.wrapper.remove();
    folds = [];
    if (emptyMsg) { emptyMsg.remove(); emptyMsg = null; }
  }

  function build() {
    teardownDom();
    const scale = viewer.getEffectiveZoom();
    const pages = viewer.getPages();
    const specs = computeFolds();

    if (!specs.length) {
      emptyMsg = document.createElement("div");
      emptyMsg.className = "pdf-fold-empty";
      emptyMsg.textContent = viewer.getAnnotations().length
        ? "No annotations match the current filter."
        : "No annotations to fold.";
      scrollArea.appendChild(emptyMsg);
      return;
    }

    for (const spec of specs) {
      const p = pages[spec.pageIndex];
      const cssW = Math.round(p.viewport.width * scale);
      const pageCssH = Math.round(p.viewport.height * scale);
      const foldCssH = Math.max(24, Math.round((spec.bottom - spec.top) * scale));

      const wrapper = document.createElement("div");
      wrapper.className = "pdf-fold-wrapper";
      wrapper.style.width = `${cssW}px`;
      wrapper.style.height = `${foldCssH}px`;

      const inner = document.createElement("div");
      inner.className = "pdf-fold-page";
      inner.style.width = `${cssW}px`;
      inner.style.height = `${pageCssH}px`;
      inner.style.top = `-${Math.round(spec.top * scale)}px`;
      wrapper.appendChild(inner);

      const label = document.createElement("span");
      label.className = "pdf-fold-page-label";
      label.textContent = `p. ${spec.pageIndex + 1}`;
      wrapper.appendChild(label);

      const toggle = document.createElement("button");
      toggle.className = "pdf-fold-toggle";
      toggle.title = "Reveal full page";
      toggle.innerHTML = EXPAND_ICON;
      wrapper.appendChild(toggle);

      const fold = {
        ...spec, wrapper, inner, toggle, scale,
        cssW, pageCssH, foldCssH,
        rendered: false, rendering: false, expanded: false, canvas: null,
      };
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleExpand(fold);
      });
      wrapper.dataset.foldIndex = String(folds.length);
      scrollArea.appendChild(wrapper);
      folds.push(fold);
    }

    setupObserver();
  }

  function toggleExpand(fold) {
    fold.expanded = !fold.expanded;
    fold.wrapper.classList.toggle("pdf-fold-expanded", fold.expanded);
    fold.wrapper.style.height = `${fold.expanded ? fold.pageCssH : fold.foldCssH}px`;
    fold.inner.style.top = fold.expanded ? "0px" : `-${Math.round(fold.top * fold.scale)}px`;
    fold.toggle.title = fold.expanded ? "Collapse to fold" : "Reveal full page";
    fold.toggle.innerHTML = fold.expanded ? COLLAPSE_ICON : EXPAND_ICON;
  }

  // ── Rendering ──────────────────────────────────────────────────────
  function setupObserver() {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = parseInt(entry.target.dataset.foldIndex, 10);
        if (isNaN(idx) || !folds[idx]) continue;
        renderFold(folds[idx]);
        if (folds[idx - 1]) renderFold(folds[idx - 1]);
        if (folds[idx + 1]) renderFold(folds[idx + 1]);
      }
    }, { root: scrollArea, rootMargin: "300px" });
    for (const f of folds) observer.observe(f.wrapper);
  }

  async function renderFold(fold) {
    if (fold.rendered || fold.rendering || !enabled || viewer.isDestroyed()) return;
    const pdfDoc = viewer.getPdfDoc();
    if (!pdfDoc) return;
    fold.rendering = true;
    try {
      const page = await pdfDoc.getPage(fold.pageIndex + 1);
      if (!enabled || viewer.isDestroyed() || !fold.wrapper.isConnected) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: fold.scale * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.className = "pdf-page-canvas";
      canvas.style.width = `${fold.cssW}px`;
      canvas.style.height = `${fold.pageCssH}px`;
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      if (!enabled || viewer.isDestroyed() || !fold.wrapper.isConnected) return;
      fold.inner.innerHTML = "";
      fold.inner.appendChild(canvas);
      fold.canvas = canvas;
      paintFoldAnnotations(fold);
      fold.rendered = true;
    } catch (e) {
      console.error(`Failed to render fold on page ${fold.pageIndex + 1}:`, e);
    } finally {
      fold.rendering = false;
    }
  }

  /** All annotations on the fold's page — not just the filtered ones —
   *  so the revealed page slice reads exactly like the normal view. */
  function paintFoldAnnotations(fold) {
    const p = viewer.getPages()[fold.pageIndex];
    if (!p?.viewport) return;
    const pageAnnots = viewer.getAnnotations().filter((a) => {
      const pos = parseAnnotationPosition(a);
      return pos && pos.pageIndex === fold.pageIndex;
    });
    if (!pageAnnots.length) return;
    const layer = document.createElement("div");
    layer.className = "pdf-annot-layer";
    const scaleX = fold.cssW / p.viewport.width;
    const scaleY = fold.pageCssH / p.viewport.height;
    paintAnnotationsInto(layer, pageAnnots, p.viewport, scaleX, scaleY);
    if (layer.children.length) fold.inner.appendChild(layer);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  function domAlive() {
    if (folds.length) return folds[0].wrapper.isConnected;
    return emptyMsg ? emptyMsg.isConnected : false;
  }

  function refresh(force = false) {
    if (!enabled) return;
    ensureFilter();
    const scale = viewer.getEffectiveZoom();
    const annRef = viewer.getAnnotations();
    const fsig = filterSig();
    if (!force && scale === lastScale && annRef === lastAnnRef && fsig === lastFilterSig && domAlive()) return;
    lastScale = scale;
    lastAnnRef = annRef;
    lastFilterSig = fsig;
    build();
  }

  function enable() {
    enabled = true;
    refresh(true);
  }

  function disable() {
    enabled = false;
    closePopup();
    teardownDom();
    lastScale = null;
    lastAnnRef = null;
    lastFilterSig = null;
  }

  function onAnnotationsChanged() {
    // Re-seed the default filter from the fresh annotation set unless
    // the user has explicitly customized it.
    if (!filterCustomized) filter = null;
    if (enabled) refresh(true);
  }

  // ── Navigation helpers ─────────────────────────────────────────────
  /** Scroll to the fold containing (or nearest to) an annotation.
   *  Returns true when handled — the shelf falls back otherwise. */
  function scrollToAnnotation(annot) {
    if (!enabled || !folds.length) return false;
    const pos = parseAnnotationPosition(annot);
    if (!pos || typeof pos.pageIndex !== "number") return false;
    const p = viewer.getPages()[pos.pageIndex];
    const ext = p?.viewport ? annotationExtent(annot, p.viewport.height) : null;

    let best = null;
    for (const f of folds) {
      if (f.pageIndex !== pos.pageIndex) continue;
      if (!best) best = f;
      if (ext && ext.top >= f.top - 1 && ext.top <= f.bottom + 1) { best = f; break; }
    }
    // Annotation's page has no fold (filtered out) — land on the
    // nearest following fold so the folded view doesn't jump to 0.
    if (!best) best = folds.find((f) => f.pageIndex >= pos.pageIndex) || folds[folds.length - 1];
    scrollArea.scrollTo({
      top: Math.max(0, best.wrapper.offsetTop - scrollArea.clientHeight / 3),
      behavior: "smooth",
    });
    return true;
  }

  function goToPage(n) {
    if (!folds.length) return;
    const idx = n - 1;
    const target = folds.find((f) => f.pageIndex >= idx) || folds[folds.length - 1];
    target.wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function getCurrentPage() {
    if (!folds.length) return 1;
    const mid = scrollArea.scrollTop + scrollArea.clientHeight / 2;
    let cur = folds[0].pageIndex + 1;
    for (const f of folds) {
      if (f.wrapper.offsetTop <= mid) cur = f.pageIndex + 1;
    }
    return cur;
  }

  /** Paint visible folds into the suspend snapshot canvas. */
  function drawSnapshot(ctx, w, h) {
    const areaRect = scrollArea.getBoundingClientRect();
    for (const f of folds) {
      if (!f.canvas) continue;
      const rect = f.wrapper.getBoundingClientRect();
      const dx = rect.left - areaRect.left;
      const dy = rect.top - areaRect.top;
      if (dy + rect.height < 0 || dy > h) continue;
      const innerTop = parseFloat(f.inner.style.top) || 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, rect.width, rect.height);
      ctx.clip();
      ctx.drawImage(f.canvas, dx, dy + innerTop, f.cssW, f.pageCssH);
      ctx.restore();
    }
  }

  // ── Filter popup ───────────────────────────────────────────────────
  function attachFilterUI(filterBtn, host) {
    filterBtnRef = filterBtn;
    hostRef = host;
    filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popup) closePopup();
      else openPopup();
    });
  }

  function onDocPointerDown(e) {
    if (!popup) return;
    if (popup.contains(e.target) || filterBtnRef?.contains(e.target)) return;
    closePopup();
  }
  function onDocKeydown(e) {
    if (e.key === "Escape") closePopup();
  }

  function openPopup() {
    if (!hostRef || !filterBtnRef) return;
    ensureFilter();
    popup = document.createElement("div");
    popup.className = "pdf-fold-filter-popup";

    const title = document.createElement("div");
    title.className = "pdf-fold-filter-title";
    title.textContent = "Fold annotations";
    popup.appendChild(title);

    const combos = [...availableCombos().entries()].sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a[1].type);
      const tb = TYPE_ORDER.indexOf(b[1].type);
      if (ta !== tb) return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
      return a[1].color < b[1].color ? -1 : 1;
    });

    if (!combos.length) {
      const empty = document.createElement("div");
      empty.className = "pdf-fold-filter-empty";
      empty.textContent = "No annotations yet";
      popup.appendChild(empty);
    }

    for (const [key, c] of combos) {
      const row = document.createElement("label");
      row.className = "pdf-fold-filter-row";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = filter.has(key);
      check.addEventListener("change", () => {
        filterCustomized = true;
        if (check.checked) filter.add(key);
        else filter.delete(key);
        refresh(true);
      });
      row.appendChild(check);

      const swatch = document.createElement("span");
      swatch.className = "pdf-fold-filter-swatch";
      swatch.style.background = c.color || "#ffff00";
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.textContent = TYPE_LABELS[c.type] || c.type;
      row.appendChild(text);

      const count = document.createElement("span");
      count.className = "pdf-fold-filter-count";
      count.textContent = String(c.count);
      row.appendChild(count);

      popup.appendChild(row);
    }

    hostRef.appendChild(popup);
    // Anchor above the toolbar, aligned to the filter button, clamped
    // so a narrow pane / stack column can't clip the right edge.
    const btnRect = filterBtnRef.getBoundingClientRect();
    const hostRect = hostRef.getBoundingClientRect();
    let left = btnRect.left - hostRect.left - 8;
    left = Math.max(8, Math.min(left, hostRect.width - popup.offsetWidth - 8));
    popup.style.left = `${left}px`;

    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeydown, true);
  }

  function closePopup() {
    if (!popup) return;
    popup.remove();
    popup = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeydown, true);
  }

  function destroy() {
    disable();
  }

  return {
    enable,
    disable,
    refresh,
    onAnnotationsChanged,
    attachFilterUI,
    scrollToAnnotation,
    goToPage,
    getCurrentPage,
    drawSnapshot,
    destroy,
    isEnabled: () => enabled,
  };
}
