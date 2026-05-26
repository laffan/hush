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

export async function mountPdf(container, fileId, state) {
  if (currentViewer) {
    await currentViewer.destroy();
    currentViewer = null;
    currentFileId = null;
  }

  container.innerHTML = "";
  const viewer = createPdfViewer(container, { mode: "main" });
  currentViewer = viewer;
  currentFileId = fileId;

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

  await loadAnnotationsIfZotero(viewer, fileId, state);
}

export async function unmountPdf() {
  const fid = currentFileId;
  if (currentViewer) {
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
