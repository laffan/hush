/**
 * Pane drag (titlebar) and resize (edge / corner handles). Both wire
 * pointer-down/move/up sequences with PointerCapture so the gesture
 * survives leaving the pane bounds. Notebook-attached panes translate
 * screen deltas into world coords via the camera zoom.
 *
 * Drag also drives the dock workflow — while the user drags the title
 * bar, four highlighted drop zones (left / right / top / bottom) paint
 * inside the canvas. Releasing inside a zone calls
 * `dockPane(pane, edge)`; releasing outside leaves the pane wherever
 * the drag ended. Dragging the title of an already docked pane
 * undocks it first.
 */
import {
  appState,
  notebookBridge,
  panes,
  containerEl,
  zForPane,
  TITLEBAR_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} from "./pane-state.js";
import {
  dockPane,
  undockPane,
  dropZoneAt,
  isDocked,
  applyDockGeometry,
  reflowAllDockedPanes,
  getLeftInset,
  getRightInset,
  getTopInset,
  getBottomInset,
} from "./pane-dock.js";
import { detachInlinePane, syncInlinePaneSize } from "./pane-inline.js";
import { applyPaneFontSize } from "./pane-size-popover.js";

let _dockOverlay = null;

function ensureDockOverlay() {
  if (_dockOverlay) return _dockOverlay;
  const root = document.createElement("div");
  root.className = "pane-dock-overlay";
  for (const edge of ["left", "right", "top", "bottom"]) {
    const z = document.createElement("div");
    z.className = `pane-dock-zone pane-dock-zone-${edge}`;
    z.dataset.edge = edge;
    root.appendChild(z);
  }
  document.body.appendChild(root);
  _dockOverlay = root;
  return root;
}

function showDockOverlay(show) {
  const overlay = ensureDockOverlay();
  overlay.classList.toggle("visible", show);
  if (show) positionDockZones();
  if (!show) {
    for (const z of overlay.querySelectorAll(".pane-dock-zone")) {
      z.classList.remove("near");
    }
  }
}

/** Reveal each drop zone only while the cursor is within `NEAR_PX` of
 *  its matching edge so the four blue trapezoids surface lazily as the
 *  user approaches a corner instead of flooding the canvas for the
 *  entire drag. The left edge is measured from the sidebar's right
 *  edge (containerEl.left + leftInset), not the window edge, so a
 *  sidebar-spanning drag doesn't trip the left zone halfway across. */
const DOCK_ZONE_NEAR_PX = 200;
function updateDockZoneProximity(clientX, clientY) {
  if (!_dockOverlay || !containerEl) return;
  const r = containerEl.getBoundingClientRect();
  const distLeft = clientX - (r.left + getLeftInset());
  const distRight = (r.right - getRightInset()) - clientX;
  const distTop = clientY - (r.top + getTopInset());
  const distBottom = (r.bottom - getBottomInset()) - clientY;
  const set = (sel, near) => {
    const el = _dockOverlay.querySelector(sel);
    if (el) el.classList.toggle("near", near);
  };
  set(".pane-dock-zone-left", distLeft >= 0 && distLeft <= DOCK_ZONE_NEAR_PX);
  set(".pane-dock-zone-right", distRight >= 0 && distRight <= DOCK_ZONE_NEAR_PX);
  set(".pane-dock-zone-top", distTop >= 0 && distTop <= DOCK_ZONE_NEAR_PX);
  set(".pane-dock-zone-bottom", distBottom >= 0 && distBottom <= DOCK_ZONE_NEAR_PX);
}

function positionDockZones() {
  if (!_dockOverlay || !containerEl) return;
  const r = containerEl.getBoundingClientRect();
  const overlay = _dockOverlay;
  Object.assign(overlay.style, {
    position: "fixed",
    left: r.left + "px", top: r.top + "px",
    width: r.width + "px", height: r.height + "px",
    pointerEvents: "none",
    zIndex: "9999",
  });
  const ZONE = 50;
  const leftInset = getLeftInset();
  const rightInset = getRightInset();
  const topInset = getTopInset();
  const bottomInset = getBottomInset();
  const left = overlay.querySelector(".pane-dock-zone-left");
  const right = overlay.querySelector(".pane-dock-zone-right");
  const top = overlay.querySelector(".pane-dock-zone-top");
  const bottom = overlay.querySelector(".pane-dock-zone-bottom");
  // Trapezoid layout: each zone's outer edge sits flush with the
  // container edge and its inner edge is inset by ZONE on the docked
  // axis. The cross-axis edges fan out diagonally at 45° from each
  // corner so neighbouring trapezoids meet along a shared diagonal
  // and tile the corners with no overlap or gap. Each zone div fills
  // the whole overlay and uses clip-path to carve out its shape.
  const oL = leftInset, oR = r.width - rightInset;
  const oT = topInset, oB = r.height - bottomInset;
  const iL = oL + ZONE, iR = oR - ZONE;
  const iT = oT + ZONE, iB = oB - ZONE;
  const fill = { left: "0px", top: "0px", width: r.width + "px", height: r.height + "px" };
  if (left) {
    Object.assign(left.style, fill);
    left.style.clipPath = `polygon(${oL}px ${oT}px, ${iL}px ${iT}px, ${iL}px ${iB}px, ${oL}px ${oB}px)`;
  }
  if (right) {
    Object.assign(right.style, fill);
    right.style.clipPath = `polygon(${oR}px ${oT}px, ${oR}px ${oB}px, ${iR}px ${iB}px, ${iR}px ${iT}px)`;
  }
  if (top) {
    Object.assign(top.style, fill);
    top.style.clipPath = `polygon(${oL}px ${oT}px, ${oR}px ${oT}px, ${iR}px ${iT}px, ${iL}px ${iT}px)`;
  }
  if (bottom) {
    Object.assign(bottom.style, fill);
    bottom.style.clipPath = `polygon(${oL}px ${oB}px, ${iL}px ${iB}px, ${iR}px ${iB}px, ${oR}px ${oB}px)`;
  }
}

function highlightDockZone(edge) {
  if (!_dockOverlay) return;
  for (const z of _dockOverlay.querySelectorAll(".pane-dock-zone")) {
    z.classList.toggle("active", z.dataset.edge === edge);
  }
}

export function setupPaneDrag(pane, deps) {
  const { createPane, getCurrentContext, schedulePersist, focusPane } = deps;
  let startX, startY, startLeft, startTop, startCanvasX, startCanvasY;

  pane._titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".floating-pane-btn, .fp-title-link")) return;
    // Gutter panes can't be dragged — their geometry is doc-driven (full
    // height, docked to a side the user picks via the <-> toggle). Let the
    // pointerdown fall through to the el-level focus handler without starting
    // a drag.
    if (pane.gutter) return;
    e.preventDefault();
    e.stopPropagation();
    // Moving the pane by hand retires the geometry ⌘-double-click saved:
    // restoring to where the pane sat two gestures ago would read as the
    // pane jumping somewhere the user never put it.
    pane._stretchRestore = null;
    startX = e.clientX;
    startY = e.clientY;
    // Dragging a docked pane undocks it first — keep its current screen
    // size, recenter on the cursor so the drag feels natural.
    if (isDocked(pane)) {
      const beforeRect = pane.el.getBoundingClientRect();
      const cur = { x: pane.x, y: pane.y, w: pane.width, h: pane.height };
      undockPane(pane);
      // After undock the pane snaps to the pre-dock pos/size. Override
      // to the cursor-centered position so the drag continues smoothly.
      pane.width = cur.w;
      pane.height = Math.min(cur.h, 360); // cap the snapped height
      pane.x = e.clientX - pane.width / 2 - beforeRect.left + cur.x;
      pane.y = e.clientY - TITLEBAR_HEIGHT / 2;
      Object.assign(pane.el.style, {
        left: pane.x + "px", top: pane.y + "px",
        width: pane.width + "px", height: pane.height + "px",
      });
    }
    startLeft = pane.el.offsetLeft;
    startTop = pane.el.offsetTop;
    // Alt/Option-drag duplicates the pane and drags the COPY, leaving the
    // original untouched where it sat. `dragTarget` is what the rest of
    // this gesture moves / docks / focuses.
    let dragTarget = pane;
    if (e.altKey) {
      // createPane runs its DOM build + `panes.set` synchronously before
      // its first await, so the freshly-created clone is already in the
      // `panes` map the instant the (un-awaited) call returns — capture it
      // by diffing the key set.
      const before = new Set(panes.keys());
      createPane(pane.fileId, pane.fileName, pane.fileType,
        startLeft + pane.width / 2, startTop + TITLEBAR_HEIGHT / 2,
        { allowDuplicate: true, ownerContext: getCurrentContext(), skipFocus: true });
      let clone = null;
      for (const [id, pv] of panes) { if (!before.has(id)) { clone = pv; break; } }
      // Raise the original first so the clone — whose z is bumped *after*
      // this (zForPane is a monotonically increasing counter) — lands
      // ABOVE it while it's dragged away.
      pane.el.style.zIndex = zForPane(pane);
      if (clone && clone.el) {
        // Make the copy a faithful stand-in for the original — same size,
        // same per-pane font size — and start it exactly on top of the
        // original so it tracks the cursor seamlessly from the grab point.
        clone.width = pane.width;
        clone.height = pane.height;
        clone.x = startLeft;
        clone.y = startTop;
        clone.fontSize = pane.fontSize; // undefined clears back to default
        Object.assign(clone.el.style, {
          left: clone.x + "px", top: clone.y + "px",
          width: clone.width + "px", height: clone.height + "px",
          zIndex: zForPane(clone),
        });
        applyPaneFontSize(clone);
        dragTarget = clone;
      }
    }
    if (pane.attached && appState.currentNotebookFileId) {
      startCanvasX = pane._canvasX;
      startCanvasY = pane._canvasY;
    }
    pane._titlebar.setPointerCapture(e.pointerId);
    showDockOverlay(true);

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      // Inline panes detach into normal floating panes as soon as the
      // user drags the title bar past a small jitter threshold. After
      // detach, the rest of the drag pipeline runs as if the pane had
      // always been floating, so make-space (lateral column shift)
      // kicks in automatically through deps.notifyPaneDragMove().
      // Branch on `dragTarget`: an Alt-drag clone is always a fresh
      // floating pane (never inline / attached / docked), so it falls
      // through to the plain-move `else` below and the original's
      // inline/attached bodies (which reference `pane`) only run for a
      // normal drag, where `dragTarget === pane`.
      if (dragTarget.inline && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        const rect = pane.el.getBoundingClientRect();
        // Keep the title bar pinned under the cursor by preserving the
        // pointer's offset relative to pane.el at drag start.
        const newScreenX = me.clientX - (startX - rect.left);
        const newScreenY = me.clientY - (startY - rect.top);
        detachInlinePane(pane, containerEl, newScreenX, newScreenY);
        if (appState && typeof appState.emit === "function") {
          appState.emit("panes-changed");
        }
        // Re-baseline the drag against the new floating position so the
        // remaining pointermove deltas track from where the pane sits now.
        startX = me.clientX;
        startY = me.clientY;
        startLeft = pane.x;
        startTop = pane.y;
        deps.notifyPaneDragMove?.();
        return;
      }
      if (dragTarget.attached && appState.currentNotebookFileId) {
        const canvas = notebookBridge?.getCanvasInstance();
        const zoom = canvas ? canvas.state.camera.zoom : 1;
        pane._canvasX = startCanvasX + dx / zoom;
        pane._canvasY = startCanvasY + dy / zoom;
      } else if (dragTarget.attached && !appState.currentNotebookFileId) {
        pane.x = startLeft + dx;
        pane.y = startTop + dy;
        pane._scrollRelY = pane.y + (appState.editor?.view.scrollDOM.scrollTop || 0);
        pane.el.style.left = pane.x + "px";
        pane.el.style.top = pane.y + "px";
      } else {
        dragTarget.x = startLeft + dx;
        dragTarget.y = startTop + dy;
        dragTarget.el.style.left = dragTarget.x + "px";
        dragTarget.el.style.top = dragTarget.y + "px";
      }
      updateDockZoneProximity(me.clientX, me.clientY);
      highlightDockZone(dropZoneAt(me.clientX, me.clientY));
      // Live-refresh the editor column so the auto make-space follows
      // the pane as the user drags it. notifyPaneDragMove updates
      // visiblePaneCentroid + triggers the column resize handler.
      deps.notifyPaneDragMove?.();
    };

    const onUp = (ue) => {
      pane._titlebar.removeEventListener("pointermove", onMove);
      pane._titlebar.removeEventListener("pointerup", onUp);
      // A still-inline pane on release means the pointer didn't travel
      // far enough to detach — treat as a click on the title bar (no
      // dock attempt, no persist hit). Dock the dragged target (the clone
      // for an Alt-drag, otherwise the pane itself).
      if (!dragTarget.inline) {
        const edge = dropZoneAt(ue.clientX, ue.clientY);
        if (edge) dockPane(dragTarget, edge);
      }
      // Hand focus to the dragged copy so the pane the user just placed
      // becomes the active one (the clone was created with skipFocus).
      if (dragTarget !== pane && typeof focusPane === "function") focusPane(dragTarget.id);
      showDockOverlay(false);
      highlightDockZone(null);
      schedulePersist();
    };

    pane._titlebar.addEventListener("pointermove", onMove);
    pane._titlebar.addEventListener("pointerup", onUp);
  });
}

export function setupPaneResize(pane, deps) {
  const { schedulePersist } = deps;
  for (const handle of pane.el.querySelectorAll(".fp-resize")) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = handle.dataset.dir;
      // Docked panes only allow resize on the edge opposite the dock,
      // and only on the perpendicular axis. Other directional handles
      // are ignored.
      if (isDocked(pane)) {
        const allowed = allowedDockResizeDir(pane.dockEdge);
        if (dir !== allowed) return;
      }
      // Same reasoning as the drag path: a hand-set size supersedes the
      // pre-stretch geometry.
      pane._stretchRestore = null;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = pane.width;
      const startH = pane.height;
      const startLeft = pane.x;
      const startTop = pane.y;
      let zoomFactor = 1;
      if (pane.attached && appState && appState.currentNotebookFileId) {
        const canvas = notebookBridge ? notebookBridge.getCanvasInstance() : null;
        if (canvas) zoomFactor = canvas.state.camera.zoom || 1;
      }

      handle.setPointerCapture(e.pointerId);

      // For docked panes the heavy work (applyDockGeometry +
      // reflowAllDockedPanes + the editor column reflow downstream of
      // notifyPaneDragMove) runs on every pointermove. Coalesce it to
      // one pass per animation frame so a fast drag doesn't stack 60+
      // synchronous layouts per second.
      let dockFramePending = false;
      const flushDockLayout = () => {
        dockFramePending = false;
        applyDockGeometry(pane);
        reflowAllDockedPanes();
        deps.notifyPaneDragMove?.();
      };

      const onMove = (me) => {
        const dx = (me.clientX - startX) / zoomFactor;
        const dy = (me.clientY - startY) / zoomFactor;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = Math.max(MIN_WIDTH, startW + dx);
        if (dir.includes("w")) { w = Math.max(MIN_WIDTH, startW - dx); nx = startLeft + (startW - w) * zoomFactor; }
        if (dir.includes("s")) h = Math.max(MIN_HEIGHT, startH + dy);
        if (dir.includes("n")) { h = Math.max(MIN_HEIGHT, startH - dy); ny = startTop + (startH - h) * zoomFactor; }
        pane.width = w; pane.height = h; pane.x = nx; pane.y = ny;
        if (isDocked(pane)) {
          if (pane.dockEdge === "top" || pane.dockEdge === "bottom") pane.dockUserSize = h;
          else pane.dockUserSize = w;
          // Perpendicular siblings need to re-flex when this dock's
          // cross-axis footprint changes — a wider left-dock means a
          // narrower top-dock width. Coalesced via rAF so a fast drag
          // doesn't stack synchronous layouts per pointermove.
          if (!dockFramePending) {
            dockFramePending = true;
            requestAnimationFrame(flushDockLayout);
          }
          return;
        }
        // Inline panes are laid out in-flow inside a CM block widget —
        // we update pane.el's size and ask the main editor to re-measure
        // so the text below shifts in lockstep.
        if (pane.inline) {
          if (pane.inline) pane.inline.height = h;
          const mainView = appState?.editor?.view;
          syncInlinePaneSize(pane, mainView);
          deps.notifyPaneDragMove?.();
          return;
        }
        Object.assign(pane.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
        // Floating pane resize shifts the centroid — let the editor
        // column re-balance live so make-space follows the change.
        deps.notifyPaneDragMove?.();
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        schedulePersist();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}

/** Map dock edge to the single resize handle direction that's still
 *  active when the pane is docked. */
function allowedDockResizeDir(edge) {
  switch (edge) {
    case "top": return "s";
    case "bottom": return "n";
    case "left": return "e";
    case "right": return "w";
    default: return "";
  }
}

// Re-export the count of panes so the manager can reflow docks on
// sidebar / window changes — caller registers this once.
export { panes };
