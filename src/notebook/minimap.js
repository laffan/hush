/**
 * Notebook minimap — floating widget anchored bottom-right of the
 * canvas. Notebooks-only, opt-in via `settings.minimapVisible` (toggle
 * via the command palette: "Show minimap" / "Hide minimap").
 *
 * The widget shows a snapshot of the open notebook with three overlays:
 *   1. Pane rectangles — one per persisted pane whose ownerContext is
 *      the open notebook (or that's pinned), positioned by the pane's
 *      stored canvas world coords projected through the snapshot
 *      camera.
 *   2. Viewport rect — a blue rectangle echoing the live camera's
 *      world viewport, refreshed on every animation frame.
 *   3. Click + drag pans the live camera so the clicked world point
 *      lands at the centre of the live viewport.
 *
 * The implementation is a standalone projection of the open notebook
 * scene so the minimap can be toggled independently of any other
 * snapshot surface.
 */

let _container = null;       // outer floating box
let _canvas = null;          // snapshot canvas (host for the rendered preview)
let _paneLayer = null;       // overlay div for pane rectangles
let _viewportRect = null;    // overlay div for the live viewport
let _state = null;
let _fileId = null;          // currently-open notebook id when mounted
let _resizeObserver = null;
let _renderToken = 0;
let _rafToken = 0;
let _listeners = null;
let _editTimer = null;

const EDIT_REFRESH_DELAY_MS = 1500;
const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Wire the minimap to a single AppState so it mounts / unmounts in
 *  response to `notebook-open` / `notebook-unmount` and the
 *  `minimap-visibility-changed` toggle. Also mounts immediately when a
 *  notebook is already open at call time (boot path). Call once during
 *  boot. */
export function wireMinimap(state) {
  state.on("notebook-open", (fileId) => { if (state.settings?.minimapVisible) mountMinimap(state, fileId); });
  state.on("notebook-unmount", () => { unmountMinimap(); });
  state.on("minimap-visibility-changed", (visible) => {
    if (visible && state.currentNotebookFileId) mountMinimap(state, state.currentNotebookFileId);
    else unmountMinimap();
  });
  if (state.settings?.minimapVisible && state.currentNotebookFileId) {
    mountMinimap(state, state.currentNotebookFileId);
  }
}

/** Mount the minimap for the open notebook. Idempotent — calling while
 *  already mounted just refreshes the snapshot. */
export function mountMinimap(state, fileId) {
  if (!fileId) return;
  if (_container && _state === state && _fileId === fileId) {
    refreshMinimap();
    return;
  }
  unmountMinimap();
  _state = state;
  _fileId = fileId;
  buildDom();
  attachListeners();
  refreshMinimap();
}

export function unmountMinimap() {
  detachListeners();
  if (_resizeObserver) { try { _resizeObserver.disconnect(); } catch (_) {} _resizeObserver = null; }
  if (_rafToken) { try { cancelAnimationFrame(_rafToken); } catch (_) {} _rafToken = 0; }
  if (_container && _container.parentNode) _container.parentNode.removeChild(_container);
  _container = null;
  _canvas = null;
  _paneLayer = null;
  _viewportRect = null;
  _fileId = null;
  _state = null;
  if (_editTimer) { clearTimeout(_editTimer); _editTimer = null; }
}

/** Repaint the snapshot + overlays (without rebuilding the DOM). */
export function refreshMinimap() {
  if (!_container || !_state || !_fileId) return;
  const myToken = ++_renderToken;
  loadAndPaintSnapshot(myToken).catch((e) => console.warn("minimap paint failed:", e));
}

function buildDom() {
  const host = pickHost();
  _container = document.createElement("div");
  _container.className = "notebook-minimap";

  const body = document.createElement("div");
  body.className = "notebook-minimap-body";
  _container.appendChild(body);

  _canvas = document.createElement("canvas");
  _canvas.className = "notebook-minimap-canvas";
  body.appendChild(_canvas);

  _paneLayer = document.createElement("div");
  _paneLayer.className = "notebook-minimap-panes";
  body.appendChild(_paneLayer);

  _viewportRect = document.createElement("div");
  _viewportRect.className = "notebook-minimap-viewport";
  _viewportRect.style.display = "none";
  body.appendChild(_viewportRect);

  wirePan(body);
  host.appendChild(_container);

  if (typeof ResizeObserver !== "undefined") {
    let lastW = 0, lastH = 0;
    _resizeObserver = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return;
      lastW = r.width; lastH = r.height;
      refreshMinimap();
    });
    _resizeObserver.observe(body);
  }
}

/** Mount the floating widget on top of the notebook canvas host. Falls
 *  back to <body> if the host isn't available (the canvas may not be
 *  in the DOM yet at first call). */
function pickHost() {
  return document.getElementById("notebook-container") || document.body;
}

function attachListeners() {
  if (!_state) return;
  const onShapesChanged = () => {
    if (_editTimer) clearTimeout(_editTimer);
    _editTimer = setTimeout(() => { _editTimer = null; refreshMinimap(); }, EDIT_REFRESH_DELAY_MS);
  };
  const onSettings = () => refreshMinimap();
  _state.on("notebook-shapes-changed", onShapesChanged);
  _state.on("settings-changed", onSettings);
  _listeners = { onShapesChanged, onSettings };
  startViewportLoop();
}

function detachListeners() {
  if (!_state || !_listeners) { _listeners = null; return; }
  _state.off("notebook-shapes-changed", _listeners.onShapesChanged);
  _state.off("settings-changed", _listeners.onSettings);
  _listeners = null;
}

async function loadAndPaintSnapshot(token) {
  if (!_canvas || !_fileId) return;
  let content = "";
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: _fileId });
      content = file?.content || "";
    }
  } catch (_) { /* leave content empty — we still paint an empty canvas */ }
  if (token !== _renderToken) return;

  // Defer one frame so the canvas has its layout dimensions before we
  // measure it for the snapshot render.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (token !== _renderToken) return;

  try {
    const [{ renderNotebookSnapshotThumbnail }, { getCanvasInstance }] = await Promise.all([
      import("../sidebar/notebook-snapshot-preview.js"),
      import("./notebook-bridge.js"),
    ]);
    const live = getCanvasInstance();
    const result = renderNotebookSnapshotThumbnail(_canvas, content, live);
    _canvas._snapshotCamera = result?.camera || null;
    _canvas._snapshotCssW = _canvas.clientWidth || _canvas.getBoundingClientRect().width;
    _canvas._snapshotCssH = _canvas.clientHeight || _canvas.getBoundingClientRect().height;
  } catch (e) {
    console.warn("minimap snapshot render failed:", e);
  }
  paintPanes();
}

function paintPanes() {
  if (!_paneLayer || !_state || !_canvas) return;
  _paneLayer.innerHTML = "";
  const persisted = _state.settings?.persistedPanes;
  if (!Array.isArray(persisted) || persisted.length === 0) return;
  const ctxKey = "nb:" + _fileId;
  const matching = persisted.filter((p) => {
    if (!p) return false;
    if (p.pinned) return true;
    return p.ownerContext === ctxKey;
  });
  if (matching.length === 0) return;

  const layerW = _paneLayer.clientWidth || _paneLayer.getBoundingClientRect().width;
  const layerH = _paneLayer.clientHeight || _paneLayer.getBoundingClientRect().height;
  if (layerW <= 0 || layerH <= 0) return;

  const cam = _canvas._snapshotCamera || null;
  if (!cam) return;
  const cssW = _canvas._snapshotCssW || layerW;
  const cssH = _canvas._snapshotCssH || layerH;

  for (const p of matching) {
    const rect = document.createElement("div");
    rect.className = "notebook-minimap-pane" + (p.pinned ? " pinned" : "");
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
    _paneLayer.appendChild(rect);
  }
}

function startViewportLoop() {
  if (!_viewportRect) return;
  if (_rafToken) { try { cancelAnimationFrame(_rafToken); } catch (_) {} _rafToken = 0; }
  // Resolve the bridge lookup once instead of `await import(...)`-ing the
  // module on every single frame (that allocated a promise + ran a module
  // lookup 60×/sec the whole time the minimap was open).
  let getCanvasInstance = null;
  import("./notebook-bridge.js").then((m) => { getCanvasInstance = m.getCanvasInstance; });
  let _lastGeom = "";
  const tick = () => {
    if (!_viewportRect) return;
    const live = getCanvasInstance && getCanvasInstance();
    const ok = live
      && _state?.currentNotebookFileId === _fileId
      && live.state?.canvasEl
      && _canvas?._snapshotCamera;
    if (!ok) {
      if (_lastGeom !== "hidden") { _viewportRect.style.display = "none"; _lastGeom = "hidden"; }
      _rafToken = requestAnimationFrame(tick);
      return;
    } else {
      const liveCam = live.state.camera;
      const liveCanvas = live.state.canvasEl;
      const liveW = liveCanvas.clientWidth || liveCanvas.getBoundingClientRect().width || window.innerWidth;
      const liveH = liveCanvas.clientHeight || liveCanvas.getBoundingClientRect().height || window.innerHeight;
      const worldX = -liveCam.x / liveCam.zoom;
      const worldY = -liveCam.y / liveCam.zoom;
      const worldW = liveW / liveCam.zoom;
      const worldH = liveH / liveCam.zoom;
      const cam = _canvas._snapshotCamera;
      const cssW = _canvas._snapshotCssW || 1;
      const cssH = _canvas._snapshotCssH || 1;
      const layerW = _viewportRect.parentNode?.clientWidth || cssW;
      const layerH = _viewportRect.parentNode?.clientHeight || cssH;
      const sx = layerW / cssW;
      const sy = layerH / cssH;
      const x = Math.round((worldX * cam.zoom + cam.x) * sx);
      const y = Math.round((worldY * cam.zoom + cam.y) * sy);
      const w = Math.max(2, Math.round(worldW * cam.zoom * sx));
      const h = Math.max(2, Math.round(worldH * cam.zoom * sy));
      // Only touch the DOM when the rect actually moved — an idle canvas
      // produces identical geometry every frame, so this avoids forcing a
      // style recalc 60×/sec while the user isn't panning or zooming.
      const geom = `${x},${y},${w},${h}`;
      if (geom !== _lastGeom) {
        _lastGeom = geom;
        _viewportRect.style.display = "block";
        _viewportRect.style.left = x + "px";
        _viewportRect.style.top = y + "px";
        _viewportRect.style.width = w + "px";
        _viewportRect.style.height = h + "px";
      }
    }
    _rafToken = requestAnimationFrame(tick);
  };
  _rafToken = requestAnimationFrame(tick);
}

function wirePan(body) {
  let dragging = false;
  function panToEvent(e) {
    if (!_state || _state.currentNotebookFileId !== _fileId) return false;
    const cam = _canvas?._snapshotCamera || null;
    const cssW = _canvas?._snapshotCssW || 0;
    const cssH = _canvas?._snapshotCssH || 0;
    if (!cam || cssW <= 0 || cssH <= 0) return false;
    const rect = body.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const snapX = (localX / rect.width) * cssW;
    const snapY = (localY / rect.height) * cssH;
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
    const { getCanvasInstance } = await import("./notebook-bridge.js");
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
    console.warn("minimap pan failed:", e);
    return false;
  }
}
