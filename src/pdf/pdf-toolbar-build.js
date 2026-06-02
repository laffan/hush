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
} from "./pdf-viewer-icons.js";

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
    thumbnailBtn, toolbarInfo, pageIndicator, zoteroLink,
  );

  return {
    toolbar,
    zoomOutBtn, zoomLabel, zoomInBtn,
    scrollHBtn, scrollVBtn,
    fitOneBtn, fitTwoBtn, fitThreeBtn, fitToggleWrap,
    pageIndicator, zoteroLink, thumbnailBtn, toolbarInfo,
  };
}
