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
 *  and collect every doc leaf in render order. Respects collapsed
 *  containers — items inside a collapsed folder are skipped because
 *  the user can't see them anyway, and a shift-range that silently
 *  pulled in invisible rows would feel like a bug. The result is the
 *  reference order for shift-range expansion. */
export function collectVisibleDocs(state, visibleTopLevel, sortFlaggedItems, collapsedIds) {
  const out = [];
  const tree = sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state)));
  const collapsed = collapsedIds || new Set();
  function walk(nodes) {
    for (const n of nodes) {
      if (state.isInTrash(n.id)) continue;
      if (n.type === "document" && n.fileId) out.push(n);
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

const GUTTER_PX = 16;

/** Install the drag-select gutter inside the files panel container.
 *  Returns a cleanup function. The gutter is a 16 px-wide invisible
 *  strip on the panel's left edge — pointerdown there starts the
 *  drag-select rectangle, leaving every other click + drag in the panel
 *  routing through SortableList as before. */
export function installDragSelectGutter(panelContainer, state) {
  // Ensure the panel container can host an absolute-positioned overlay.
  if (getComputedStyle(panelContainer).position === "static") {
    panelContainer.style.position = "relative";
  }
  const gutter = document.createElement("div");
  gutter.className = "files-drag-select-gutter";
  panelContainer.appendChild(gutter);

  let session = null;
  let rectEl = null;

  function findDocRowsInPanel() {
    // Every doc-backed row in the visible panel — walk `.sl-item` and
    // pick out the ones whose data-id maps to a tree-node typed
    // `document`. Cheaper than re-walking the file tree per pointermove.
    const rows = [];
    panelContainer.querySelectorAll(".sl-item").forEach((li) => {
      const id = li.dataset.id;
      if (!id) return;
      const node = findNodeByIdInPanel(state, id);
      if (node && node.type === "document" && node.fileId) {
        rows.push({ el: li, fileId: node.fileId });
      }
    });
    return rows;
  }

  function rectFromPoints(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x, b.x);
    const bottom = Math.max(a.y, b.y);
    return { left, top, right, bottom };
  }

  function intersects(rect, el) {
    const r = el.getBoundingClientRect();
    return !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Allow the system to keep handling text-selection / drag-export
    // when the user is holding Cmd — we shouldn't steal that gesture.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    session = {
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      additive: !!e.shiftKey,
      baseSelection: e.shiftKey ? state.selectedDocIds.slice() : [],
      rows: findDocRowsInPanel(),
    };
    rectEl = document.createElement("div");
    rectEl.className = "sl-drag-select-rect";
    document.body.appendChild(rectEl);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
  }

  function onPointerMove(e) {
    if (!session || e.pointerId !== session.pointerId) return;
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
    // Stream the live selection through so the sidebar repaints in
    // real time while the user is dragging the rectangle.
    state.setSelectedDocs(Array.from(hit));
  }

  function teardown() {
    if (rectEl) { rectEl.remove(); rectEl = null; }
    session = null;
    window.removeEventListener("pointermove", onPointerMove);
  }

  function onPointerUp(e) {
    if (!session || e.pointerId !== session.pointerId) return;
    // Empty / single-doc drag is treated as "user clicked the gutter
    // by mistake" — clear any leftover selection so the click feels
    // like a no-op. (Shift-drag preserves the existing batch.)
    if (!session.additive) {
      const movedFar = Math.abs(e.clientX - session.start.x) > 4 || Math.abs(e.clientY - session.start.y) > 4;
      if (!movedFar) state.clearSelectedDocs();
      else if ((state.selectedDocIds || []).length < 2) state.clearSelectedDocs();
    }
    teardown();
  }

  function onPointerCancel() { teardown(); }

  gutter.addEventListener("pointerdown", onPointerDown);

  return () => {
    gutter.removeEventListener("pointerdown", onPointerDown);
    teardown();
    gutter.remove();
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
