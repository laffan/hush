/**
 * Desktop thumbnail — a fixed-position card pinned to the bottom of
 * the files panel that shows a preview of `state.settings.desktopFileId`
 * and opens it on click.
 *
 * The thumbnail is not part of the scrolling file list; it overlays
 * the bottom of the panel-overlay so a long file tree scrolls behind
 * it. We mount a single `<div class="desktop-thumbnail">` as a direct
 * child of the panel-overlay (which is itself `position: fixed`) and
 * remove + re-render whenever `desktop-changed`, the underlying file's
 * content, or the panel itself is rebuilt.
 *
 * For docs: a small card with the filename plus the first lines of
 * content. For notebooks: a miniature canvas painted by the existing
 * snapshot-preview renderer.
 *
 * (Minimap behaviour — viewport rect, pane overlays, click-to-pan —
 * lives in `notebook/minimap.js` so the desktop thumbnail can stay a
 * pure preview regardless of which file type is pinned.)
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
export function mountDesktopThumbnail(panelOverlay, state) {
  detachListeners();
  _panelOverlay = panelOverlay;
  _state = state;
  attachListeners();
  refreshDesktopThumbnail();
}

export function unmountDesktopThumbnail() {
  detachListeners();
  removeExistingThumbnail();
  _panelOverlay = null;
  _state = null;
}

function attachListeners() {
  if (!_state) return;
  const onDesktopChanged = () => refreshDesktopThumbnail();
  const onFilesChanged = () => refreshDesktopThumbnail();
  // Edits to the desktop file mean the saved content is about to change.
  // Wait past the 2s autosave debounce before re-reading from disk so
  // the thumbnail tracks the persisted state, not the in-flight buffer.
  const onContentEdit = () => {
    const fileId = _state?.settings?.desktopFileId;
    if (!fileId) return;
    const currentlyEditing = _state.currentNotebookFileId === fileId
      || (_state.currentFileId === fileId && !_state.currentNotebookFileId);
    if (!currentlyEditing) return;
    if (_editTimer) clearTimeout(_editTimer);
    _editTimer = setTimeout(() => { _editTimer = null; refreshDesktopThumbnail(); }, EDIT_REFRESH_DELAY_MS);
  };
  _state.on("desktop-changed", onDesktopChanged);
  _state.on("files-changed", onFilesChanged);
  _state.on("doc-content-changed", onContentEdit);
  _state.on("notebook-shapes-changed", onContentEdit);
  _listeners = { onDesktopChanged, onFilesChanged, onContentEdit };
}

function detachListeners() {
  if (!_state || !_listeners) { _listeners = null; return; }
  _state.off("desktop-changed", _listeners.onDesktopChanged);
  _state.off("files-changed", _listeners.onFilesChanged);
  _state.off("doc-content-changed", _listeners.onContentEdit);
  _state.off("notebook-shapes-changed", _listeners.onContentEdit);
  _listeners = null;
  if (_editTimer) { clearTimeout(_editTimer); _editTimer = null; }
}

/** Re-render the thumbnail in place. Cheap to call on file-tree
 *  changes / content edits — bails out fast when nothing applies. */
export function refreshDesktopThumbnail() {
  if (!_panelOverlay || !_state) return;
  const fileId = _state.settings?.desktopFileId || null;
  removeExistingThumbnail();
  if (!fileId) return;

  const node = findNodeByFileId(_state.fileTree, fileId);
  if (!node || (node.type !== "document" && node.type !== "notebook")) return;

  const wrap = document.createElement("div");
  wrap.className = "desktop-thumbnail";
  wrap.dataset.fileId = fileId;
  wrap.title = node.name || "Untitled";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "button");

  const body = document.createElement("div");
  body.className = "desktop-thumbnail-body";
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
  // protects against stale results when refreshDesktopThumbnail is
  // called again before the in-flight load resolves.
  const myToken = ++_renderToken;
  paintBody(node, fileId, body).catch((e) => console.warn("desktop thumbnail paint failed:", e));

  // Re-render the canvas at new dimensions when the panel is resized
  // so the snapshot bitmap stays crisp instead of stretching.
  if (typeof ResizeObserver !== "undefined") {
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver((entries) => {
      if (myToken !== _renderToken) return;
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return;
      lastW = r.width; lastH = r.height;
      const canvas = body.querySelector("canvas.desktop-thumbnail-canvas");
      if (canvas) repaintNotebookCanvas(canvas, node, fileId);
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
    canvas.className = "desktop-thumbnail-canvas";
    canvas._snapshotContent = content;
    body.appendChild(canvas);
    // Defer to next frame so the canvas has its layout dimensions
    // before we measure it for the snapshot render.
    await new Promise((resolve) => {
      requestAnimationFrame(async () => {
        await repaintNotebookCanvas(canvas, node, fileId, content);
        resolve();
      });
    });
  } else {
    const text = document.createElement("div");
    text.className = "desktop-thumbnail-text";
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
  const existing = _panelOverlay.querySelector(".desktop-thumbnail");
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
    console.warn("desktop notebook thumbnail repaint failed:", e);
  }
}
