/**
 * "Use Pane as Gutter" — promote an active notebook pane to a tall
 * sidebar pinned alongside the doc text for the *entire* document.
 *
 * The pane is anchored to the top of the doc content (scroll-aware, so
 * the pane top can sit above the viewport when the user has scrolled
 * down) and stretched to the full scrollable height of the doc. A
 * scroll listener keeps the pane's viewport y in sync with the doc's
 * scrollTop, and a ResizeObserver on .cm-content keeps the pane's
 * height in sync with the doc's content height.
 *
 * Only applies in a Doc context with the active pane backed by a
 * notebook — the gutter is meant to host visual notes that ride
 * alongside long-form writing.
 */
import { panes, activePaneId, appState, GUTTER_Z, zForPane } from "./pane-state.js";
import { stopAttachSync } from "./pane-attach-sync.js";
import { schedulePersist } from "./pane-persistence.js";

const VIEWPORT_TOP_MARGIN = 60;

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

/** Side of the doc text the pane currently sits on — used to colour the
 *  border facing the text red. cm-content is the actual text column so
 *  it stays correct under column-shift. */
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

/** Geometry of a gutter pane in viewport coordinates: top is the
 *  viewport y of the doc's scroll origin (negative when scrolled past
 *  it); height is the doc's full scrollable content height. */
function computeGutterFrame() {
  const scroller = getScroller();
  if (!scroller) return { y: 0, height: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  const y = rect.top - scroller.scrollTop;
  const height = Math.max(120, scroller.scrollHeight);
  return { y, height };
}

/** Reposition the gutter pane to follow the doc scroll. Cheap; runs on
 *  every scroll tick. Does not touch pane.height — resizing on every
 *  scroll fights CodeMirror's incremental-measurement and causes drift
 *  on long docs. Height is owned by applyGutterHeight + the ResizeObserver. */
function applyGutterY(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const y = rect.top - scroller.scrollTop;
  pane.y = y;
  pane.el.style.top = y + "px";
  // Notebook toolbar piggybacks on this CSS variable so it slides with
  // the doc scroll — see floating-pane.css.
  const scrollTop = scroller.scrollTop;
  pane.el.style.setProperty("--gutter-scroll", scrollTop + "px");
  // Pocket tray / entries are canvas-rendered, so they can't ride the
  // CSS variable. Plumb the same offset into the notebook state and
  // poke the render loop. viewportHeight clamps the tray so it doesn't
  // run off the bottom of a doc-tall canvas. Camera is also defensively
  // re-locked here in case something pushed y/zoom off.
  if (pane.notebook && pane.notebook.state) {
    const st = pane.notebook.state;
    st.topInset = scrollTop;
    st.viewportHeight = window.innerHeight;
    if (st.camera.y !== 0 || st.camera.zoom !== 1) {
      st.camera = { x: st.camera.x, y: 0, zoom: 1 };
    }
    st.notify("camera");
  }
}

/** Resize the gutter pane to track doc content height. Runs from the
 *  ResizeObserver on .cm-content. Skips imperceptible changes so a
 *  doc that fluctuates by sub-pixel amounts under CM virtualization
 *  doesn't churn the canvas backing. */
function applyGutterHeight(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  const height = Math.max(120, scroller.scrollHeight);
  if (Math.abs(pane.height - height) < 1) return;
  pane.height = height;
  pane.el.style.height = height + "px";
}

function applyGutterFrame(pane) {
  applyGutterHeight(pane);
  applyGutterY(pane);
}

function startGutterSync(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  pane._gutterScrollHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    applyGutterY(pane);
  };
  scroller.addEventListener("scroll", pane._gutterScrollHandler, { passive: true });

  // Doc content height changes — added paragraphs, image loads, etc. —
  // need to be reflected in the pane height so the gutter never trails
  // off short of the bottom of the text.
  const content = getContentEl();
  if (typeof ResizeObserver !== "undefined" && content) {
    pane._gutterResizeObs = new ResizeObserver(() => {
      if (!pane.gutter || !panes.has(pane.id)) return;
      applyGutterHeight(pane);
    });
    pane._gutterResizeObs.observe(content);
  }

  // Window resize moves the doc anchor in viewport space — recompute.
  pane._gutterWindowHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    applyGutterFrame(pane);
  };
  window.addEventListener("resize", pane._gutterWindowHandler);
}

function stopGutterSync(pane) {
  if (pane._gutterScrollHandler) {
    const scroller = getScroller();
    if (scroller) scroller.removeEventListener("scroll", pane._gutterScrollHandler);
    pane._gutterScrollHandler = null;
  }
  if (pane._gutterResizeObs) {
    try { pane._gutterResizeObs.disconnect(); } catch (_) {}
    pane._gutterResizeObs = null;
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
  // Gutter panes always sit below free-floating panes — the doc chrome
  // shouldn't cover the user's reference panes.
  pane.el.style.zIndex = GUTTER_Z;

  // Snap the notebook's camera so canvas-pixel-y == doc-content-y. The
  // gutterScrollDOM flag also flips pan / wheel / focusShape handlers
  // into doc-scroll mode — see state.ts.
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.camera = { x: 0, y: 0, zoom: 1 };
    pane.notebook.state.gutterScrollDOM = getScroller();
    pane.notebook.state.notify("camera");
  }

  applyGutterFrame(pane);
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
  // The pane was glued to the doc for the whole gutter session — drop
  // it back to the visible part of the viewport so it isn't stranded
  // off-screen when the user has scrolled deep into the document.
  const y = VIEWPORT_TOP_MARGIN;
  pane.y = y;
  pane.el.style.top = y + "px";
  pane.el.style.removeProperty("--gutter-scroll");
  // Reset the canvas-side pocket insets so the tray returns to its
  // canvas-anchored position, drop the gutter scroll-redirect flag,
  // and restore the camera the user had before they entered gutter
  // mode (snapshotted in _gutterPrev.camera).
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.topInset = 0;
    pane.notebook.state.viewportHeight = 0;
    pane.notebook.state.gutterScrollDOM = null;
    if (prev.camera) pane.notebook.state.camera = { ...prev.camera };
    pane.notebook.state.notify("camera");
  }
  // Lift the pane back into the bumped z-band; gutter z is fixed low.
  pane.el.style.zIndex = zForPane(pane);

  schedulePersist();
  return true;
}

/** Reapply gutter geometry — used by persistence restore so a pane that
 *  was in gutter mode at shutdown comes back in gutter mode after the
 *  pane DOM has been rebuilt, and by onContextChange so the geometry
 *  re-aligns when the pane re-enters its host doc. */
export function restoreGutterLayout(pane) {
  if (!pane || !pane.gutter || !pane.el) return;
  const side = pane.gutterSide || detectGutterSide(pane);
  pane.gutterSide = side;
  pane.el.classList.add("gutter", "gutter-" + side);
  pane.el.style.zIndex = GUTTER_Z;
  // The scroller behind the pane may have changed (different doc /
  // restored from disk) — repoint the canvas at the live one.
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = getScroller();
    pane.notebook.state.camera = { x: 0, y: 0, zoom: 1 };
    pane.notebook.state.notify("camera");
  }
  applyGutterFrame(pane);
  if (!pane._gutterScrollHandler) startGutterSync(pane);
}

/** Tear down the scroll/resize listeners on the way out — called from
 *  closePane and on context-switch so a hidden pane doesn't keep its
 *  scroll-redirect flag pointing at the wrong doc scroller. */
export function teardownGutterListeners(pane) {
  if (!pane) return;
  if (pane._gutterScrollHandler) stopGutterSync(pane);
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
  }
}
