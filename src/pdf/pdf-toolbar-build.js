/**
 * PDF toolbar DOM construction. Builds the bottom-bar element + all the
 * button / label children and returns them as a flat record so the
 * viewer factory can wire event handlers in one place; `syncToolbar`
 * lights the buttons for the modes in force.
 *
 * The bar is in sections, 14px apart, their controls tight within:
 * thumbnails; the outline, bookmarks and find; pages per screen (fit
 * one / two / three); scroll direction; paged / continuous; folding;
 * zoom (− and + as a group, the zoom or fit to their right) — then the
 * Zotero title and author, the page indicator and Open in Zotero.
 *
 * A button that stands for a keyboard shortcut names it in
 * `data-shortcut` (a settings key, or a fixed combo such as "Mod+="),
 * which its tooltip shows after its text (pdf-viewer-tooltips.js).
 */

import {
  VERTICAL_ICON, HORIZONTAL_ICON, THUMBNAIL_ICON,
  FIT_ONE_ICON, FIT_TWO_ICON, FIT_THREE_ICON,
  FOLD_ICON, FILTER_ICON, PAGED_ICON, CONTINUOUS_ICON, OUTLINE_ICON, SEARCH_ICON,
} from "./pdf-viewer-icons.js";

/** Fill the toolbar's centered title/author slot (Zotero metadata). */
export function applyToolbarInfo(toolbarInfo, title, author) {
  if (!title) { toolbarInfo.textContent = ""; toolbarInfo.style.visibility = "hidden"; return; }
  toolbarInfo.style.visibility = "";
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
}

/** Show the bar's Open in Zotero for an attachment key (none: hidden). */
export function showZoteroLink(link, attKey) {
  link.href = attKey ? `zotero://open-pdf/library/items/${attKey}` : "";
  link.style.display = attKey ? "" : "none";
}

/** Open in Zotero opens the PDF there at the page in view. */
export function wireZoteroLink(link, getAttKey, getPage) {
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    const attKey = getAttKey();
    if (!attKey) return;
    const url = `zotero://open-pdf/library/items/${attKey}?page=${getPage()}`;
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  });
}

function btn(cls, text, title, shortcut) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.title = title;
  if (shortcut) b.dataset.shortcut = shortcut;
  return b;
}

function svgBtn(cls, title, svgContent, shortcut) {
  const b = btn(cls, "", title, shortcut);
  b.innerHTML = svgContent;
  return b;
}

function group(cls, ...children) {
  const g = document.createElement("span");
  g.className = cls;
  g.append(...children);
  return g;
}

export function buildPdfToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-zoom-toolbar";

  const thumbnailBtn = svgBtn("pdf-zoom-btn pdf-thumbnail-btn", "Thumbnail view", THUMBNAIL_ICON, "shortcutPdfThumbnails");

  // The outline shows only when the PDF has one; the bookmarks button
  // (pdf-bookmarks.js) joins this section from the viewer.
  const outlineBtn = svgBtn("pdf-zoom-btn pdf-outline-btn", "Outline", OUTLINE_ICON, "shortcutPdfOutline");
  outlineBtn.style.display = "none";
  const findBtn = svgBtn("pdf-zoom-btn pdf-find-btn", "Find in this PDF", SEARCH_ICON, "shortcutQuickFind");
  const navWrap = group("pdf-toolbar-section pdf-nav-section", outlineBtn, findBtn);

  const fitOneBtn = svgBtn("pdf-toggle-option active", "Fit one page", FIT_ONE_ICON, "shortcutPdfFit1");
  const fitTwoBtn = svgBtn("pdf-toggle-option", "Fit two pages", FIT_TWO_ICON, "shortcutPdfFit2");
  const fitThreeBtn = svgBtn("pdf-toggle-option", "Fit three pages", FIT_THREE_ICON, "shortcutPdfFit3");
  const fitToggleWrap = group("pdf-toggle-group", fitOneBtn, fitTwoBtn, fitThreeBtn);
  fitToggleWrap.style.display = "none";

  const scrollHBtn = svgBtn("pdf-toggle-option active", "Horizontal scroll", HORIZONTAL_ICON, "shortcutPdfHorizontal");
  const scrollVBtn = svgBtn("pdf-toggle-option", "Vertical scroll", VERTICAL_ICON, "shortcutPdfVertical");
  const scrollToggleWrap = group("pdf-toggle-group", scrollHBtn, scrollVBtn);

  // Paged: a set of pages at a time (as many as the fit buttons say), swiped
  // through, or the pages as one strip.
  const pagedBtn = svgBtn("pdf-toggle-option", "Paged — one, two or three pages at a time; swipe to turn", PAGED_ICON, "shortcutPdfPaged");
  const continuousBtn = svgBtn("pdf-toggle-option active", "Continuous — the pages as one strip", CONTINUOUS_ICON, "shortcutPdfContinuous");
  const pageModeWrap = group("pdf-toggle-group pdf-page-mode", pagedBtn, continuousBtn);

  // Folded view: always available — entering it switches the viewer to
  // vertical scroll at single-page width. The filter button only shows
  // while folded; it picks which annotations make folds.
  const foldBtn = svgBtn("pdf-zoom-btn pdf-fold-btn", "Folded view — collapse to annotated regions", FOLD_ICON, "shortcutPdfFolded");
  const foldFilterBtn = svgBtn("pdf-zoom-btn pdf-fold-filter-btn", "Filter fold annotations", FILTER_ICON, "shortcutPdfFoldFilters");
  foldFilterBtn.style.display = "none";
  const foldWrap = group("pdf-toolbar-section", foldBtn, foldFilterBtn);

  // − and + as one group, the zoom (or fit) they set to their right.
  const zoomOutBtn = btn("pdf-toggle-option pdf-zoom-step", "−", "Zoom out", "Mod+-");
  const zoomInBtn = btn("pdf-toggle-option pdf-zoom-step", "+", "Zoom in", "Mod+=");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom-label";
  zoomLabel.textContent = "Fit";
  const zoomWrap = group("pdf-toolbar-section", group("pdf-toggle-group", zoomOutBtn, zoomInBtn), zoomLabel);

  const toolbarInfo = document.createElement("span");
  toolbarInfo.className = "pdf-toolbar-info";
  toolbarInfo.style.visibility = "hidden";

  const pageIndicator = document.createElement("span");
  pageIndicator.className = "pdf-page-indicator";

  const zoteroLink = document.createElement("a");
  zoteroLink.className = "pdf-zotero-link";
  zoteroLink.textContent = "Open in Zotero ↗";
  zoteroLink.style.display = "none";

  toolbar.append(
    thumbnailBtn, navWrap,
    fitToggleWrap, scrollToggleWrap, pageModeWrap, foldWrap,
    zoomWrap,
    toolbarInfo, pageIndicator, zoteroLink,
  );

  return {
    toolbar,
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollHBtn, scrollVBtn,
    fitOneBtn, fitTwoBtn, fitThreeBtn, fitToggleWrap,
    pageModeWrap, pagedBtn, continuousBtn,
    foldBtn, foldFilterBtn,
    navWrap, outlineBtn, findBtn,
    pageIndicator, zoteroLink, thumbnailBtn, toolbarInfo,
  };
}

/**
 * Light the buttons for the modes in force, label the zoom, and show
 * only the controls that apply.
 * @param {object} s  { layoutMode, fitMode, folded, paged, foldedZoom, zoom: () => number }
 */
export function syncToolbar(tb, s) {
  const isVert = s.layoutMode === "vertical";
  if (s.folded) {
    tb.zoomLabel.textContent = Math.abs(s.foldedZoom - 1) < 0.01 ? "Folded" : `Folded ${Math.round(s.foldedZoom * 100)}%`;
  } else if (s.layoutMode !== "fixed") {
    const labels = { fit: "Fit", "fit-2": "Fit 2", "fit-3": "Fit 3" };
    tb.zoomLabel.textContent = (isVert || s.paged ? labels[s.fitMode] : "Fit") || "Fit";
  } else {
    tb.zoomLabel.textContent = `${Math.round(s.zoom() * 100)}%`;
  }
  tb.scrollHBtn.classList.toggle("active", s.layoutMode === "horizontal");
  tb.scrollVBtn.classList.toggle("active", isVert);
  // The fit buttons apply top to bottom, and to the paged view's sets.
  tb.fitToggleWrap.style.display = isVert || s.paged ? "" : "none";
  tb.pageModeWrap.classList.toggle("vertical", s.layoutMode !== "horizontal");
  tb.pagedBtn.classList.toggle("active", s.paged);
  tb.continuousBtn.classList.toggle("active", !s.folded && !s.paged);
  tb.fitOneBtn.classList.toggle("active", s.fitMode === "fit" && !s.folded);
  tb.fitTwoBtn.classList.toggle("active", s.fitMode === "fit-2");
  tb.fitThreeBtn.classList.toggle("active", s.fitMode === "fit-3");
  tb.foldBtn.classList.toggle("active", s.folded);
  tb.foldFilterBtn.style.display = s.folded ? "" : "none";
}
