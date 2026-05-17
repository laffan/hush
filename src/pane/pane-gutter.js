/**
 * "Use Pane as Gutter" — promote an active notebook pane to a tall
 * sidebar pinned alongside the doc text for the *entire* document.
 *
 * Architecture: the pane DOM is *viewport-sized and fixed at the top
 * of the editor* — it does not extend doc-tall and does not move on
 * scroll. Instead, the notebook's `camera.y` tracks `-scrollTop`, so
 * shape world-y maps 1:1 to doc-content-y and the canvas shows
 * whatever vertical slice the doc is currently scrolled to.
 *
 * Why not a doc-tall pane? A pane whose DOM matches scrollHeight
 * triggers the stroke engine's re-anchor path on every resize (which
 * fights CodeMirror's incremental line measurement on long docs and
 * drifts) and the engine's coverage logic assumes `cam.y = -scrollTop`
 * for the viewport math to come out right.
 *
 * Only applies in a Doc context with the active pane backed by a
 * notebook — the gutter is meant to host visual notes that ride
 * alongside long-form writing.
 */
import { panes, activePaneId, appState, GUTTER_Z, zForPane } from "./pane-state.js";
import { stopAttachSync } from "./pane-attach-sync.js";
import { schedulePersist } from "./pane-persistence.js";

const VIEWPORT_TOP_MARGIN = 60;
const PANE_BOTTOM_INSET = 12;

/** Read the cm-scroller's vertical padding so the gutter pane can sit
 *  flush against the actual top of the doc text — that way world-y
 *  inside the canvas maps 1:1 to doc-content-y, which keeps the
 *  shadow-header math simple. */
function getScrollerPadding() {
  const scroller = getScroller();
  if (!scroller) return { top: 0, bottom: 0 };
  const cs = getComputedStyle(scroller);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
  };
}

/** Does any pane in the active doc context already wear the gutter
 *  crown? Only one per doc — the gutter is meant as doc chrome, not
 *  another stacking surface to manage. */
function docHasGutter() {
  if (!appState) return false;
  const ctx = appState.currentFileId ? "doc:" + appState.currentFileId : "";
  if (!ctx) return false;
  for (const [, p] of panes) {
    if (p.gutter && p.ownerContext === ctx) return true;
  }
  return false;
}

export function canUseActivePaneAsGutter() {
  if (!appState || appState.currentNotebookFileId) return false;
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || pane.fileType !== "notebook") return false;
  if (pane.gutter) return false;
  if (docHasGutter()) return false;
  return true;
}

export function isActivePaneAGutter() {
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  return !!(pane && pane.gutter);
}

function getScroller() {
  return appState?.editor?.view?.scrollDOM
    || document.querySelector("#editor-container .cm-scroller");
}

function getContentEl() {
  return appState?.editor?.view?.contentDOM
    || document.querySelector("#editor-container .cm-content");
}

/** Walk the doc, return the y position + text + level of every ATX
 *  heading (`#`, `##`, …). y is doc-content-y, which under our gutter
 *  geometry equals world-y in the canvas. */
function scanDocHeaders() {
  const view = appState?.editor?.view;
  if (!view) return [];
  const headers = [];
  const doc = view.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(#{1,6})\s+(\S.*)$/);
    if (!m) continue;
    const block = view.lineBlockAt(line.from);
    headers.push({ y: block.top, level: m[1].length, text: m[2] });
  }
  return headers;
}

/** Push the current header snapshot into the notebook state so the
 *  canvas renderer can draw the shadow headers, and rebroadcast the
 *  "camera" notify so the change picks up on the next frame. */
function publishShadowHeaders(pane, headers) {
  if (!pane.notebook || !pane.notebook.state) return;
  pane.notebook.state.shadowHeaders = headers;
  pane.notebook.state.notify("camera");
}

/** Re-align gutter shapes from their per-shape anchor: each shape
 *  stores `{ idx, offset, lastY }` where `idx` is the header it sits
 *  under, `offset` is its world-y relative to that header at anchor
 *  time, and `lastY` is the world-y we last wrote. Anchors are
 *  (re)derived lazily — a shape with no anchor, or whose y has been
 *  changed by the user since lastY (a manual drag), gets re-anchored
 *  to the header it currently sits under before we apply the next
 *  header-driven shift. This avoids the "delta of stale measurements"
 *  drift that a pure diff-based approach suffers when CodeMirror's
 *  lineBlockAt(...).top values refine as the user scrolls. */
function applyAnchors(pane) {
  if (!pane.notebook || !pane.notebook.state) return;
  const headers = pane._gutterHeaders || [];
  if (!headers.length) return;
  let anchors = pane._shapeAnchors;
  if (!anchors) anchors = pane._shapeAnchors = new Map();
  const shapes = pane.notebook.state.shapes;
  let mutated = false;
  for (const s of shapes) {
    let a = anchors.get(s.id);
    // Re-anchor: no record, or the user moved this shape since our
    // last write (current y != lastY).
    if (!a || a.lastY !== s.position.y) {
      let idx = -1;
      for (let h = 0; h < headers.length; h++) {
        if (headers[h].y <= s.position.y) idx = h; else break;
      }
      if (idx < 0) { anchors.delete(s.id); continue; }
      a = { idx, offset: s.position.y - headers[idx].y, lastY: s.position.y };
      anchors.set(s.id, a);
      continue; // Already at the right y, no mutation
    }
    if (a.idx >= headers.length) continue;
    const newY = headers[a.idx].y + a.offset;
    if (s.position.y !== newY) {
      s.position = { x: s.position.x, y: newY };
      a.lastY = newY;
      mutated = true;
    }
  }
  if (mutated) pane.notebook.state.notify("shapes");
}

/** Rescan headers, push them into the renderer, and reapply anchors so
 *  shape positions track the current header positions. Header-count
 *  change wipes the anchor map so shapes re-attach to whatever section
 *  they're currently in. */
function scanAndSync(pane) {
  if (!pane.gutter || !panes.has(pane.id)) return;
  const next = scanDocHeaders();
  const prev = pane._gutterHeaders;
  pane._gutterHeaders = next;
  if (!prev || prev.length !== next.length) pane._shapeAnchors = null;
  applyAnchors(pane);
  publishShadowHeaders(pane, next);
}

/** rAF-debounced wrapper around scanAndSync so a scroll storm or a
 *  burst of doc-content-changed events all coalesce to one scan per
 *  frame. */
function scheduleSync(pane) {
  if (pane._gutterSyncPending) return;
  pane._gutterSyncPending = true;
  requestAnimationFrame(() => {
    pane._gutterSyncPending = false;
    scanAndSync(pane);
  });
}

function detectGutterSide(pane) {
  const content = getContentEl();
  let textCenter = window.innerWidth / 2;
  if (content) {
    const cr = content.getBoundingClientRect();
    if (cr.width > 0) textCenter = cr.left + cr.width / 2;
  }
  const paneCenter = pane.x + pane.width / 2;
  return paneCenter < textCenter ? "left" : "right";
}

/** Pane geometry — pinned to the visible doc text area so world-y
 *  in the canvas maps 1:1 to doc-content-y. */
function applyGutterGeometry(pane) {
  const scroller = getScroller();
  const rect = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  const pad = getScrollerPadding();
  const y = rect.top + pad.top;
  const h = Math.max(120, rect.height - pad.top - pad.bottom - PANE_BOTTOM_INSET);
  pane.y = y;
  pane.height = h;
  pane.el.style.top = y + "px";
  pane.el.style.height = h + "px";
}

/** Push the live scrollTop into the notebook's camera.y so the
 *  rendered canvas slice tracks the doc scroll. Camera.x is preserved
 *  for horizontal pan; camera.zoom is locked at 1. */
function syncCameraFromScroll(pane) {
  if (!pane.notebook || !pane.notebook.state) return;
  const scroller = getScroller();
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const st = pane.notebook.state;
  const x = st.camera.x;
  st.camera = { x, y: -scrollTop, zoom: 1 };
  st.notify("camera");
}

function startGutterSync(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  // Scroll → resync. CodeMirror lazily measures lines as they enter the
  // viewport, so each scroll potentially refines header y values. Without
  // a rescan-on-scroll the snapshot would go stale and shape anchors
  // would compound the error on the next doc edit.
  pane._gutterScrollHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    syncCameraFromScroll(pane);
    scheduleSync(pane);
  };
  scroller.addEventListener("scroll", pane._gutterScrollHandler, { passive: true });
  pane._gutterWindowHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    applyGutterGeometry(pane);
    syncCameraFromScroll(pane);
    scheduleSync(pane);
  };
  window.addEventListener("resize", pane._gutterWindowHandler);
  pane._gutterDocChangeHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    scheduleSync(pane);
  };
  appState.on("doc-content-changed", pane._gutterDocChangeHandler);
}

function stopGutterSync(pane) {
  if (pane._gutterScrollHandler) {
    const scroller = getScroller();
    if (scroller) scroller.removeEventListener("scroll", pane._gutterScrollHandler);
    pane._gutterScrollHandler = null;
  }
  if (pane._gutterWindowHandler) {
    window.removeEventListener("resize", pane._gutterWindowHandler);
    pane._gutterWindowHandler = null;
  }
  if (pane._gutterDocChangeHandler) {
    appState?.off?.("doc-content-changed", pane._gutterDocChangeHandler);
    pane._gutterDocChangeHandler = null;
  }
}

export function useActivePaneAsGutter() {
  if (!canUseActivePaneAsGutter()) return false;
  const pane = panes.get(activePaneId);
  if (!pane || !pane.el) return false;

  if (pane.attached) {
    pane.attached = false;
    stopAttachSync(pane);
    const aBtn = pane.el.querySelector(".fp-btn-attach");
    if (aBtn) aBtn.classList.remove("attach-active");
  }
  if (pane.collapsed) {
    pane.collapsed = false;
    pane.el.classList.remove("collapsed");
  }

  pane._gutterPrev = {
    width: pane.width,
    height: pane.height,
    x: pane.x,
    y: pane.y,
    camera: pane.notebook?.state ? { ...pane.notebook.state.camera } : null,
  };

  const side = detectGutterSide(pane);
  pane.gutter = true;
  pane.gutterSide = side;
  pane.el.classList.add("gutter", "gutter-" + side);
  pane.el.classList.remove("gutter-" + (side === "left" ? "right" : "left"));
  pane.el.style.zIndex = GUTTER_Z;

  // Point the notebook at the host doc's scroller — wheel / pan /
  // focusShape redirect through this flag. Camera.y is driven by
  // syncCameraFromScroll on every scroll tick.
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = getScroller();
  }

  applyGutterGeometry(pane);
  syncCameraFromScroll(pane);
  startGutterSync(pane);
  // Defer the first scan one frame so CodeMirror has measured line
  // positions. scheduleSync handles the rAF batching.
  scheduleSync(pane);

  schedulePersist();
  return true;
}

export function stopActivePaneAsGutter() {
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || !pane.gutter || !pane.el) return false;

  stopGutterSync(pane);

  const prev = pane._gutterPrev || {};
  pane.gutter = false;
  pane.gutterSide = null;
  pane._gutterPrev = null;
  pane.el.classList.remove("gutter", "gutter-left", "gutter-right");

  if (typeof prev.width === "number") {
    pane.width = prev.width;
    pane.el.style.width = prev.width + "px";
  }
  if (typeof prev.height === "number") {
    pane.height = prev.height;
    pane.el.style.height = prev.height + "px";
  }
  if (typeof prev.x === "number") {
    pane.x = prev.x;
    pane.el.style.left = prev.x + "px";
  }
  const y = VIEWPORT_TOP_MARGIN;
  pane.y = y;
  pane.el.style.top = y + "px";
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
    pane.notebook.state.shadowHeaders = [];
    if (prev.camera) pane.notebook.state.camera = { ...prev.camera };
    pane.notebook.state.notify("camera");
  }
  pane._gutterHeaders = null;
  pane._shapeAnchors = null;
  pane.el.style.zIndex = zForPane(pane);

  schedulePersist();
  return true;
}

export function restoreGutterLayout(pane) {
  if (!pane || !pane.gutter || !pane.el) return;
  const side = pane.gutterSide || detectGutterSide(pane);
  pane.gutterSide = side;
  pane.el.classList.add("gutter", "gutter-" + side);
  pane.el.style.zIndex = GUTTER_Z;
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = getScroller();
  }
  applyGutterGeometry(pane);
  syncCameraFromScroll(pane);
  if (!pane._gutterScrollHandler) startGutterSync(pane);
  scheduleSync(pane);
}

export function teardownGutterListeners(pane) {
  if (!pane) return;
  if (pane._gutterScrollHandler) stopGutterSync(pane);
  pane._shapeAnchors = null;
  pane._gutterHeaders = null;
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
    pane.notebook.state.shadowHeaders = [];
  }
}
