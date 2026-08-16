/**
 * PDF registry — the manifest of PDF files in the workspace. PDF binary
 * data stays a per-device cache (re-downloaded from Zotero on demand);
 * only this JSON registry describes the set. Under the Local Desks plan
 * the registry becomes per-desk (`.hush/pdf.json` inside the desk
 * folder) so a desk handed to another install re-downloads its PDFs.
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
 *       "addedAt": 1716825600,
 *       "openedAt": 1716825600,          // last time the PDF was opened (any surface)
 *       "bookmarks": [                    // user deep-links into the document
 *         { "id": "...", "name": "...", "color": "#ef5350", "page": 12, "addedAt": 1716825600 },
 *         // …with "x"/"y" (0–1 page fractions) it's a *clip*: a point
 *         // on the page rather than the page as a whole.
 *         { "id": "...", "name": "...", "color": "#42a5f5", "page": 12, "x": 0.61, "y": 0.32, "addedAt": 1716825600 }
 *       ]
 *     }
 *   }
 * }
 */

import { appendSyncError } from "./sync-feedback.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let _registry = null;
let _state = null;
const _downloadProgress = new Map();

let _batchTotal = 0;
let _batchDone = 0;

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
  const pending = Object.keys(_registry.items).filter(
    (fid) => !_downloadedSet.has(fid) && _registry.items[fid].zoteroAttKey,
  );
  if (pending.length) startBatchDownload(pending, state);
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
  // delete_pdf removed the on-disk cover too — drop the session URL.
  try { (await import("../pdf/pdf-covers.js")).evictPdfCover(fileId); } catch {}
  await persistRegistry();
}

async function persistRegistry() {
  if (!_registry) return;
  const payload = JSON.stringify(_registry, null, 2);
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_pdf_registry", { content: payload });
    } catch (e) { appendSyncError(`Failed to save pdf.json: ${e?.message || e}`); }
  }
}

/** Stamp "last opened" on a registry entry — powers the shelf's
 *  open-date sort. Fire-and-forget persistence. */
export function touchPdfOpened(fileId) {
  const item = _registry?.items?.[fileId];
  if (!item) return;
  item.openedAt = Math.floor(Date.now() / 1000);
  persistRegistry();
}

// ===== Bookmarks (deep links into a PDF, stored on the registry entry
// so they ride wherever the metadata rides — aliases share them) =====

export function getPdfBookmarks(fileId) {
  return _registry?.items?.[fileId]?.bookmarks || [];
}

function _bookmarkItem(fileId) {
  if (!_registry) _registry = { format: "hush-pdfs", version: 1, items: {} };
  // Registry entries always exist for real PDFs; the skeleton guard just
  // keeps a stray fileId from crashing the bookmark call.
  let item = _registry.items[fileId];
  if (!item) {
    item = { fileId, title: "", authors: "", firstAuthor: "", year: "", citekey: "", zoteroItemKey: "", zoteroAttKey: "", addedAt: Math.floor(Date.now() / 1000) };
    _registry.items[fileId] = item;
  }
  if (!Array.isArray(item.bookmarks)) item.bookmarks = [];
  return item;
}

export async function addPdfBookmark(fileId, { name, color, page, x, y }) {
  const item = _bookmarkItem(fileId);
  const bookmark = {
    id: crypto.randomUUID(),
    name: (name || "").trim() || `Page ${page}`,
    color: color || "#ef5350",
    page: Math.max(1, page | 0),
    addedAt: Math.floor(Date.now() / 1000),
  };
  // A clip bookmark also carries where on the page it points, as
  // fractions of the page box (0–1, y down) so it survives zoom and
  // re-render. Absent on a plain page bookmark — the presence of the
  // pair is what makes a bookmark a clip.
  if (Number.isFinite(x) && Number.isFinite(y)) {
    bookmark.x = Math.min(1, Math.max(0, x));
    bookmark.y = Math.min(1, Math.max(0, y));
  }
  item.bookmarks.push(bookmark);
  await persistRegistry();
  _state?.emit("pdf-bookmarks-changed", fileId);
  return bookmark;
}

export async function updatePdfBookmark(fileId, bookmarkId, patch) {
  const item = _registry?.items?.[fileId];
  const bm = item?.bookmarks?.find((b) => b.id === bookmarkId);
  if (!bm) return null;
  if (typeof patch.name === "string" && patch.name.trim()) bm.name = patch.name.trim();
  if (typeof patch.color === "string" && patch.color) bm.color = patch.color;
  if (typeof patch.page === "number" && patch.page >= 1) bm.page = patch.page | 0;
  // Where a clip points, moved by a cmd-drag of its dot. Both or
  // neither — a half-updated pair would put the dot on one axis of the
  // old position and one of the new.
  if (Number.isFinite(patch.x) && Number.isFinite(patch.y)) {
    bm.x = Math.min(1, Math.max(0, patch.x));
    bm.y = Math.min(1, Math.max(0, patch.y));
  }
  await persistRegistry();
  _state?.emit("pdf-bookmarks-changed", fileId);
  return bm;
}

export async function removePdfBookmark(fileId, bookmarkId) {
  const item = _registry?.items?.[fileId];
  if (!item?.bookmarks) return;
  const before = item.bookmarks.length;
  item.bookmarks = item.bookmarks.filter((b) => b.id !== bookmarkId);
  if (item.bookmarks.length === before) return;
  await persistRegistry();
  _state?.emit("pdf-bookmarks-changed", fileId);
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
      const bytes = await tauriInvoke("download_zotero_pdf", {
        itemKey: meta.zoteroAttKey, userId, apiKey,
      });
      const pdfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await tauriInvoke("save_pdf", { fileId, bytes: Array.from(pdfBytes) });
      _downloadedSet.add(fileId);
      _downloadProgress.delete(fileId);
      state.emit("files-changed");
      _onBatchItemDone(state);
      // Standard cover extraction: render the first page for the PDF
      // Shelf as soon as the binary lands. Fire-and-forget.
      import("../pdf/pdf-covers.js")
        .then(({ ensurePdfCover }) => ensurePdfCover(fileId, { bytes: pdfBytes }))
        .then(() => state.emit("pdf-cover-ready", fileId))
        .catch(() => {});
      // Pre-warm the annotation cache for this attachment so opening the
      // PDF later (potentially on another device that just synced the
      // entry) doesn't need a network round-trip to paint annotations.
      try {
        const { getAnnotations } = await import("../zotero-annotations.js");
        await getAnnotations(meta.zoteroAttKey, userId, apiKey);
        // The cover rendered above predates the prefetch — re-bake it
        // now that the page-1 annotation marks are known.
        const { refreshPdfCoverIfStale } = await import("../pdf/pdf-covers.js");
        const res = await refreshPdfCoverIfStale(fileId);
        if (res.changed) state.emit("pdf-cover-ready", fileId);
      } catch (e) {
        appendSyncError(`Annotation prefetch failed for ${fileId}: ${e?.message || e}`);
      }
    } catch (e) {
      appendSyncError(`Background PDF download failed for ${fileId}: ${e?.message || e}`);
      _downloadProgress.delete(fileId);
      state.emit("files-changed");
      _onBatchItemDone(state);
    }
  })();
}

function _onBatchItemDone(state) {
  if (_batchTotal === 0) return;
  _batchDone++;
  if (_batchDone >= _batchTotal) {
    state.emit("background-task-done");
    _batchTotal = 0;
    _batchDone = 0;
  } else {
    state.emit("background-task-progress", {
      label: "PDFs",
      progress: _batchDone / _batchTotal,
    });
  }
}

export function startBatchDownload(fileIds, state) {
  if (!fileIds.length) return;
  _batchTotal = fileIds.length;
  _batchDone = 0;
  state.emit("background-task-progress", { label: "PDFs", progress: 0 });
  for (const fid of fileIds) triggerBackgroundDownload(fid, state);
}
