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

  const zoteroAttKey = await resolveAttKey(fileId, state);

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
  void loadNotes(viewer, fileId, state);
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
  void loadNotes(currentViewer, currentFileId, state);
}

/** The NOTES.md beside the PDF in its Zotero entry, as the shelf's Notes
 *  tab (zotero/zotero-notes.js). */
async function loadNotes(viewer, fileId, state) {
  try {
    const { showPdfNotes } = await import("../zotero/zotero-notes.js");
    await showPdfNotes(viewer, fileId, await resolveAttKey(fileId, state), state.settings,
      () => currentViewer === viewer);
  } catch (e) {
    console.warn("Failed to load the PDF's notes:", e);
  }
}

/** The Zotero attachment's annotations, plus any extracted from the file
 *  itself (Extract Annotations, on the shelf) — either half may be all
 *  there is. */
async function loadAnnotationsIfZotero(viewer, fileId, state, forceRefresh = false) {
  const attKey = await resolveAttKey(fileId, state);

  try {
    const { loadPdfAnnotationList } = await import("../zotero-annotations.js");
    const annotations = await loadPdfAnnotationList(fileId, attKey, state.settings, { forceRefresh });
    if (!annotations.length && !attKey) return;
    viewer.setAnnotations(annotations);
    // Keep the shelf cover's baked-in annotation marks current with
    // what the viewer just loaded (first fetch or explicit refresh).
    try {
      const { refreshPdfCoverIfStale } = await import("./pdf-covers.js");
      const res = await refreshPdfCoverIfStale(fileId);
      if (res.changed) state.emit("pdf-cover-ready", fileId);
    } catch { /* cover refresh is best-effort */ }
  } catch (e) {
    console.error("Failed to load PDF annotations:", e);
  }
}

/** The PDF's Zotero attachment key — the tree node's, else the PDF
 *  registry's (pdf-sync.js#zoteroAttKeyFor). */
async function resolveAttKey(fileId, state) {
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const { zoteroAttKeyFor } = await import("../sync/pdf-sync.js");
  return zoteroAttKeyFor(fileId, findNodeByFileId(state.fileTree, fileId));
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
