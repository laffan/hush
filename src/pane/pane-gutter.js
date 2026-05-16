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
/** Top inset for the gutter pane — leaves the title-bar drag region
 *  visible above. Mirrors the editor's scroller padding-top so world-y
 *  0 lines up with the top of the doc text. */
const PANE_TOP_INSET = 30;
const PANE_BOTTOM_INSET = 12;

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

/** Pane geometry — fixed in the viewport, no doc-scroll math. */
function applyGutterGeometry(pane) {
  const y = PANE_TOP_INSET;
  const h = Math.max(120, window.innerHeight - PANE_TOP_INSET - PANE_BOTTOM_INSET);
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
  pane._gutterScrollHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    syncCameraFromScroll(pane);
  };
  scroller.addEventListener("scroll", pane._gutterScrollHandler, { passive: true });
  pane._gutterWindowHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    applyGutterGeometry(pane);
    syncCameraFromScroll(pane);
  };
  window.addEventListener("resize", pane._gutterWindowHandler);
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
    if (prev.camera) pane.notebook.state.camera = { ...prev.camera };
    pane.notebook.state.notify("camera");
  }
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
}

export function teardownGutterListeners(pane) {
  if (!pane) return;
  if (pane._gutterScrollHandler) stopGutterSync(pane);
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
  }
}
