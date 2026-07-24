/**
 * Desktop hover controls — the two icons that surface over a file
 * thumbnail on hover: open the file, and open it as a floating pane
 * (projects swap the pane icon for "Open Project Desktop", since panes
 * don't host projects).
 *
 * Pure DOM overlay above the canvas: the notebook engine stays unaware
 * of it. Position tracks the hovered shape's top-right corner in screen
 * space (constant size regardless of zoom); any camera / shape change
 * hides the overlay and the next pointermove re-anchors it.
 */

import { canvasToScreen, screenToCanvas, getShapeBounds } from "../notebook/utils.ts";
import { findShapeAtPoint } from "../notebook/state-helpers.ts";
import { stackBounds, stackMembers } from "./desktop-stacks.js";
import { applyTooltip } from "../tooltips.js";

const OPEN_ICON = `<svg viewBox="0 0 16 16"><path d="M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PANE_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.5"/></svg>`;
const GRID_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
// The sidebar's gutter glyph — vertical rules flanking a dot column.
const GUTTER_ICON = `<svg viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="13"/><line x1="12" y1="3" x2="12" y2="13"/></g><g fill="currentColor"><circle cx="8" cy="4" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="12" r="1"/></g></svg>`;

/**
 * Attach the hover controls to a Desktop canvas host.
 * `handlers.onOpen(fileRef)` / `handlers.onSecondary(fileRef, ev)` fire
 * on the two buttons. Returns a cleanup function.
 */
export function attachDesktopHover(canvasHost, notesCanvas, handlers) {
  const state = notesCanvas.state;
  const overlay = document.createElement("div");
  overlay.className = "desktop-hover hidden";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "desktop-hover-btn";
  openBtn.innerHTML = OPEN_ICON;
  applyTooltip(openBtn, "Open");

  const gutterBtn = document.createElement("button");
  gutterBtn.type = "button";
  gutterBtn.className = "desktop-hover-btn";
  gutterBtn.innerHTML = GUTTER_ICON;
  applyTooltip(gutterBtn, "Open with Gutter Visible");

  const secondaryBtn = document.createElement("button");
  secondaryBtn.type = "button";
  secondaryBtn.className = "desktop-hover-btn";

  overlay.appendChild(openBtn);
  overlay.appendChild(gutterBtn);
  overlay.appendChild(secondaryBtn);
  canvasHost.appendChild(overlay);

  // Name list shown below a thumbnail stack while hovering it — the
  // stacked thumbnails hide their own captions.
  const stackLabels = document.createElement("div");
  stackLabels.className = "desktop-stack-labels hidden";
  canvasHost.appendChild(stackLabels);

  let hoveredRef = null;
  let hoveredShapeId = null;

  const hide = () => {
    if (hoveredRef === null) return;
    hoveredRef = null;
    hoveredShapeId = null;
    overlay.classList.add("hidden");
    stackLabels.classList.add("hidden");
  };

  const showFor = (shape) => {
    hoveredRef = shape.fileRef;
    hoveredShapeId = shape.id;
    const isProject = shape.fileRef.kind === "project";
    secondaryBtn.innerHTML = isProject ? GRID_ICON : PANE_ICON;
    applyTooltip(secondaryBtn, isProject ? "Open Project Desktop" : "Open as pane");
    gutterBtn.style.display = shape.fileRef.kind === "doc" && shape.fileRef.hasGutter ? "" : "none";
    const bounds = getShapeBounds(shape, state.fontFamily);
    const corner = canvasToScreen({ x: bounds.maxX, y: bounds.minY }, state.camera);
    overlay.style.left = `${Math.round(corner.x)}px`;
    overlay.style.top = `${Math.round(corner.y)}px`;
    overlay.classList.remove("hidden");

    // Hovering any member of a stack lists the pile's names beneath it.
    const stackId = shape.fileRef.stackId;
    if (stackId) {
      const sb = stackBounds(state.shapes, stackId, state.fontFamily);
      if (sb) {
        stackLabels.textContent = "";
        for (const m of stackMembers(state.shapes, stackId)) {
          const row = document.createElement("div");
          row.className = "desktop-stack-label" + (m.id === shape.id ? " hovered" : "");
          row.textContent = m.fileRef?.name || m.name || "";
          stackLabels.appendChild(row);
        }
        const anchor = canvasToScreen({ x: (sb.minX + sb.maxX) / 2, y: sb.maxY }, state.camera);
        stackLabels.style.left = `${Math.round(anchor.x)}px`;
        stackLabels.style.top = `${Math.round(anchor.y + 8)}px`;
        stackLabels.classList.remove("hidden");
      }
    } else {
      stackLabels.classList.add("hidden");
    }
  };

  const onPointerMove = (e) => {
    if (overlay.contains(e.target)) return; // stay put while over the buttons
    // Only the select tool hovers — text / drag-area / pen input owns
    // the pointer for its own gesture.
    if (state.tool !== "select" || state.isPanning || state.editingText) { hide(); return; }
    if (state.selectionBox) { hide(); return; }
    const rect = canvasHost.getBoundingClientRect();
    const world = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);
    const hit = findShapeAtPoint(world, state.shapes, state.fontFamily);
    if (hit && hit.type === "image" && hit.fileRef && !hit.pocketed) {
      if (hit.id !== hoveredShapeId) showFor(hit);
      return;
    }
    hide();
  };

  const onPointerLeave = (e) => {
    if (e.relatedTarget && overlay.contains(e.relatedTarget)) return;
    hide();
  };

  // Any camera pan / zoom or shape mutation invalidates the anchor —
  // hide and let the next pointermove re-place it.
  const onStateChange = (e) => {
    const keys = e.detail?.keys || [];
    if (keys.includes("camera") || keys.includes("shapes") || keys.includes("tool")) hide();
  };

  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hoveredRef) handlers.onOpen(hoveredRef, e);
  });
  gutterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hoveredRef) handlers.onOpenWithGutter?.(hoveredRef, e);
  });
  secondaryBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hoveredRef) handlers.onSecondary(hoveredRef, e);
  });
  // Keep clicks on the overlay from reaching the canvas as a marquee /
  // deselect gesture.
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());

  canvasHost.addEventListener("pointermove", onPointerMove);
  canvasHost.addEventListener("pointerleave", onPointerLeave);
  state.addEventListener("change", onStateChange);

  return () => {
    canvasHost.removeEventListener("pointermove", onPointerMove);
    canvasHost.removeEventListener("pointerleave", onPointerLeave);
    state.removeEventListener("change", onStateChange);
    overlay.remove();
    stackLabels.remove();
  };
}
