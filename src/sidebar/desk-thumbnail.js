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
 * snapshot-preview renderer; on top we overlay each pane's footprint
 * (projected through the snapshot camera) and, when the desk file is
 * the open notebook, a viewport rectangle showing where the user is
 * currently looking. Clicking inside the thumbnail's notebook area
 * pans the live canvas to that world point — minimap behaviour.
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

  // Viewport rect — only painted when we have a live notebook canvas
  // for this file. The minimap rectangle echoes the live camera and
  // updates on every camera tick so the user can see where they are.
  const viewportRect = document.createElement("div");
  viewportRect.className = "desk-thumbnail-viewport";
  viewportRect.style.display = "none";
  body.appendChild(viewportRect);

  // Open-on-click is wired on the wrap, but for notebooks we also let
  // the user click inside the body to pan the live camera (minimap).
  // The pan handler sits on `body`, click-to-open sits on the wrap
  // border / outside the body, with a small flag to disambiguate.
  let didMinimapPan = false;
  wrap.addEventListener("click", () => {
    if (didMinimapPan) { didMinimapPan = false; return; }
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
    paintPanesOverlay(fileId, node, paneLayer, body);
    paintViewportOverlay(fileId, node, viewportRect, body);
    wireMinimapInteractions(fileId, node, body, viewportRect, () => { didMinimapPan = true; });
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
      paintPanesOverlay(fileId, node, paneLayer, body);
      paintViewportOverlay(fileId, node, viewportRect, body);
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
    // we measure it for the snapshot render. Awaiting here means the
    // pane / viewport overlays painted by the caller see a populated
    // `_snapshotCamera`, not null.
    await new Promise((resolve) => {
      requestAnimationFrame(async () => {
        await repaintNotebookCanvas(canvas, node, fileId, content);
        resolve();
      });
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
  if (existing) {
    if (existing._resizeObserver) {
      try { existing._resizeObserver.disconnect(); } catch (_) {}
    }
    const vp = existing.querySelector(".desk-thumbnail-viewport");
    if (vp && vp._raf) {
      try { cancelAnimationFrame(vp._raf); } catch (_) {}
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
    const result = renderNotebookSnapshotThumbnail(canvas, content, liveCanvas);
    // Stash the snapshot camera + bounds on the canvas so later overlay
    // passes (panes, viewport rect, click-to-pan) can project world
    // coordinates without re-decoding the envelope.
    canvas._snapshotCamera = result?.camera || null;
    canvas._snapshotBounds = result?.contentBounds || null;
    canvas._snapshotCssW = canvas.clientWidth || canvas.getBoundingClientRect().width;
    canvas._snapshotCssH = canvas.clientHeight || canvas.getBoundingClientRect().height;
  } catch (e) {
    console.warn("desk notebook thumbnail repaint failed:", e);
  }
}

/** Overlay miniature pane rectangles on top of the thumbnail body.
 *  - For notebook desks, canvas-attached panes are projected through
 *    the snapshot camera so their footprint matches the underlying
 *    shapes' positions. Free-floating panes (no canvas anchor) get
 *    rendered with the screen-pixel scaling fall-back since they
 *    don't really have a world position.
 *  - For doc desks, panes use the legacy screen-space scaling (still
 *    a rough approximation, but docs don't have a world coord system).
 */
function paintPanesOverlay(fileId, node, layer, body) {
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

  const layerW = layer.clientWidth || layer.getBoundingClientRect().width;
  const layerH = layer.clientHeight || layer.getBoundingClientRect().height;
  if (layerW <= 0 || layerH <= 0) return;

  if (node.type === "notebook") {
    paintNotebookPanes(matching, layer, layerW, layerH, body);
  } else {
    paintDocPanes(matching, layer, layerW, layerH);
  }
}

function paintNotebookPanes(matching, layer, layerW, layerH, body) {
  const canvas = body?.querySelector("canvas.desk-thumbnail-canvas");
  const cam = canvas?._snapshotCamera || null;
  const cssW = canvas?._snapshotCssW || layerW;
  const cssH = canvas?._snapshotCssH || layerH;
  if (!cam) return; // empty notebook — nothing to anchor against

  for (const p of matching) {
    const rect = document.createElement("div");
    rect.className = "desk-thumbnail-pane" + (p.pinned ? " pinned" : "");

    // Canvas-attached panes carry world coords; free-floating panes
    // only have screen coords, so use a fall-back projection that
    // treats their persisted (x, y, w, h) as a scaled-down editor
    // rect — better than dropping them silently.
    let x, y, w, h;
    if (p.canvasX != null && p.canvasY != null) {
      const tx = p.canvasX * cam.zoom + cam.x;
      const ty = p.canvasY * cam.zoom + cam.y;
      x = (tx / cssW) * layerW;
      y = (ty / cssH) * layerH;
      w = ((p.width || 320) * cam.zoom / cssW) * layerW;
      h = ((p.height || 240) * cam.zoom / cssH) * layerH;
    } else {
      const refW = Math.max(400, window.innerWidth || 1200);
      const refH = Math.max(300, window.innerHeight || 800);
      x = (p.x || 0) * (layerW / refW);
      y = (p.y || 0) * (layerH / refH);
      w = (p.width || 320) * (layerW / refW);
      h = (p.height || 240) * (layerH / refH);
    }

    const minVisible = 4;
    if (x + w < minVisible || y + h < minVisible) continue;
    if (x > layerW - minVisible || y > layerH - minVisible) continue;
    rect.style.left = Math.max(0, Math.round(x)) + "px";
    rect.style.top = Math.max(0, Math.round(y)) + "px";
    rect.style.width = Math.max(3, Math.round(Math.min(w, layerW - Math.max(0, x)))) + "px";
    rect.style.height = Math.max(3, Math.round(Math.min(h, layerH - Math.max(0, y)))) + "px";
    layer.appendChild(rect);
  }
}

function paintDocPanes(matching, layer, layerW, layerH) {
  const refW = Math.max(400, window.innerWidth || 1200);
  const refH = Math.max(300, window.innerHeight || 800);
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

/** Paint the minimap viewport rect when the desk file is the currently-
 *  open notebook. Continually polls the live camera via
 *  requestAnimationFrame so panning the canvas updates the thumbnail
 *  in lockstep. */
function paintViewportOverlay(fileId, node, viewportRect, body) {
  if (!viewportRect) return;
  // Cancel any previous loop attached to this rect — the body might
  // have been re-painted since (resize, content edit, etc.).
  if (viewportRect._raf) {
    cancelAnimationFrame(viewportRect._raf);
    viewportRect._raf = 0;
  }
  if (node.type !== "notebook") {
    viewportRect.style.display = "none";
    return;
  }

  // Wire the live notebook canvas; bail if a different notebook is open
  // (the desk file isn't the active main view).
  import("../notebook/notebook-bridge.js").then(({ getCanvasInstance }) => {
    const tick = () => {
      const live = getCanvasInstance();
      const liveActive = live
        && _state?.currentNotebookFileId === fileId
        && live.state?.canvasEl;
      const canvas = body?.querySelector("canvas.desk-thumbnail-canvas");
      const cam = canvas?._snapshotCamera || null;
      const cssW = canvas?._snapshotCssW || 0;
      const cssH = canvas?._snapshotCssH || 0;
      const layerW = body?.clientWidth || 0;
      const layerH = body?.clientHeight || 0;

      if (!liveActive || !cam || cssW <= 0 || cssH <= 0 || layerW <= 0 || layerH <= 0) {
        viewportRect.style.display = "none";
      } else {
        const liveCam = live.state.camera;
        const liveCanvas = live.state.canvasEl;
        const liveW = liveCanvas.clientWidth || liveCanvas.getBoundingClientRect().width || window.innerWidth;
        const liveH = liveCanvas.clientHeight || liveCanvas.getBoundingClientRect().height || window.innerHeight;
        // Live viewport in world coords:
        const worldX = -liveCam.x / liveCam.zoom;
        const worldY = -liveCam.y / liveCam.zoom;
        const worldW = liveW / liveCam.zoom;
        const worldH = liveH / liveCam.zoom;
        // Project into snapshot screen coords, then into thumbnail body coords.
        const sx = layerW / cssW;
        const sy = layerH / cssH;
        const x = (worldX * cam.zoom + cam.x) * sx;
        const y = (worldY * cam.zoom + cam.y) * sy;
        const w = worldW * cam.zoom * sx;
        const h = worldH * cam.zoom * sy;
        viewportRect.style.display = "block";
        viewportRect.style.left = Math.round(x) + "px";
        viewportRect.style.top = Math.round(y) + "px";
        viewportRect.style.width = Math.max(2, Math.round(w)) + "px";
        viewportRect.style.height = Math.max(2, Math.round(h)) + "px";
      }
      viewportRect._raf = requestAnimationFrame(tick);
    };
    viewportRect._raf = requestAnimationFrame(tick);
  }).catch(() => {});
}

/** Click + drag on the thumbnail body pans the live canvas to that
 *  world point. Only active when the desk file is the open notebook. */
function wireMinimapInteractions(fileId, node, body, viewportRect, markPanned) {
  if (!body) return;
  if (body._minimapWired) return;
  body._minimapWired = true;
  if (node.type !== "notebook") return;

  let dragging = false;

  function panToEvent(e) {
    if (!_state || _state.currentNotebookFileId !== fileId) return false;
    const canvas = body.querySelector("canvas.desk-thumbnail-canvas");
    const cam = canvas?._snapshotCamera || null;
    const cssW = canvas?._snapshotCssW || 0;
    const cssH = canvas?._snapshotCssH || 0;
    if (!cam || cssW <= 0 || cssH <= 0) return false;
    const rect = body.getBoundingClientRect();
    const layerW = rect.width;
    const layerH = rect.height;
    if (layerW <= 0 || layerH <= 0) return false;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    // Thumbnail body coords → snapshot screen coords → world coords.
    const snapX = (localX / layerW) * cssW;
    const snapY = (localY / layerH) * cssH;
    const worldX = (snapX - cam.x) / cam.zoom;
    const worldY = (snapY - cam.y) / cam.zoom;
    return panLiveCameraTo(worldX, worldY);
  }

  body.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (panToEvent(e)) {
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      markPanned();
      try { body.setPointerCapture(e.pointerId); } catch (_) {}
    }
  });
  body.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panToEvent(e);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { body.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  body.addEventListener("pointerup", stop);
  body.addEventListener("pointercancel", stop);
}

async function panLiveCameraTo(worldX, worldY) {
  try {
    const { getCanvasInstance } = await import("../notebook/notebook-bridge.js");
    const live = getCanvasInstance();
    if (!live || !live.state) return false;
    const canvasEl = live.state.canvasEl;
    if (!canvasEl) return false;
    const liveW = canvasEl.clientWidth || canvasEl.getBoundingClientRect().width || window.innerWidth;
    const liveH = canvasEl.clientHeight || canvasEl.getBoundingClientRect().height || window.innerHeight;
    const zoom = live.state.camera.zoom;
    live.state.camera = {
      x: liveW / 2 - worldX * zoom,
      y: liveH / 2 - worldY * zoom,
      zoom,
    };
    live.state.notify("camera");
    return true;
  } catch (e) {
    console.warn("desk minimap pan failed:", e);
    return false;
  }
}
