/**
 * Desktop hover controls — everything that surfaces over a file
 * thumbnail on hover:
 *
 *  - the action icons (open / open-as-pane; docs with a paired gutter
 *    add "Open with Gutter Visible"; nested projects swap the pane icon
 *    for "Open Project Desktop"),
 *  - the filename label (labels are hover-only on Desktops — a single
 *    thumbnail shows its name centred beneath it),
 *  - a pile's title list (left-aligned beneath the stack): hovering a
 *    title animates that member peeking out of the left side of the
 *    pile, clicking a title moves it to the top of the stack.
 *
 * Pure DOM overlay above the canvas; the notebook engine stays unaware
 * of it. Positions track the hovered shape in screen space; camera or
 * foreign shape changes hide the overlay and the next pointermove
 * re-anchors it (the peek animation's own shape writes are exempted
 * via a suppression counter).
 */

import { canvasToScreen, screenToCanvas, getShapeBounds } from "../notebook/utils.ts";
import { findShapeAtPoint } from "../notebook/state-helpers.ts";
import { stackBounds, stackMembers, moveToTopOfStack } from "./desktop-stacks.js";
import { applyTooltip } from "../tooltips.js";

const OPEN_ICON = `<svg viewBox="0 0 16 16"><path d="M6 3h7v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PANE_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="5.5" x2="14" y2="5.5" stroke="currentColor" stroke-width="1.5"/></svg>`;
const GRID_ICON = `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="2" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="9" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
// The sidebar's gutter glyph — vertical rules flanking a dot column.
const GUTTER_ICON = `<svg viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="13"/><line x1="12" y1="3" x2="12" y2="13"/></g><g fill="currentColor"><circle cx="8" cy="4" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="12" r="1"/></g></svg>`;

const PEEK_MARGIN = 24;
const PEEK_MS = 160;

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

  const secondaryBtn = document.createElement("button");
  secondaryBtn.type = "button";
  secondaryBtn.className = "desktop-hover-btn";

  overlay.appendChild(openBtn);
  overlay.appendChild(gutterBtn);
  overlay.appendChild(secondaryBtn);
  canvasHost.appendChild(overlay);

  // Single-thumbnail hover caption (labels are hover-only on Desktops).
  const labelEl = document.createElement("div");
  labelEl.className = "desktop-hover-label hidden";
  canvasHost.appendChild(labelEl);

  // Pile title list — interactive: hover a row to peek that member out
  // of the left side of the stack, click it to move it to the top.
  const stackLabels = document.createElement("div");
  stackLabels.className = "desktop-stack-labels hidden";
  canvasHost.appendChild(stackLabels);

  let hoveredRef = null;
  let hoveredShapeId = null;
  // > 0 while our own shape writes (peek tween, click-to-top) are in
  // flight, so the change listener doesn't treat them as foreign edits
  // and hide the overlay mid-animation.
  let ownWrites = 0;
  let peek = null; // { shapeId, home: {x,y} }
  let peekRaf = 0;

  const setShapePos = (id, x, y) => {
    ownWrites++;
    state.shapes = state.shapes.map((s) => s.id === id ? { ...s, position: { x, y } } : s);
    state.notify("shapes");
    queueMicrotask(() => { ownWrites--; });
  };

  const tweenShape = (id, from, to, done) => {
    cancelAnimationFrame(peekRaf);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / PEEK_MS);
      const e = 1 - Math.pow(1 - t, 3);
      setShapePos(id, from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
      if (t < 1) peekRaf = requestAnimationFrame(step);
      else if (done) done();
    };
    peekRaf = requestAnimationFrame(step);
  };

  const startPeek = (shapeId) => {
    if (peek?.shapeId === shapeId) return;
    endPeek(true);
    const shape = state.shapes.find((s) => s.id === shapeId);
    const stackId = shape?.fileRef?.stackId;
    if (!shape || !stackId) return;
    const sb = stackBounds(state.shapes, stackId, state.fontFamily);
    if (!sb) return;
    const home = { ...shape.position };
    peek = { shapeId, home };
    tweenShape(shapeId, home, { x: sb.minX - shape.width - PEEK_MARGIN, y: home.y });
  };

  const endPeek = (instant = false) => {
    if (!peek) return;
    const { shapeId, home } = peek;
    peek = null;
    cancelAnimationFrame(peekRaf);
    if (instant) {
      setShapePos(shapeId, home.x, home.y);
    } else {
      const cur = state.shapes.find((s) => s.id === shapeId)?.position;
      if (cur) tweenShape(shapeId, { ...cur }, home);
    }
  };

  const hide = () => {
    endPeek();
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
      row.addEventListener("mouseenter", () => startPeek(m.id));
      row.addEventListener("mouseleave", () => { if (peek?.shapeId === m.id) endPeek(); });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        endPeek(true);
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
    const bounds = getShapeBounds(shape, state.fontFamily);
    const corner = canvasToScreen({ x: bounds.maxX, y: bounds.minY }, state.camera);
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
        labelEl.textContent = shape.fileRef.name || shape.name || "";
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
    const hit = findShapeAtPoint(world, state.shapes, state.fontFamily);
    if (hit && hit.type === "image" && hit.fileRef && !hit.pocketed) {
      if (hit.id !== hoveredShapeId) {
        // Moving between members of the same pile keeps the list up.
        if (peek && hit.fileRef.stackId !== state.shapes.find((s) => s.id === peek.shapeId)?.fileRef?.stackId) endPeek();
        showFor(hit);
      }
      return;
    }
    hide();
  };

  const onPointerLeave = (e) => {
    if (e.relatedTarget && (overlay.contains(e.relatedTarget) || stackLabels.contains(e.relatedTarget))) return;
    hide();
  };

  // Any camera pan / zoom or foreign shape mutation invalidates the
  // anchors — hide and let the next pointermove re-place everything.
  // Our own writes (peek tween, click-to-top) are exempt.
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
    endPeek(true);
    canvasHost.removeEventListener("pointermove", onPointerMove);
    canvasHost.removeEventListener("pointerleave", onPointerLeave);
    state.removeEventListener("change", onStateChange);
    overlay.remove();
    labelEl.remove();
    stackLabels.remove();
  };
}
