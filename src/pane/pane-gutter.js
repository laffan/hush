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
import { panes, activePaneId, appState } from "./pane-state.js";
import { stopAttachSync } from "./pane-attach-sync.js";
import { schedulePersist } from "./pane-persistence.js";

const VIEWPORT_TOP_MARGIN = 60;

export function canUseActivePaneAsGutter() {
  if (!appState || appState.currentNotebookFileId) return false;
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || pane.fileType !== "notebook") return false;
  return !pane.gutter;
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

function applyGutterFrame(pane) {
  const { y, height } = computeGutterFrame();
  pane.y = y;
  pane.height = height;
  pane.el.style.top = y + "px";
  pane.el.style.height = height + "px";
}

function startGutterSync(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  pane._gutterScrollHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    applyGutterFrame(pane);
  };
  scroller.addEventListener("scroll", pane._gutterScrollHandler);

  // Doc content height changes — added paragraphs, image loads, etc. —
  // need to be reflected in the pane height so the gutter never trails
  // off short of the bottom of the text.
  const content = getContentEl();
  if (typeof ResizeObserver !== "undefined" && content) {
    pane._gutterResizeObs = new ResizeObserver(() => {
      if (!pane.gutter || !panes.has(pane.id)) return;
      applyGutterFrame(pane);
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
  };

  const side = detectGutterSide(pane);
  pane.gutter = true;
  pane.gutterSide = side;
  pane.el.classList.add("gutter", "gutter-" + side);
  pane.el.classList.remove("gutter-" + (side === "left" ? "right" : "left"));

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
  applyGutterFrame(pane);
  if (!pane._gutterScrollHandler) startGutterSync(pane);
}

/** Tear down the scroll/resize listeners on the way out — called from
 *  closePane so a pane being destroyed mid-gutter doesn't leak. */
export function teardownGutterListeners(pane) {
  if (pane && pane._gutterScrollHandler) stopGutterSync(pane);
}
