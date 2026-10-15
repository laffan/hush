/**
 * The annotation shelf for the PDF viewer, and scrolling to an
 * annotation. The annotations themselves are painted into the page
 * rasters (pdf-annot-raster.js, through the renderer's `paintPage`), the
 * folded view's strips and the thumbnails — one painter for all of them.
 *
 * @param {HTMLElement} scrollArea  The scroll container for PDF pages
 * @param {HTMLElement} body        The .pdf-viewer-body element (shelf is appended here)
 * @param {object}      viewer      Live reference to viewer state / helpers
 * @param {function}    viewer.getPages          () => pages[]
 * @param {function}    viewer.getEffectiveZoom  () => number
 * @param {function}    viewer.getLayoutMode     () => string
 * @param {function}    viewer.goToPage          (n: number) => void
 * @param {function}    [viewer.scrollToFold]    (annot) => boolean — folded-view delegate
 * @param {function}    [viewer.isPaged]         () => boolean — paged sets: the page is the place
 * @param {function}    [viewer.getPdfDoc]       () => PDFDocumentProxy — shows Extract Annotations
 * @param {function}    [viewer.extractAnnotations] () => Promise<number> — reads the file's own
 *                                                annotations into the list; resolves to how many
 */

import { attachNotesTab } from "./pdf-viewer-notes.js";

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

/** Extract Annotations: read the annotations written into the file,
 *  cache them per fileId, and fold them into `current` beside whatever
 *  Zotero's API supplied (an earlier extraction's entries are replaced,
 *  not doubled). Resolves to `{ list, count }`. */
export async function extractEmbedded(pdfDoc, attKey, fileId, current) {
  const { extractPdfAnnotations } = await import("./pdf-annotation-extract.js");
  const z = await import("../zotero-annotations.js");
  const raw = await extractPdfAnnotations(pdfDoc, { parentKey: attKey || "" });
  if (fileId) await z.saveExtractedAnnotations(fileId, raw);
  const fromApi = current
    .filter((a) => !a._raw?.data?.hushEmbedded)
    .map((a) => ({ ...a, embedded: false }));
  return { list: z.mergeAnnotationLists(fromApi, z.normalizeAnnotations(raw)), count: raw.length };
}

// Shelf width — dragged by its left edge, persisted app-wide as
// `pdfAnnotShelfWidth` (read through `window.__hushState__`, as the
// notebook shelf does, since the viewer is built without the app state).
const SHELF_WIDTH_DEFAULT = 280;
const SHELF_WIDTH_MIN = 200;
const SHELF_WIDTH_MAX_FRAC = 0.6;

function storedShelfWidth() {
  const w = Number(window.__hushState__?.settings?.pdfAnnotShelfWidth);
  return Number.isFinite(w) && w > 0 ? w : SHELF_WIDTH_DEFAULT;
}

export function createAnnotationLayer(scrollArea, body, viewer) {
  let annotations = [];
  let shelfOpen = false;
  let shelfFilter = "";
  let activeColor = null; // null = every colour

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
  const shelfTitle = document.createElement("span");
  shelfTitle.textContent = "Annotations";
  shelfHeader.appendChild(shelfTitle);
  // Read the annotations written into the file itself — the way in for
  // a PDF imported from disk or the clipboard, whose annotations Zotero's
  // API never handed over (pdf-annotation-extract.js).
  const extractBtn = document.createElement("button");
  extractBtn.type = "button";
  extractBtn.className = "pdf-annot-shelf-extract";
  extractBtn.textContent = "Extract Annotations";
  extractBtn.title = "Read the annotations saved in this PDF file";
  if (!viewer.getPdfDoc) extractBtn.style.display = "none";
  shelfHeader.appendChild(extractBtn);
  shelfContent.appendChild(shelfHeader);

  const shelfSearch = document.createElement("input");
  shelfSearch.type = "text";
  shelfSearch.className = "pdf-annot-shelf-search";
  shelfSearch.placeholder = "Filter...";
  shelfContent.appendChild(shelfSearch);

  // Colour filter — one swatch per highlight colour in the list, plus
  // "all", the highlight browser's column laid on its side.
  const shelfColors = document.createElement("div");
  shelfColors.className = "pdf-annot-shelf-colors";
  shelfContent.appendChild(shelfColors);

  const shelfBody = document.createElement("div");
  shelfBody.className = "pdf-annot-shelf-body";
  shelfContent.appendChild(shelfBody);

  shelf.appendChild(shelfContent);

  // The Notes tab beside Annotations, once the PDF's Zotero entry turns
  // out to hold a NOTES.md (pdf-viewer-notes.js).
  const notesTab = attachNotesTab({
    content: shelfContent,
    title: shelfTitle,
    annotationColor: (key) => annotations.find((a) => a.key === key)?.color || undefined,
    // A page link into this PDF moves the viewer — to its highlight when
    // it names one — rather than leaving for Zotero.
    followPdfLink: (link) => {
      if (!link.attKey || link.attKey !== viewer.getZoteroAttKey?.()) return false;
      const annot = link.annotation && annotations.find((a) => a.key === link.annotation);
      if (annot) scrollToAnnotation(annot);
      else if (link.page) viewer.goToPage(link.page);
      else return false;
      return true;
    },
  });

  // Left-edge resize strip, live only while the shelf is open (CSS).
  const shelfResize = document.createElement("div");
  shelfResize.className = "pdf-annot-shelf-resize";
  shelf.appendChild(shelfResize);
  body.appendChild(shelf);

  const clampWidth = (w) => Math.max(SHELF_WIDTH_MIN,
    Math.min(Math.max(SHELF_WIDTH_MIN, (body.clientWidth || window.innerWidth) * SHELF_WIDTH_MAX_FRAC), w));
  shelf.style.setProperty("--pdf-annot-shelf-width", clampWidth(storedShelfWidth()) + "px");

  shelfResize.addEventListener("pointerdown", (e) => {
    if (!shelfOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = shelf.getBoundingClientRect().width;
    let width = startW;
    shelf.classList.add("resizing");
    try { shelfResize.setPointerCapture(e.pointerId); } catch (_) {}
    const onMove = (me) => {
      // Right-anchored: a leftward drag widens it.
      width = clampWidth(startW - (me.clientX - startX));
      shelf.style.setProperty("--pdf-annot-shelf-width", width + "px");
    };
    const onUp = () => {
      shelf.classList.remove("resizing");
      shelfResize.removeEventListener("pointermove", onMove);
      shelfResize.removeEventListener("pointerup", onUp);
      shelfResize.removeEventListener("pointercancel", onUp);
      window.__hushState__?.updateSettings?.({ pdfAnnotShelfWidth: Math.round(width) });
    };
    shelfResize.addEventListener("pointermove", onMove);
    shelfResize.addEventListener("pointerup", onUp);
    shelfResize.addEventListener("pointercancel", onUp);
  });

  // ── Shelf interactions ────────────────────────────────────────────
  function toggleShelf() {
    shelfOpen = !shelfOpen;
    shelf.classList.toggle("open", shelfOpen);
    shelfGrip.textContent = shelfOpen ? "›" : "‹";
    if (shelfOpen) {
      // Another viewer may have been resized since this one was built.
      shelf.style.setProperty("--pdf-annot-shelf-width", clampWidth(storedShelfWidth()) + "px");
      rebuildShelfList();
    }
  }

  extractBtn.addEventListener("click", async () => {
    if (extractBtn.disabled) return;
    extractBtn.disabled = true;
    const label = extractBtn.textContent;
    extractBtn.textContent = "Extracting\u2026";
    try {
      const n = await viewer.extractAnnotations();
      showShelfNote(n
        ? `Found ${n} annotation${n === 1 ? "" : "s"} in this PDF`
        : "This PDF has no annotations saved in it");
    } catch (e) {
      console.error("Extract annotations failed:", e);
      showShelfNote(`Couldn't read annotations: ${e?.message || e}`);
    } finally {
      extractBtn.disabled = false;
      extractBtn.textContent = label;
    }
  });

  let noteTimer = null;
  function showShelfNote(text) {
    let note = shelfContent.querySelector(".pdf-annot-shelf-note");
    if (!note) {
      note = document.createElement("div");
      note.className = "pdf-annot-shelf-note";
      shelfContent.insertBefore(note, shelfSearch);
    }
    note.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.remove(), 4000);
  }

  function paintColorFilter() {
    shelfColors.innerHTML = "";
    const colors = [];
    for (const a of annotations) if (a.color && !colors.includes(a.color)) colors.push(a.color);
    if (activeColor && !colors.includes(activeColor)) activeColor = null;
    shelfColors.style.display = colors.length > 1 ? "" : "none";
    const swatch = (color) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pdf-annot-swatch" + (color ? "" : " pdf-annot-swatch-all")
        + (activeColor === color ? " active" : "");
      if (color) b.style.backgroundColor = color;
      b.title = color ? "Only this colour" : "All colours";
      b.addEventListener("click", () => {
        activeColor = color && activeColor !== color ? color : null;
        paintColorFilter();
        rebuildShelfList();
      });
      return b;
    };
    shelfColors.appendChild(swatch(null));
    for (const c of colors) shelfColors.appendChild(swatch(c));
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
    const filtered = annotations.filter(a => {
      if (activeColor && a.color !== activeColor) return false;
      if (!shelfFilter) return true;
      const text = (a.text || "").toLowerCase();
      const comment = (a.comment || "").toLowerCase();
      return text.includes(shelfFilter) || comment.includes(shelfFilter);
    });

    if (!filtered.length) {
      shelfBody.innerHTML = '<div class="pdf-annot-shelf-empty">No matches</div>';
      return;
    }
    for (const annot of filtered) {
      // A drawing or an image area has no words; it is listed by kind so
      // it can still be found and jumped to.
      const bare = !annot.text && !annot.comment;
      if (bare && annot.type !== "ink" && annot.type !== "image") continue;
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
      if (bare) {
        const kindEl = document.createElement("div");
        kindEl.className = "pdf-annot-shelf-comment";
        kindEl.textContent = annot.type === "ink" ? "Drawing" : "Image";
        row.appendChild(kindEl);
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
    // No position, or the paged view (a set is the place, not a point
    // on it): go to the page.
    if (!pos || viewer.isPaged?.()) {
      const n = pos ? pos.pageIndex + 1 : parseInt(annot.pageLabel, 10);
      if (!isNaN(n)) viewer.goToPage(n);
      return;
    }
    const p = pages[pos.pageIndex];
    if (!p?.wrapper) return;
    const scale = viewer.getEffectiveZoom();
    // Top-left of the first rect, or the first point of a drawing —
    // through the viewport transform so crop-box origins don't skew it.
    const rect = pos.rects?.[0];
    const path = pos.paths?.[0];
    const anchor = rect ? [rect[0], rect[3]] : path && path.length >= 2 ? [path[0], path[1]] : null;
    if (!anchor) {
      p.wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const [vx, vy] = pdfPointToViewport(p.viewport, anchor[0], anchor[1]);
    if (viewer.getLayoutMode() === "horizontal") {
      const targetLeft = p.wrapper.offsetLeft + vx * scale - scrollArea.clientWidth / 3;
      scrollArea.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
    } else {
      const targetTop = p.wrapper.offsetTop + vy * scale - scrollArea.clientHeight / 3;
      scrollArea.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }

  // ── The list ─────────────────────────────────────────────────────
  function setAnnotations(annots) {
    annotations = annots || [];
    shelf.classList.toggle("has-annotations", annotations.length > 0);
    paintColorFilter();
    if (shelfOpen) rebuildShelfList();
    notesTab.refresh();
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    shelf,
    toggleShelf,
    setAnnotations,
    /** Rebuild the list (the rasters are the renderer's to repaint). */
    refreshList: () => { if (shelfOpen) rebuildShelfList(); },
    scrollToAnnotation,
    isShelfOpen: () => shelfOpen,
    getAnnotations() { return annotations; },
    setNotes: notesTab.setNotes,
  };
}
