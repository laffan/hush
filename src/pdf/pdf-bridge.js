/**
 * PDF bridge — lifecycle management for the main-area PDF viewer.
 * Analogous to notebook/notebook-bridge.js but for PDF files.
 */

import { createPdfViewer } from "./pdf-viewer.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let currentViewer = null;
let currentFileId = null;
let panelObserver = null;

const _scrollState = new Map();

// Deep-link jump requested for the next mount of a given PDF (bookmark
// links). Handled inside mountPdf — replacing the saved-scroll restore —
// so the jump can't race it. See pdf-bookmarks.js#openPdfAtBookmark.
let _pendingJump = null;

export function requestPdfJump(fileId, page) {
  _pendingJump = { fileId, page };
}

export async function mountPdf(container, fileId, state) {
  if (currentViewer && currentFileId) {
    _scrollState.set(currentFileId, {
      top: currentViewer.getScrollTop(),
      left: currentViewer.getScrollLeft(),
      zoom: currentViewer.getZoom(),
    });
    await currentViewer.destroy();
    currentViewer = null;
    currentFileId = null;
  }

  container.innerHTML = "";

  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const node = findNodeByFileId(state.fileTree, fileId);
  const zoteroAttKey = node?.zoteroAttKey || null;

  const viewer = createPdfViewer(container, { mode: "main", zoteroAttKey, fileId });
  currentViewer = viewer;
  currentFileId = fileId;

  syncPdfInset(container);
  startPanelObserver(container);

  let bytes;
  if (IS_TAURI) {
    try {
      bytes = await tauriInvoke("load_pdf", { fileId });
    } catch (e) {
      console.error("Failed to load PDF:", e);
      container.innerHTML = `<div class="pdf-error">Failed to load PDF file.</div>`;
      return;
    }
  }

  if (!bytes) return;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await viewer.loadPdf(data);

  const jump = _pendingJump && _pendingJump.fileId === fileId ? _pendingJump : null;
  _pendingJump = null;
  const saved = _scrollState.get(fileId);
  if (saved?.zoom != null) viewer.setZoom(saved.zoom);
  if (jump) {
    // Bookmark deep link: land on the bookmarked page instead of the
    // saved scroll. Instant (a smooth scroll started this close to the
    // container unhiding gets cancelled by the settling layout) and
    // re-asserted once after the first renders land.
    requestAnimationFrame(() => {
      viewer.goToPage(jump.page, { instant: true });
      setTimeout(() => viewer.goToPage(jump.page, { instant: true }), 180);
    });
  } else if (saved) {
    requestAnimationFrame(() => {
      viewer.setScrollTop(saved.top || 0);
      viewer.setScrollLeft(saved.left || 0);
    });
  }

  try {
    const { getPdfMeta } = await import("../sync/pdf-sync.js");
    const meta = getPdfMeta(fileId);
    if (meta) {
      viewer.setToolbarInfo(meta.title, meta.firstAuthor);
    }
  } catch {}

  await loadAnnotationsIfZotero(viewer, fileId, state);
}

export async function unmountPdf() {
  stopPanelObserver();
  const fid = currentFileId;
  if (currentViewer && fid) {
    _scrollState.set(fid, {
      top: currentViewer.getScrollTop(),
      left: currentViewer.getScrollLeft(),
      zoom: currentViewer.getZoom(),
    });
    await currentViewer.destroy();
    currentViewer = null;
  }
  currentFileId = null;
  return fid;
}

export function getPdfInstance() {
  return currentViewer;
}

export async function refreshPdfAnnotations(state) {
  if (!currentViewer || !currentFileId) return;
  await loadAnnotationsIfZotero(currentViewer, currentFileId, state, true);
}

async function loadAnnotationsIfZotero(viewer, fileId, state, forceRefresh = false) {
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node?.zoteroAttKey) return;

  const userId = state.settings?.zoteroUserId;
  const apiKey = state.settings?.zoteroApiKey;
  if (!userId || !apiKey) return;

  try {
    const { getAnnotations } = await import("../zotero-annotations.js");
    const { annotations } = await getAnnotations(node.zoteroAttKey, userId, apiKey, { forceRefresh });
    viewer.setAnnotations(annotations);
  } catch (e) {
    console.error("Failed to load PDF annotations:", e);
  }
}

function syncPdfInset(container) {
  const po = document.getElementById("panel-overlay");
  if (!po) return;
  const isInset = po.classList.contains("panel-inset");
  if (!isInset) { container.style.left = "0"; return; }
  const panelOpen = !po.classList.contains("hidden");
  if (panelOpen) {
    const panelW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    container.style.left = panelW + "px";
  } else {
    const gripW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-grip-width"), 10) || 24;
    container.style.left = gripW + "px";
  }
}

function startPanelObserver(container) {
  stopPanelObserver();
  const po = document.getElementById("panel-overlay");
  if (!po) return;
  panelObserver = new MutationObserver(() => syncPdfInset(container));
  panelObserver.observe(po, { attributes: true, attributeFilter: ["class"] });
}

function stopPanelObserver() {
  if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
}
