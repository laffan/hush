/**
 * Multi-select helpers for the files panel:
 *   - shift / cmd-click range / toggle handlers
 *   - drag-select bounding-box driven by pointerdown in the panel's
 *     leftmost gutter (a 16 px column where clicks would otherwise do
 *     nothing; using it as the drag-select entry point preserves the
 *     normal click + drag behaviour of every doc / folder row).
 *
 * Extracted from `files-panel.js` so that file stays under the 700-line
 * cap. Selection state itself lives on AppState (`state.selectedDocIds`,
 * `setSelectedDocs`, `clearSelectedDocs`) — these helpers just translate
 * pointer / click input into calls against that API.
 */
import { normalizeProjectChildren } from "../state/tree-helpers.js";

/** Walk the currently-visible top-level tree (active desk subtree)
 *  and collect every doc / notebook leaf in render order. Respects
 *  collapsed containers — items inside a collapsed folder are skipped
 *  because the user can't see them anyway, and a shift-range that
 *  silently pulled in invisible rows would feel like a bug. The
 *  result is the reference order for shift-range expansion. */
export function collectVisibleDocs(state, visibleTopLevel, sortFlaggedItems, collapsedIds) {
  const out = [];
  const tree = sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state)));
  const collapsed = collapsedIds || new Set();
  function walk(nodes) {
    for (const n of nodes) {
      if (state.isInTrash(n.id)) continue;
      if ((n.type === "document" || n.type === "notebook" || n.type === "pdf") && n.fileId) out.push(n);
      if (n.children?.length && !collapsed.has(n.id)) walk(n.children);
    }
  }
  walk(tree);
  return out;
}

/** Resolve modifier-click semantics into a new selection. The caller
 *  already knows the click landed on a doc with a fileId. */
export function handleDocMultiClick(item, event, state, visibleDocs) {
  const fileId = item.fileId;
  const current = state.selectedDocIds.slice();
  if (event.shiftKey) {
    // Range expand: from the most-recent anchor (last item in the
    // current selection, or the active doc if nothing selected) to the
    // clicked row, taking every visible doc in between.
    const ids = visibleDocs.map((d) => d.fileId);
    const anchorId = current[current.length - 1] || state.currentFileId;
    const a = anchorId ? ids.indexOf(anchorId) : -1;
    const b = ids.indexOf(fileId);
    if (a < 0 || b < 0) {
      state.setSelectedDocs([fileId]);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    state.setSelectedDocs(ids.slice(lo, hi + 1));
    return;
  }
  // Cmd / Ctrl-click — toggle the row's membership in the selection.
  // Seed with the active doc when starting from an empty selection so
  // a single cmd-click on a sibling produces a two-doc batch (matches
  // Finder / OS file pickers).
  if (current.length === 0 && state.currentFileId && state.currentFileId !== fileId) {
    current.push(state.currentFileId);
  }
  const idx = current.indexOf(fileId);
  if (idx >= 0) current.splice(idx, 1);
  else current.push(fileId);
  state.setSelectedDocs(current);
}

/** Install drag-select on the files-panel container. Pointerdown on
 *  any empty area of the panel (not on an `.sl-item` or an interactive
 *  control) starts a bounding-box selection over doc + notebook rows.
 *  Pointerdown that lands on an existing row keeps routing through
 *  SortableList's normal click + drag pipeline, so the existing file
 *  drag behaviour is untouched.
 *
 *  Returns a cleanup function that removes the listener and any
 *  in-flight selection rectangle. */
export function installDragSelect(panelContainer, state) {
  let session = null;
  let rectEl = null;

  function findSelectableRows() {
    // Every doc / notebook-backed row in the visible panel. Cheaper to
    // walk the existing DOM than to re-traverse the file tree per
    // pointermove, since the panel already painted these rows.
    const rows = [];
    panelContainer.querySelectorAll(".sl-item").forEach((li) => {
      const id = li.dataset.id;
      if (!id) return;
      const node = findNodeByIdInPanel(state, id);
      if (node && (node.type === "document" || node.type === "notebook" || node.type === "pdf") && node.fileId) {
        rows.push({ el: li, fileId: node.fileId });
      }
    });
    return rows;
  }

  function rectFromPoints(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
  }

  function intersects(rect, el) {
    const r = el.getBoundingClientRect();
    return !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
  }

  function isInteractiveTarget(target) {
    if (!(target instanceof Element)) return false;
    // Sortable rows + their fold arrows + any actual `<button>` /
    // `<input>` / `<a>` etc. The body itself, the lists' empty space,
    // and the panel's padding-strip all fall through (false) so
    // drag-select arms there.
    if (target.closest(".sl-item")) return true;
    if (target.closest(".sl-fold-arrow")) return true;
    if (target.closest("button, input, textarea, select, a")) return true;
    if (target.closest(".tree-rename-input")) return true;
    return false;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Cmd/Ctrl-drag is reserved for the system's text-selection /
    // drag-export gesture; we don't steal it.
    if (e.metaKey || e.ctrlKey) return;
    if (isInteractiveTarget(e.target)) return;
    // Only arm when the pointer actually starts inside the panel area.
    if (!panelContainer.contains(e.target)) return;
    e.preventDefault();
    session = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      additive: !!e.shiftKey,
      baseSelection: e.shiftKey ? state.selectedDocIds.slice() : [],
      rows: findSelectableRows(),
      moved: false,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
  }

  function onPointerMove(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.start.x;
    const dy = e.clientY - session.start.y;
    // 4-px slop so a click in empty space doesn't immediately become a
    // (zero-area) drag-select. Once the user crosses the threshold the
    // rectangle materialises and the live selection starts streaming.
    if (!session.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!session.moved) {
      session.moved = true;
      rectEl = document.createElement("div");
      rectEl.className = "sl-drag-select-rect";
      document.body.appendChild(rectEl);
    }
    const rect = rectFromPoints(session.start, { x: e.clientX, y: e.clientY });
    if (rectEl) {
      rectEl.style.left = rect.left + "px";
      rectEl.style.top = rect.top + "px";
      rectEl.style.width = (rect.right - rect.left) + "px";
      rectEl.style.height = (rect.bottom - rect.top) + "px";
    }
    const hit = new Set(session.baseSelection);
    for (const r of session.rows) {
      if (intersects(rect, r.el)) hit.add(r.fileId);
    }
    state.setSelectedDocs(Array.from(hit));
  }

  function teardown() {
    if (rectEl) { rectEl.remove(); rectEl = null; }
    session = null;
    window.removeEventListener("pointermove", onPointerMove);
  }

  function onPointerUp(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    // Click-in-empty-space (no drag) clears any active selection so
    // the user gets the natural "click empty area to deselect"
    // behaviour. A drag that landed nothing inside the rect also
    // clears, mirroring Finder.
    if (!session.additive && !session.moved) state.clearSelectedDocs();
    else if (!session.additive && session.moved && (state.selectedDocIds || []).length < 2) {
      state.clearSelectedDocs();
    }
    teardown();
  }

  function onPointerCancel() { teardown(); }

  panelContainer.addEventListener("pointerdown", onPointerDown);

  return () => {
    panelContainer.removeEventListener("pointerdown", onPointerDown);
    teardown();
  };
}

/** Resolve a tree node id from the panel's data-id without importing
 *  the file tree at module init time (we'd otherwise create a cycle
 *  through state-tree → state → here). Async-import would be heavy for
 *  a pointermove path, so we read straight off `state.fileTree`. */
function findNodeByIdInPanel(state, id) {
  function walk(nodes) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const r = walk(n.children);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(state.fileTree || []);
}
