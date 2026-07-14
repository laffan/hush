/**
 * PDF toolbar DOM construction. Builds the bottom-bar element + all
 * the button / label children and returns them as a flat record so
 * the viewer factory can wire event handlers in one place.
 *
 * No state, no closures — pure DOM. Event handlers + dynamic state
 * (active classes, zoom label text) stay in pdf-viewer.js.
 */

import {
  VERTICAL_ICON, HORIZONTAL_ICON, THUMBNAIL_ICON,
  FIT_ONE_ICON, FIT_TWO_ICON, FIT_THREE_ICON,
  FOLD_ICON, FILTER_ICON,
} from "./pdf-viewer-icons.js";

/** Fill the toolbar's centered title/author slot (Zotero metadata). */
export function applyToolbarInfo(toolbarInfo, title, author) {
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

export function buildPdfToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-zoom-toolbar";

  const zoomOutBtn = btn("pdf-zoom-btn", "−", "Zoom out");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "pdf-zoom-label";
  zoomLabel.textContent = "Fit";
  const zoomInBtn = btn("pdf-zoom-btn", "+", "Zoom in");

  const scrollToggleWrap = document.createElement("span");
  scrollToggleWrap.className = "pdf-toggle-group";
  const scrollHBtn = svgBtn("pdf-toggle-option active", "Horizontal scroll", HORIZONTAL_ICON);
  const scrollVBtn = svgBtn("pdf-toggle-option", "Vertical scroll", VERTICAL_ICON);
  scrollToggleWrap.append(scrollHBtn, scrollVBtn);

  const fitToggleWrap = document.createElement("span");
  fitToggleWrap.className = "pdf-toggle-group";
  fitToggleWrap.style.display = "none";
  const fitOneBtn = svgBtn("pdf-toggle-option active", "Fit one page", FIT_ONE_ICON);
  const fitTwoBtn = svgBtn("pdf-toggle-option", "Fit two pages", FIT_TWO_ICON);
  const fitThreeBtn = svgBtn("pdf-toggle-option", "Fit three pages", FIT_THREE_ICON);
  fitToggleWrap.append(fitOneBtn, fitTwoBtn, fitThreeBtn);

  // Folded view: only shown while scrolling vertically at single-page
  // width (or while folded). Filter picks which annotations make folds.
  const foldBtn = svgBtn("pdf-zoom-btn pdf-fold-btn", "Folded view — collapse to annotated regions", FOLD_ICON);
  foldBtn.style.display = "none";
  const foldFilterBtn = svgBtn("pdf-zoom-btn pdf-fold-filter-btn", "Filter fold annotations", FILTER_ICON);
  foldFilterBtn.style.display = "none";

  const pageIndicator = document.createElement("span");
  pageIndicator.className = "pdf-page-indicator";

  const zoteroLink = document.createElement("a");
  zoteroLink.className = "pdf-zotero-link";
  zoteroLink.textContent = "Open in Zotero ↗";
  zoteroLink.style.display = "none";

  const thumbnailBtn = svgBtn("pdf-zoom-btn pdf-thumbnail-btn", "Thumbnail view", THUMBNAIL_ICON);

  const toolbarInfo = document.createElement("span");
  toolbarInfo.className = "pdf-toolbar-info";

  toolbar.append(
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollToggleWrap, fitToggleWrap,
    foldBtn, foldFilterBtn,
    thumbnailBtn, toolbarInfo, pageIndicator, zoteroLink,
  );

  return {
    toolbar,
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollHBtn, scrollVBtn,
    fitOneBtn, fitTwoBtn, fitThreeBtn, fitToggleWrap,
    foldBtn, foldFilterBtn,
    pageIndicator, zoteroLink, thumbnailBtn, toolbarInfo,
  };
}
