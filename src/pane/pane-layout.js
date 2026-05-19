/**
 * Pane positioning helpers — initial coords for "Open as pane",
 * "fit to gap" for the active pane, and viewport recentring used by
 * the shelf's focus action. Extracted from pane-manager.js.
 */

import {
  appState,
  panes,
  notebookBridge,
  DEFAULT_WIDTH, MIN_WIDTH, MIN_HEIGHT,
} from "./pane-state.js";
import { schedulePersist } from "./pane-persistence.js";

/** Width occupied by the sidebar — just the files panel when it sits in
 *  the layout (pinned or inset modes). Pure hover overlays don't count
 *  because they retract on mouse-out. Free-floating pane code uses this
 *  when picking initial coordinates so a fresh pane lands past the
 *  sidebar instead of underneath it. */
function getSidebarInset() {
  const panelEl = document.getElementById("panel-overlay");
  const panelOpen = panelEl && !panelEl.classList.contains("hidden");
  const panelLayout = panelEl
    && (panelEl.classList.contains("panel-inset")
      || panelEl.classList.contains("panel-pinned"));
  return panelOpen && panelLayout
    ? parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300
    : 0;
}

/** "Make space for panes" pushes the editor column to one side and
 *  leaves a gap on the other. Panes belong in that gap — opposite the
 *  shifted column. Returns "left" or "right" (the side the pane should
 *  sit on). Defaults to "left" so behaviour matches the historical
 *  hard-coded x=62 placement when settings haven't been touched. */
function getPaneSide(state) {
  return (state?.settings?.makeSpaceDirection === "left") ? "right" : "left";
}

/** Top-left coordinate for a freshly-opened pane. Clears the sidebar on
 *  the left, the right panel on the right, and obeys the column-shift
 *  setting so panes appear in the empty gap rather than over the text.
 *  Used by every "Open as pane" / "New … as pane" entry point. */
export function getInitialPanePosition(state, w = DEFAULT_WIDTH) {
  const sideMargin = 12;
  const topMargin = 60;
  const side = getPaneSide(state);
  let x;
  if (side === "left") {
    x = getSidebarInset() + sideMargin;
  } else {
    const rightPanelEl = document.querySelector(".right-panel");
    const rightOpen = rightPanelEl && rightPanelEl.classList.contains("visible");
    const rightInset = rightOpen ? 200 : 0;
    x = window.innerWidth - w - rightInset - sideMargin;
  }
  return { x: Math.max(0, x), y: topMargin };
}

/**
 * Auto-fit the active pane to the empty zone next to the writing
 * surface. In a doc the pane fills the gap that the "make space for
 * panes" layout opens up beside the text column; in a notebook there's
 * no text column to anchor against, so the pane takes a flat 1/3 of the
 * window width. The pane sits flush against the gutter (clearing the
 * sidebar on the left, the right-panel inset on the right) and stretches
 * to the full vertical viewport. Honours the user's column-shift setting.
 */
export function fitActivePaneToGap(activePaneId) {
  if (!activePaneId || !appState) return false;
  const pane = panes.get(activePaneId);
  if (!pane) return false;

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const sideMargin = 12;
  const topMargin = 35;
  const bottomMargin = 12;
  const leftEdge = getSidebarInset();
  const side = getPaneSide(appState);

  let w;
  if (appState.currentNotebookFileId) {
    w = Math.round(viewportW / 3);
  } else {
    // Doc mode: read the live padding from the scroller so the pane fits
    // exactly the gap that the column shift has opened up.
    const scroller = document.querySelector("#editor-container .cm-scroller");
    const cs = scroller ? getComputedStyle(scroller) : null;
    const padPx = side === "left"
      ? (cs ? parseFloat(cs.paddingLeft) || 0 : 0)
      : (cs ? parseFloat(cs.paddingRight) || 0 : 0);
    const inset = side === "left" ? leftEdge : 0;
    w = padPx - inset - sideMargin * 2;
  }
  w = Math.max(MIN_WIDTH, w);

  const x = side === "left"
    ? leftEdge + sideMargin
    : viewportW - w - sideMargin;
  const h = Math.max(MIN_HEIGHT, viewportH - topMargin - bottomMargin);
  const y = topMargin;

  if (pane.collapsed) {
    pane.collapsed = false;
    pane.el.classList.remove("collapsed");
  }
  pane.width = w;
  pane.height = h;
  pane.x = x;
  pane.y = y;
  Object.assign(pane.el.style, {
    width: w + "px",
    height: h + "px",
    left: x + "px",
    top: y + "px",
  });
  schedulePersist();
  return true;
}

/** Reposition a pane so it sits at the centre of the viewport. For
 *  canvas-attached panes this pans the camera (cheaper than dragging the
 *  pane through canvas-space coordinates); for free-floating panes it's
 *  a plain element move. Used by `focusAndCenterPaneById` /
 *  `scrollPaneToMatch` so the shelf can bring a clicked pane into view. */
export function centerPaneInViewport(pane) {
  const targetX = Math.max(0, Math.round((window.innerWidth - pane.width) / 2));
  const targetY = Math.max(0, Math.round((window.innerHeight - pane.height) / 2));

  if (pane.attached) {
    const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
    if (canvas && pane._canvasX != null && pane._canvasY != null) {
      // Attached panes live in canvas coords; pan the camera so the
      // pane's anchor lands at the desired screen position. The next
      // canvas-sync tick will reconcile pane.x/y, but we set them now
      // so the pane doesn't visibly snap on the following frame.
      const cam = canvas.state.camera;
      canvas.state.camera = {
        ...cam,
        x: targetX - pane._canvasX * cam.zoom,
        y: targetY - pane._canvasY * cam.zoom,
      };
      canvas.state.notify("camera");
      pane.x = targetX;
      pane.y = targetY;
      pane.el.style.left = targetX + "px";
      pane.el.style.top = targetY + "px";
      return;
    }
  }
  // Free-floating pane — just move the element.
  pane.x = targetX;
  pane.y = targetY;
  pane.el.style.left = targetX + "px";
  pane.el.style.top = targetY + "px";
  schedulePersist();
}
