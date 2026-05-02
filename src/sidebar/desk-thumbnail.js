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
  // Pane changes (open/close/move/resize) don't fire their own state event,
  // but they always end up touching `settings.persistedPanes`, so we hook
  // settings-changed and just re-render the overlay (cheap — DOM children
  // are absolute-positioned divs).
  const onSettingsChanged = () => refreshDeskThumbnail();
  _state.on("desk-changed", onDeskChanged);
  _state.on("files-changed", onFilesChanged);
  _state.on("doc-content-changed", onContentEdit);
  _state.on("notebook-shapes-changed", onContentEdit);
  _state.on("settings-changed", onSettingsChanged);
  _listeners = { onDeskChanged, onFilesChanged, onContentEdit, onSettingsChanged };
}

function detachListeners() {
  if (!_state || !_listeners) { _listeners = null; return; }
  _state.off("desk-changed", _listeners.onDeskChanged);
  _state.off("files-changed", _listeners.onFilesChanged);
  _state.off("doc-content-changed", _listeners.onContentEdit);
  _state.off("notebook-shapes-changed", _listeners.onContentEdit);
  _state.off("settings-changed", _listeners.onSettingsChanged);
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

  // Pane overlay: a child of the body sized to match the thumbnail
  // viewport so per-pane mini-rectangles can be absolutely positioned
  // without disturbing the underlying canvas/text.
  const paneLayer = document.createElement("div");
  paneLayer.className = "desk-thumbnail-panes";
  body.appendChild(paneLayer);

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
    paintPanesOverlay(fileId, node, paneLayer);
  }).catch((e) => console.warn("desk thumbnail paint failed:", e));

  // Re-render when the panel width changes so the canvas snapshot stays
  // crisp instead of stretching pixels. The text-only doc preview cares
  // less, but the pane overlay still needs a recalc on resize.
  if (typeof ResizeObserver !== "undefined") {
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return;
      lastW = r.width; lastH = r.height;
      // Re-render the canvas at the new dimensions; reposition pane overlay.
      const canvas = body.querySelector("canvas.desk-thumbnail-canvas");
      if (canvas) {
        repaintNotebookCanvas(canvas, node, fileId);
      }
      paintPanesOverlay(fileId, node, paneLayer);
    });
    ro.observe(body);
    wrap._resizeObserver = ro;
  }
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
    canvas._snapshotContent = content;
    body.appendChild(canvas);
    // Defer to next frame so the canvas has its layout dimensions before
    // we measure it for the snapshot render.
    requestAnimationFrame(() => repaintNotebookCanvas(canvas, node, fileId, content));
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
  if (existing) {
    if (existing._resizeObserver) {
      try { existing._resizeObserver.disconnect(); } catch (_) {}
    }
    existing.remove();
  }
}

async function repaintNotebookCanvas(canvas, node, fileId, freshContent) {
  if (node.type !== "notebook") return;
  let content = freshContent ?? canvas._snapshotContent ?? "";
  if (!content && IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      content = file?.content || "";
      canvas._snapshotContent = content;
    } catch (_) {
      return;
    }
  }
  try {
    const [{ renderNotebookSnapshotThumbnail }, { getCanvasInstance }] = await Promise.all([
      import("./notebook-snapshot-preview.js"),
      import("../notebook/notebook-bridge.js"),
    ]);
    const liveCanvas = getCanvasInstance();
    renderNotebookSnapshotThumbnail(canvas, content, liveCanvas);
  } catch (e) {
    console.warn("desk notebook thumbnail repaint failed:", e);
  }
}

/** Overlay miniature pane rectangles on top of the thumbnail body. The
 *  pane positions are stored in screen-space pixels relative to the
 *  editor area, so we use the live window dimensions as the reference
 *  frame and scale into the thumbnail body. Both pinned panes and panes
 *  whose ownerContext matches the desk file are surfaced. */
function paintPanesOverlay(fileId, node, layer) {
  if (!layer || !_state) return;
  layer.innerHTML = "";
  const persisted = _state.settings?.persistedPanes;
  if (!Array.isArray(persisted) || persisted.length === 0) return;
  const ctxKey = node.type === "notebook" ? "nb:" + fileId : "doc:" + fileId;
  const matching = persisted.filter((p) => {
    if (!p) return false;
    if (p.pinned) return true;
    return p.ownerContext === ctxKey;
  });
  if (matching.length === 0) return;

  const refW = Math.max(400, window.innerWidth || 1200);
  const refH = Math.max(300, window.innerHeight || 800);
  const layerW = layer.clientWidth || layer.getBoundingClientRect().width;
  const layerH = layer.clientHeight || layer.getBoundingClientRect().height;
  if (layerW <= 0 || layerH <= 0) return;
  const sx = layerW / refW;
  const sy = layerH / refH;

  for (const p of matching) {
    const rect = document.createElement("div");
    rect.className = "desk-thumbnail-pane" + (p.pinned ? " pinned" : "");
    const w = Math.max(6, (p.width || 320) * sx);
    const h = Math.max(4, (p.height || 240) * sy);
    const x = Math.min(layerW - w, Math.max(0, (p.x || 0) * sx));
    const y = Math.min(layerH - h, Math.max(0, (p.y || 0) * sy));
    rect.style.left = x + "px";
    rect.style.top = y + "px";
    rect.style.width = w + "px";
    rect.style.height = h + "px";
    layer.appendChild(rect);
  }
}
