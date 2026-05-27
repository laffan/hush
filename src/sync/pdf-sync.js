/**
 * PDF registry — manages `.hush/pdf.json`, the cross-device manifest of
 * PDF files in the workspace. Actual PDF binary data is NOT synced via
 * Dropbox; only this JSON file travels. When a remote device adds an
 * entry the local device sees it arrive via the cursor consumer and
 * automatically downloads the PDF from Zotero in the background.
 *
 * Schema (pdf.json):
 * {
 *   "format": "hush-pdfs",
 *   "version": 1,
 *   "items": {
 *     "<fileId>": {
 *       "fileId": "...",
 *       "title": "...",
 *       "authors": "LastName, F; ...",
 *       "firstAuthor": "LastName",
 *       "year": "2024",
 *       "citekey": "smith2024",
 *       "zoteroItemKey": "ABC123",
 *       "zoteroAttKey": "XYZ789",
 *       "addedAt": 1716825600
 *     }
 *   }
 * }
 */

import { enqueueMetaUpload } from "./meta-sync.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let _registry = null;
let _state = null;
let _persistTimer = null;
const _downloadProgress = new Map();

export function getPdfRegistry() {
  return _registry?.items || {};
}

export function getPdfMeta(fileId) {
  return _registry?.items?.[fileId] || null;
}

export function getPdfDownloadProgress(fileId) {
  return _downloadProgress.get(fileId) ?? null;
}

export function isPdfDownloaded(fileId) {
  if (!IS_TAURI) return true;
  return _downloadedSet.has(fileId);
}

const _downloadedSet = new Set();

export async function checkPdfExists(fileId) {
  if (!IS_TAURI) return false;
  try {
    const exists = await tauriInvoke("pdf_exists", { fileId });
    if (exists) _downloadedSet.add(fileId);
    else _downloadedSet.delete(fileId);
    return exists;
  } catch { return false; }
}

export async function initPdfRegistry(state) {
  _state = state;
  if (IS_TAURI) {
    try {
      const json = await tauriInvoke("load_pdf_registry");
      if (json) {
        _registry = JSON.parse(json);
      }
    } catch { /* first run — file doesn't exist yet */ }
  }
  if (!_registry || !_registry.items) {
    _registry = { format: "hush-pdfs", version: 1, items: {} };
  }
  for (const fileId of Object.keys(_registry.items)) {
    await checkPdfExists(fileId);
  }
}

export async function addPdfEntry(fileId, meta) {
  if (!_registry) _registry = { format: "hush-pdfs", version: 1, items: {} };
  _registry.items[fileId] = {
    fileId,
    title: meta.title || "Untitled",
    authors: meta.authors || "",
    firstAuthor: meta.firstAuthor || "",
    year: meta.year || "",
    citekey: meta.citekey || "",
    zoteroItemKey: meta.zoteroItemKey || "",
    zoteroAttKey: meta.zoteroAttKey || "",
    addedAt: Math.floor(Date.now() / 1000),
  };
  await persistRegistry();
}

export async function removePdfEntry(fileId) {
  if (!_registry?.items?.[fileId]) return;
  delete _registry.items[fileId];
  _downloadedSet.delete(fileId);
  _downloadProgress.delete(fileId);
  if (IS_TAURI) {
    try { await tauriInvoke("delete_pdf", { fileId }); } catch {}
  }
  await persistRegistry();
}

async function persistRegistry() {
  if (!_registry) return;
  const payload = JSON.stringify(_registry, null, 2);
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_pdf_registry", { content: payload });
    } catch (e) { console.error("Failed to save pdf.json:", e); }
  }
  scheduleSyncUpload();
}

function scheduleSyncUpload() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    if (!_registry) return;
    const payload = JSON.stringify(_registry, null, 2);
    await enqueueMetaUpload("pdf.json", payload);
  }, 500);
}

export async function applyPdfFile(state, payload) {
  if (!payload) return;
  let remote;
  try { remote = JSON.parse(payload); } catch { return; }
  if (!remote?.items) return;

  _state = state;
  if (!_registry) _registry = { format: "hush-pdfs", version: 1, items: {} };

  const localIds = new Set(Object.keys(_registry.items));
  const remoteIds = new Set(Object.keys(remote.items));

  for (const fileId of remoteIds) {
    if (!localIds.has(fileId)) {
      _registry.items[fileId] = remote.items[fileId];
      await ensurePdfTreeNode(state, fileId);
      triggerBackgroundDownload(fileId, state);
    }
  }

  for (const fileId of localIds) {
    if (!remoteIds.has(fileId)) {
      delete _registry.items[fileId];
      _downloadedSet.delete(fileId);
      _downloadProgress.delete(fileId);
      if (IS_TAURI) {
        try { await tauriInvoke("delete_pdf", { fileId }); } catch {}
      }
      await removePdfTreeNode(state, fileId);
    }
  }

  if (IS_TAURI) {
    try {
      const p = JSON.stringify(_registry, null, 2);
      await tauriInvoke("save_pdf_registry", { content: p });
    } catch {}
  }
  state.emit("files-changed");
}

async function ensurePdfTreeNode(state, fileId) {
  const { findNodeByFileId, findNode } = await import("../state/tree-helpers.js");
  if (findNodeByFileId(state.fileTree, fileId)) return;

  const meta = _registry.items[fileId];
  if (!meta) return;

  const pdfsId = state.getPdfsId();
  let pdfsNode = findNode(state.fileTree, pdfsId);
  if (!pdfsNode) {
    await state.ensurePdfsFolder();
    pdfsNode = findNode(state.fileTree, pdfsId);
  }
  if (!pdfsNode) return;

  const treeNode = {
    id: crypto.randomUUID(),
    type: "pdf",
    name: meta.title || "Untitled",
    fileId,
    children: [],
    flagged: false,
    zoteroAttKey: meta.zoteroAttKey || undefined,
  };
  pdfsNode.children.push(treeNode);
  await state.saveFileTree();
}

async function removePdfTreeNode(state, fileId) {
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const removeFromChildren = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].fileId === fileId && nodes[i].type === "pdf") {
        nodes.splice(i, 1);
        return true;
      }
      if (nodes[i].children && removeFromChildren(nodes[i].children)) return true;
    }
    return false;
  };
  if (removeFromChildren(state.fileTree)) {
    await state.saveFileTree();
  }
}

export function triggerBackgroundDownload(fileId, state) {
  const meta = _registry?.items?.[fileId];
  if (!meta?.zoteroAttKey) return;
  if (!IS_TAURI) return;

  const userId = state.settings?.zoteroUserId;
  const apiKey = state.settings?.zoteroApiKey;
  if (!userId || !apiKey) return;

  _downloadProgress.set(fileId, 0);
  state.emit("files-changed");

  (async () => {
    try {
      const attKey = meta.zoteroAttKey;
      const url = `https://api.zotero.org/users/${userId}/items/${attKey}/file?key=${apiKey}`;
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No readable stream");

      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          _downloadProgress.set(fileId, Math.min(99, Math.round((received / contentLength) * 100)));
          state.emit("files-changed");
        }
      }

      const blob = new Blob(chunks);
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);

      await tauriInvoke("save_pdf", { fileId, bytes: Array.from(bytes) });
      _downloadedSet.add(fileId);
      _downloadProgress.delete(fileId);
      state.emit("files-changed");
    } catch (e) {
      console.error(`Background PDF download failed for ${fileId}:`, e);
      _downloadProgress.delete(fileId);
      state.emit("files-changed");
    }
  })();
}
