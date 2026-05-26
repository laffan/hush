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
 */
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

    const [, y1, , y2] = firstRect;
    const pageH = p.viewport.height;
    const topInPage = (pageH - y2) * scale;

    if (viewer.getLayoutMode() === "horizontal") {
      const targetLeft = p.wrapper.offsetLeft + firstRect[0] * scale - scrollArea.clientWidth / 3;
      scrollArea.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
    } else {
      const targetTop = p.wrapper.offsetTop + topInPage - scrollArea.clientHeight / 3;
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
    let layer = p.wrapper.querySelector(".pdf-annot-layer");
    if (layer) layer.remove();
    layer = document.createElement("div");
    layer.className = "pdf-annot-layer";
    const pageAnnots = annotations.filter(a => {
      const pos = parseAnnotationPosition(a);
      return pos && pos.pageIndex === pageIdx;
    });
    if (!pageAnnots.length) return;
    const scale = viewer.getEffectiveZoom();
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
