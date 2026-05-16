/**
 * "Use Pane as Gutter" — promote an active notebook pane to a tall
 * sidebar pinned alongside the doc text. Stores the pane's prior
 * layout so "Stop using Pane as Gutter" can restore it.
 *
 * Only applies in a Doc context with the active pane backed by a
 * notebook — the gutter is meant to host visual notes that ride
 * alongside long-form writing.
 */
import { panes, activePaneId, appState } from "./pane-state.js";
import { stopAttachSync } from "./pane-attach-sync.js";
import { schedulePersist } from "./pane-persistence.js";

const VIEWPORT_TOP_MARGIN = 60;
const GUTTER_BOTTOM_MARGIN = 12;

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

/** Side of the doc text the pane currently sits on — used to colour the
 *  border facing the text red. cm-content is the actual text column so
 *  it stays correct under column-shift. */
function detectGutterSide(pane) {
  const content = document.querySelector("#editor-container .cm-content");
  let textCenter = window.innerWidth / 2;
  if (content) {
    const cr = content.getBoundingClientRect();
    if (cr.width > 0) textCenter = cr.left + cr.width / 2;
  }
  const paneCenter = pane.x + pane.width / 2;
  return paneCenter < textCenter ? "left" : "right";
}

function docTextGeometry() {
  const scroller = document.querySelector("#editor-container .cm-scroller");
  if (!scroller) return { y: 0, h: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  const y = Math.max(0, rect.top);
  const h = Math.max(120, rect.height - GUTTER_BOTTOM_MARGIN);
  return { y, h };
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

  const { y, h } = docTextGeometry();
  const side = detectGutterSide(pane);
  pane.gutter = true;
  pane.gutterSide = side;
  pane.y = y;
  pane.height = h;
  pane.el.style.top = y + "px";
  pane.el.style.height = h + "px";
  pane.el.classList.add("gutter", "gutter-" + side);
  pane.el.classList.remove("gutter-" + (side === "left" ? "right" : "left"));

  schedulePersist();
  return true;
}

export function stopActivePaneAsGutter() {
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || !pane.gutter || !pane.el) return false;

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
  // The pane was glued to the top of the doc for the whole gutter
  // session — drop it back to the visible part of the viewport so it
  // isn't stranded off-screen when the user has scrolled deep into the
  // document.
  const y = VIEWPORT_TOP_MARGIN;
  pane.y = y;
  pane.el.style.top = y + "px";

  schedulePersist();
  return true;
}

/** Reapply gutter geometry — used by persistence restore so a pane that
 *  was in gutter mode at shutdown comes back in gutter mode after the
 *  pane DOM has been rebuilt. */
export function restoreGutterLayout(pane) {
  if (!pane || !pane.gutter || !pane.el) return;
  const { y, h } = docTextGeometry();
  const side = pane.gutterSide || detectGutterSide(pane);
  pane.y = y;
  pane.height = h;
  pane.gutterSide = side;
  pane.el.style.top = y + "px";
  pane.el.style.height = h + "px";
  pane.el.classList.add("gutter", "gutter-" + side);
}
