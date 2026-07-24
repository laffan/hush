/**
 * Desktop hover controls — everything that surfaces over a file
 * thumbnail on hover:
 *
 *  - the action icons (open / open-as-pane; docs with a paired gutter
 *    add "Open with Gutter Visible"; nested projects swap the pane icon
 *    for "Open Project Desktop"),
 *  - the filename label (labels are hover-only on Desktops — a single
 *    thumbnail shows its name centred beneath it),
 *  - a pile's title list (left-aligned beneath the stack): clicking a
 *    title moves that member to the top of the stack.
 *
 * Pure DOM overlay above the canvas; the notebook engine stays unaware
 * of it. Positions track the hovered shape in screen space; camera or
 * foreign shape changes hide the overlay and the next pointermove
 * re-anchors it (the click-to-top reorder's own write is exempted via
 * a suppression counter).
 */

import { canvasToScreen, screenToCanvas, getShapeBounds } from "../notebook/utils.ts";
import { findShapeAtPoint } from "../notebook/state-helpers.ts";
import { stackBounds, stackMembers, moveToTopOfStack } from "./desktop-stacks.js";
import { raisedLast } from "./desktop-content.js";
import { applyTooltip } from "../tooltips.js";

const OPEN_ICON = `<svg viewBox="0 0 16 16"><path d="M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PANE_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.5"/></svg>`;
const GRID_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
// The sidebar's gutter glyph — vertical rules flanking a dot column.
const GUTTER_ICON = `<svg viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="13"/><line x1="12" y1="3" x2="12" y2="13"/></g><g fill="currentColor"><circle cx="8" cy="4" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="12" r="1"/></g></svg>`;
// Outline glyph — indented list lines (dot + bar per row).
const OUTLINE_ICON = `<svg viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="3" y1="4" x2="13" y2="4"/><line x1="5" y1="8" x2="13" y2="8"/><line x1="5" y1="12" x2="11" y2="12"/></g></svg>`;

/**
 * Attach the hover controls to a Desktop canvas host.
 * `handlers.onOpen / onSecondary / onOpenWithGutter` fire on the
 * buttons; `opts.showLabels()` gates the single-thumbnail hover label
 * (the per-Desktop "Thumbnail labels" option). Returns a cleanup fn.
 */
export function attachDesktopHover(canvasHost, notesCanvas, handlers, opts = {}) {
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

  const outlineBtn = document.createElement("button");
  outlineBtn.type = "button";
  outlineBtn.className = "desktop-hover-btn";
  outlineBtn.innerHTML = OUTLINE_ICON;

  const secondaryBtn = document.createElement("button");
  secondaryBtn.type = "button";
  secondaryBtn.className = "desktop-hover-btn";

  overlay.appendChild(openBtn);
  overlay.appendChild(outlineBtn);
  overlay.appendChild(gutterBtn);
  overlay.appendChild(secondaryBtn);
  canvasHost.appendChild(overlay);

  // Single-thumbnail hover caption (labels are hover-only on Desktops).
  // Two lines: the filename, plus — over a stack thumbnail — the name of
  // the constituent slice under the pointer.
  const labelEl = document.createElement("div");
  labelEl.className = "desktop-hover-label hidden";
  const labelName = document.createElement("div");
  labelName.className = "desktop-hover-label-name";
  const labelSlice = document.createElement("div");
  labelSlice.className = "desktop-hover-label-slice";
  labelEl.appendChild(labelName);
  labelEl.appendChild(labelSlice);
  canvasHost.appendChild(labelEl);

  // Pile title list — interactive: click a row to move that member to
  // the top of the stack.
  const stackLabels = document.createElement("div");
  stackLabels.className = "desktop-stack-labels hidden";
  canvasHost.appendChild(stackLabels);

  let hoveredRef = null;
  let hoveredShapeId = null;
  // > 0 while our own shape write (click-to-top reorder) is in flight,
  // so the change listener doesn't treat it as a foreign edit and hide
  // the overlay before the title list rebuilds.
  let ownWrites = 0;

  const hide = () => {
    if (hoveredRef === null) return;
    hoveredRef = null;
    hoveredShapeId = null;
    overlay.classList.add("hidden");
    labelEl.classList.add("hidden");
    stackLabels.classList.add("hidden");
  };

  const showStackList = (stackId, hoveredId) => {
    const sb = stackBounds(state.shapes, stackId, state.fontFamily);
    if (!sb) { stackLabels.classList.add("hidden"); return; }
    stackLabels.textContent = "";
    for (const m of stackMembers(state.shapes, stackId)) {
      const row = document.createElement("div");
      row.className = "desktop-stack-label" + (m.id === hoveredId ? " hovered" : "");
      row.textContent = m.fileRef?.name || m.name || "";
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        ownWrites++;
        state.shapes = moveToTopOfStack(state.shapes, m.id);
        state.recordHistory();
        state.notify("shapes");
        queueMicrotask(() => { ownWrites--; });
        handlers.onStacksChanged?.();
        showStackList(stackId, m.id); // rebuild in the new order
      });
      stackLabels.appendChild(row);
    }
    // Left-aligned with the pile's left edge, just below it.
    const anchor = canvasToScreen({ x: sb.minX, y: sb.maxY }, state.camera);
    stackLabels.style.left = `${Math.round(anchor.x)}px`;
    stackLabels.style.top = `${Math.round(anchor.y + 8)}px`;
    stackLabels.classList.remove("hidden");
  };

  const showFor = (shape) => {
    hoveredRef = shape.fileRef;
    hoveredShapeId = shape.id;
    const isProject = shape.fileRef.kind === "project";
    secondaryBtn.innerHTML = isProject ? GRID_ICON : PANE_ICON;
    applyTooltip(secondaryBtn, isProject ? "Open Project Desktop" : "Open as pane");
    gutterBtn.style.display = shape.fileRef.kind === "doc" && shape.fileRef.hasGutter ? "" : "none";
    // Outline toggle — docs only.
    const isDoc = shape.fileRef.kind === "doc";
    outlineBtn.style.display = isDoc ? "" : "none";
    if (isDoc) {
      const on = !!shape.fileRef.outline || (opts.hasOutlineRows && opts.hasOutlineRows(shape.fileRef.key));
      applyTooltip(outlineBtn, on ? "Hide outline" : "Show outline");
      outlineBtn.classList.toggle("active", on);
    }
    const bounds = getShapeBounds(shape, state.fontFamily);
    // Anchor top-right — but a doc showing its outline anchors to the
    // page's right edge instead, so the buttons don't sit on top of the
    // column's first heading rows and swallow their clicks.
    const anchorX = shape.fileRef.outlineX
      ? shape.position.x + shape.fileRef.outlineX
      : bounds.maxX;
    const corner = canvasToScreen({ x: anchorX, y: bounds.minY }, state.camera);
    overlay.style.left = `${Math.round(corner.x)}px`;
    overlay.style.top = `${Math.round(corner.y)}px`;
    overlay.classList.remove("hidden");

    const stackId = shape.fileRef.stackId;
    if (stackId) {
      labelEl.classList.add("hidden");
      showStackList(stackId, shape.id);
    } else {
      stackLabels.classList.add("hidden");
      if (opts.showLabels ? opts.showLabels() !== false : true) {
        labelName.textContent = shape.fileRef.name || shape.name || "";
        labelSlice.textContent = "";
        const mid = canvasToScreen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY }, state.camera);
        labelEl.style.left = `${Math.round(mid.x)}px`;
        labelEl.style.top = `${Math.round(mid.y + 8)}px`;
        labelEl.classList.remove("hidden");
      } else {
        labelEl.classList.add("hidden");
      }
    }
  };

  const onPointerMove = (e) => {
    // Stay put while the pointer is over our own chrome — the pile
    // title rows in particular are interactive.
    if (overlay.contains(e.target) || stackLabels.contains(e.target)) return;
    // Only the select tool hovers — text / drag-area / pen input owns
    // the pointer for its own gesture.
    if (state.tool !== "select" || state.isPanning || state.editingText) { hide(); return; }
    if (state.selectionBox) { hide(); return; }
    const rect = canvasHost.getBoundingClientRect();
    const world = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);
    // Raised-last order so a doc's outline column (which paints over its
    // neighbours) claims the points it covers, rather than the thumbnail
    // underneath answering with the wrong filename and buttons.
    const hit = findShapeAtPoint(world, raisedLast(state.shapes, state.selectedIds), state.fontFamily);
    if (hit && hit.type === "image" && hit.fileRef && !hit.pocketed) {
      if (hit.id !== hoveredShapeId) showFor(hit);
      showSliceName(hit, world);
      return;
    }
    hide();
  };

  /** A stack thumbnail is a row of per-file slices; name the one the
   *  pointer is over on the caption's second line. Slice bands are
   *  shape-local (thumbnails aren't resizable, so no scaling needed). */
  const showSliceName = (shape, world) => {
    const slices = shape.fileRef?.slices;
    if (!slices?.length || shape.fileRef.stackId) return; // piles use the title list
    const lx = world.x - shape.position.x;
    const slice = slices.find((s) => lx >= s.x && lx < s.x + s.w);
    const next = slice?.name || "";
    if (labelSlice.textContent !== next) labelSlice.textContent = next;
  };

  const onPointerLeave = (e) => {
    if (e.relatedTarget && (overlay.contains(e.relatedTarget) || stackLabels.contains(e.relatedTarget))) return;
    hide();
  };

  // Any camera pan / zoom or foreign shape mutation invalidates the
  // anchors — hide and let the next pointermove re-place everything.
  // Our own write (click-to-top) is exempt.
  const onStateChange = (e) => {
    if (ownWrites > 0) return;
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
  outlineBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hoveredRef) handlers.onToggleOutline?.(hoveredRef, e);
    hide(); // the thumbnail geometry changes; re-hover to re-anchor
  });
  secondaryBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hoveredRef) handlers.onSecondary(hoveredRef, e);
  });
  // Keep clicks on our chrome from reaching the canvas as a marquee /
  // deselect gesture.
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  stackLabels.addEventListener("pointerdown", (e) => e.stopPropagation());

  canvasHost.addEventListener("pointermove", onPointerMove);
  canvasHost.addEventListener("pointerleave", onPointerLeave);
  state.addEventListener("change", onStateChange);

  return () => {
    canvasHost.removeEventListener("pointermove", onPointerMove);
    canvasHost.removeEventListener("pointerleave", onPointerLeave);
    state.removeEventListener("change", onStateChange);
    overlay.remove();
    labelEl.remove();
    stackLabels.remove();
  };
}
