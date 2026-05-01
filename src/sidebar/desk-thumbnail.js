/**
 * Desk thumbnail — a fixed-position card pinned to the bottom of the
 * files panel that shows a preview of `state.settings.deskFileId` and
 * opens it on click.
 *
 * The thumbnail is not part of the scrolling file list; it overlays
 * the bottom of the panel-overlay so a long file tree scrolls behind
 * it. We mount a single `<div class="desk-thumbnail">` as a direct
 * child of the panel-overlay (which is itself `position: fixed`) and
 * remove + re-render whenever `desk-changed`, the underlying file's
 * content, or the panel itself is rebuilt.
 *
 * For docs: a small card with the filename plus the first lines of
 * content. For notebooks: a miniature canvas painted by the existing
 * snapshot-preview renderer (re-used from the Versions panel work).
 */

import { findNodeByFileId } from "../state/tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let _panelOverlay = null;
let _state = null;
let _renderToken = 0;
let _listeners = null;
let _editTimer = null;

const EDIT_REFRESH_DELAY_MS = 2500; // long enough for the 2s autosave to land

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Mount the thumbnail under `panelOverlay`. Safe to call multiple
 *  times — the previous instance is removed first. */
export function mountDeskThumbnail(panelOverlay, state) {
  detachListeners();
  _panelOverlay = panelOverlay;
  _state = state;
  attachListeners();
  refreshDeskThumbnail();
}

export function unmountDeskThumbnail() {
  detachListeners();
  removeExistingThumbnail();
  _panelOverlay = null;
  _state = null;
}

function attachListeners() {
  if (!_state) return;
  const onDeskChanged = () => refreshDeskThumbnail();
  const onFilesChanged = () => refreshDeskThumbnail();
  // Edits to the desk file mean the saved content is about to change.
  // Wait past the 2s autosave debounce before re-reading from disk so
  // the thumbnail tracks the persisted state, not the in-flight buffer.
  const onContentEdit = () => {
    const fileId = _state?.settings?.deskFileId;
    if (!fileId) return;
    const currentlyEditing = _state.currentNotebookFileId === fileId
      || (_state.currentFileId === fileId && !_state.currentNotebookFileId);
    if (!currentlyEditing) return;
    if (_editTimer) clearTimeout(_editTimer);
    _editTimer = setTimeout(() => { _editTimer = null; refreshDeskThumbnail(); }, EDIT_REFRESH_DELAY_MS);
  };
  _state.on("desk-changed", onDeskChanged);
  _state.on("files-changed", onFilesChanged);
  _state.on("doc-content-changed", onContentEdit);
  _state.on("notebook-shapes-changed", onContentEdit);
  _listeners = { onDeskChanged, onFilesChanged, onContentEdit };
}

function detachListeners() {
  if (!_state || !_listeners) { _listeners = null; return; }
  _state.off("desk-changed", _listeners.onDeskChanged);
  _state.off("files-changed", _listeners.onFilesChanged);
  _state.off("doc-content-changed", _listeners.onContentEdit);
  _state.off("notebook-shapes-changed", _listeners.onContentEdit);
  _listeners = null;
  if (_editTimer) { clearTimeout(_editTimer); _editTimer = null; }
}

/** Re-render the thumbnail in place. Cheap to call on file-tree
 *  changes / content edits — bails out fast when nothing applies. */
export function refreshDeskThumbnail() {
  if (!_panelOverlay || !_state) return;
  const fileId = _state.settings?.deskFileId || null;
  removeExistingThumbnail();
  if (!fileId) return;

  const node = findNodeByFileId(_state.fileTree, fileId);
  if (!node || (node.type !== "document" && node.type !== "notebook")) return;

  const wrap = document.createElement("div");
  wrap.className = "desk-thumbnail";
  wrap.dataset.fileId = fileId;
  wrap.title = node.name || "Untitled";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "button");

  const body = document.createElement("div");
  body.className = "desk-thumbnail-body";
  wrap.appendChild(body);

  wrap.addEventListener("click", () => {
    if (!_state) return;
    if (node.type === "notebook") _state.openNotebook(fileId);
    else _state.openFile(fileId);
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wrap.click(); }
  });

  _panelOverlay.appendChild(wrap);

  // Async paint — load the file content and fill the body. Token
  // protects against stale results when refreshDeskThumbnail is called
  // again before the in-flight load resolves.
  const myToken = ++_renderToken;
  paintBody(node, fileId, body).then(() => {
    if (myToken !== _renderToken) return;
  }).catch((e) => console.warn("desk thumbnail paint failed:", e));
}

async function paintBody(node, fileId, body) {
  if (!IS_TAURI) {
    body.textContent = "Desktop only";
    return;
  }
  let content = "";
  try {
    const file = await tauriInvoke("load_file", { id: fileId });
    content = file?.content || "";
  } catch (e) {
    body.textContent = "Unavailable";
    return;
  }

  if (node.type === "notebook") {
    const canvas = document.createElement("canvas");
    canvas.className = "desk-thumbnail-canvas";
    body.appendChild(canvas);
    // Defer to next frame so the canvas has its layout dimensions before
    // we measure it for the snapshot render.
    requestAnimationFrame(async () => {
      try {
        const [{ renderNotebookSnapshotThumbnail }, { getCanvasInstance }] = await Promise.all([
          import("./notebook-snapshot-preview.js"),
          import("../notebook/notebook-bridge.js"),
        ]);
        const liveCanvas = getCanvasInstance();
        renderNotebookSnapshotThumbnail(canvas, content, liveCanvas);
      } catch (e) {
        console.warn("desk notebook thumbnail failed:", e);
      }
    });
  } else {
    const text = document.createElement("div");
    text.className = "desk-thumbnail-text";
    text.textContent = previewSnippet(content);
    body.appendChild(text);
  }
}

/** Strip markdown noise enough that the preview reads as prose. We
 *  don't try to render markdown — the thumbnail is a reading-glance,
 *  not a faithful render. */
function previewSnippet(content) {
  if (!content) return "";
  const cleaned = content
    .replace(/^#{1,6}\s+/gm, "")            // heading markers
    .replace(/%%[\s\S]*?%%/g, "")            // inline comments
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/[*_~`>]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length <= 240) return cleaned;
  return cleaned.slice(0, 240).replace(/\s+\S*$/, "") + "…";
}

function removeExistingThumbnail() {
  if (!_panelOverlay) return;
  const existing = _panelOverlay.querySelector(".desk-thumbnail");
  if (existing) existing.remove();
}
