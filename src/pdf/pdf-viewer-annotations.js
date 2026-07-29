/**
 * Annotation shelf + overlay rendering for the PDF viewer.
 *
 * Extracted from pdf-viewer.js to keep each module under 700 lines.
 * All DOM structure, CSS classes, and visual behaviour are identical
 * to the original inline implementation.
 *
 * @param {HTMLElement} scrollArea  The scroll container for PDF pages
 * @param {HTMLElement} body        The .pdf-viewer-body element (shelf is appended here)
 * @param {object}      viewer      Live reference to viewer state / helpers
 * @param {function}    viewer.getPages          () => pages[]
 * @param {function}    viewer.getEffectiveZoom  () => number
 * @param {function}    viewer.getLayoutMode     () => string
 * @param {function}    viewer.goToPage          (n: number) => void
 * @param {function}    [viewer.scrollToFold]    (annot) => boolean — folded-view delegate
 */

/** Parse (and cache) the Zotero annotationPosition payload. Shared with
 *  the folded view (pdf-viewer-folds.js). */
export function parseAnnotationPosition(annot) {
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

/** Convert a PDF user-space point into top-left-origin page units for
 *  the given (scale-1) viewport. Zotero stores annotation positions in
 *  raw PDF user space; pdfjs renders the page's *CropBox*, whose origin
 *  isn't always (0,0). Mapping through the viewport's own transform
 *  honours that origin (and any page /Rotate) — a plain
 *  `y → pageHeight − y` flip paints every annotation offset by the crop
 *  origin on such documents: right relative to each other, wrong
 *  against the page. */
export function pdfPointToViewport(viewport, x, y) {
  if (typeof viewport?.convertToViewportPoint === "function") {
    return viewport.convertToViewportPoint(x, y);
  }
  return [x, viewport.height - y]; // fallback: unrotated, origin (0,0)
}

/** Paint a list of annotations into an overlay layer sized to a page.
 *  Shared between the page overlays and the folded view. */
export function paintAnnotationsInto(layer, pageAnnots, viewport, scaleX, scaleY) {
  for (const annot of pageAnnots) {
    const pos = parseAnnotationPosition(annot);
    if (!pos) continue;

    if (annot.type === "ink" && pos.paths?.length) {
      paintInkAnnotation(layer, annot, pos, scaleX, scaleY, viewport);
    } else if (pos.rects?.length) {
      for (const rect of pos.rects) {
        const [x1, y1, x2, y2] = rect;
        const [ax, ay] = pdfPointToViewport(viewport, x1, y1);
        const [bx, by] = pdfPointToViewport(viewport, x2, y2);
        const div = document.createElement("div");
        div.className = "pdf-annot-highlight";
        div.style.left = `${Math.min(ax, bx) * scaleX}px`;
        div.style.top = `${Math.min(ay, by) * scaleY}px`;
        div.style.width = `${Math.abs(bx - ax) * scaleX}px`;
        div.style.height = `${Math.abs(by - ay) * scaleY}px`;
        div.style.backgroundColor = annot.color || "#ffff00";
        if (annot.comment) div.title = annot.comment;
        layer.appendChild(div);
      }
    }
  }
}

function paintInkAnnotation(layer, annot, pos, scaleX, scaleY, viewport) {
  const w = Math.round(viewport.width * scaleX);
  const h = Math.round(viewport.height * scaleY);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("pdf-annot-ink");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  for (const pathPoints of pos.paths) {
    if (!pathPoints || pathPoints.length < 2) continue;
    let d = "";
    for (let i = 0; i < pathPoints.length; i += 2) {
      const [vx, vy] = pdfPointToViewport(viewport, pathPoints[i], pathPoints[i + 1]);
      const x = vx * scaleX;
      const y = vy * scaleY;
      d += (i === 0 ? "M" : "L") + `${x},${y} `;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", annot.color || "#ff0000");
    path.setAttribute("stroke-width", String(Math.max(0.5, scaleX)));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  layer.appendChild(svg);
}

export function createAnnotationLayer(scrollArea, body, viewer) {
  let annotations = [];
  let shelfOpen = false;
  let shelfFilter = "";

  // ── Shelf DOM ─────────────────────────────────────────────────────
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

  // ── Shelf interactions ────────────────────────────────────────────
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

  // ── Shelf helpers ─────────────────────────────────────────────────
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
    // Folded view owns navigation while active — it scrolls to the
    // fold containing the annotation.
    if (viewer.scrollToFold && viewer.scrollToFold(annot)) return;
    const pages = viewer.getPages();
    const pos = parseAnnotationPosition(annot);
    if (!pos) {
      const pageNum = parseInt(annot.pageLabel, 10);
      if (!isNaN(pageNum)) viewer.goToPage(pageNum);
      return;
    }
    const pageIdx = pos.pageIndex;
    if (pageIdx < 0 || pageIdx >= pages.length) return;
    const p = pages[pageIdx];
    if (!p?.wrapper) return;

    const scale = viewer.getEffectiveZoom();
    const firstRect = pos.rects?.[0];
    if (!firstRect) {
      p.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Top-left corner of the annotation in top-origin page units —
    // through the viewport transform so crop-box origins don't skew it.
    const [vx, vy] = pdfPointToViewport(p.viewport, firstRect[0], firstRect[3]);

    if (viewer.getLayoutMode() === "horizontal") {
      const targetLeft = p.wrapper.offsetLeft + vx * scale - scrollArea.clientWidth / 3;
      scrollArea.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
    } else {
      const targetTop = p.wrapper.offsetTop + vy * scale - scrollArea.clientHeight / 3;
      scrollArea.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }

  // ── Annotation rendering on pages ─────────────────────────────────
  function setAnnotations(annots) {
    const pages = viewer.getPages();
    annotations = annots || [];
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
    shelf.classList.toggle("has-annotations", annotations.length > 0);
    if (shelfOpen) rebuildShelfList();
  }

  function refreshAnnotations() {
    const pages = viewer.getPages();
    for (let i = 0; i < pages.length; i++) {
      const layer = pages[i].wrapper?.querySelector(".pdf-annot-layer");
      if (layer) layer.remove();
      if (pages[i].rendered) paintAnnotationsOnPage(i);
    }
    if (shelfOpen) rebuildShelfList();
  }

  function paintAnnotationsOnPage(pageIdx) {
    const pages = viewer.getPages();
    const p = pages[pageIdx];
    if (!p?.rendered || !p.canvas) return;
    // The overlay joins the page's content box so it stretches with the
    // raster during a drag-resize; geometry uses the paint-time content
    // size (offset* ignores the stretch transform), not the live
    // wrapper size, so a mid-resize paint can't skew it.
    const host = p.contentEl || p.wrapper;
    let layer = host.querySelector(".pdf-annot-layer");
    if (layer) layer.remove();
    layer = document.createElement("div");
    layer.className = "pdf-annot-layer";
    const pageAnnots = annotations.filter(a => {
      const pos = parseAnnotationPosition(a);
      return pos && pos.pageIndex === pageIdx;
    });
    if (!pageAnnots.length) return;
    const scaleX = host.offsetWidth / p.viewport.width;
    const scaleY = host.offsetHeight / p.viewport.height;
    paintAnnotationsInto(layer, pageAnnots, p.viewport, scaleX, scaleY);
    if (layer.children.length) host.appendChild(layer);
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    shelf,
    toggleShelf,
    setAnnotations,
    refreshAnnotations,
    paintAnnotationsOnPage,
    /** Provide current annotations for suspend/resume snapshots */
    getAnnotations() { return annotations; },
  };
}
