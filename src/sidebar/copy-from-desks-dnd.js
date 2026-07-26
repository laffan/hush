/**
 * Pointer drag from the source column into the destination column for
 * the "Copy Files from other Desks" modal.
 *
 * Dragging doesn't copy anything — it *plans* the copy. On release the
 * dragged batch is appended to the plan at the resolved slot, and the
 * destination column re-renders with grey ghost rows sitting exactly
 * where the files will land. The actual work happens later, when the
 * user presses Move Files.
 *
 * Drop resolution mirrors the sidebar's sortable list: the top / bottom
 * quarter of a container row means "beside it", the middle means
 * "inside it"; leaf rows are before / after only; empty space below the
 * tree means the desk root.
 */

const DRAG_THRESHOLD = 4;

/**
 * @param opts {
 *   srcEl, dstEl,           // the two scrolling column elements
 *   rootId,                 // active desk node id (the root drop target)
 *   getSelection,           // () => ordered array of source node ids
 *   selectFromRow,          // (nodeId, event) => void — click selection
 *   onDrop,                 // (nodeIds, site) => void
 *   onHoverContainer,       // (nodeId|null) => void — auto-expand hook
 * }
 */
export function installCopyDrag(opts) {
  const { srcEl, dstEl } = opts;
  let drag = null;

  srcEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest(".cfd-row");
    if (!row || e.target.closest(".cfd-arrow")) return;
    drag = {
      nodeId: row.dataset.nodeId,
      startX: e.clientX, startY: e.clientY,
      active: false, event: e,
    };
  });

  const onMove = (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.ids = opts.getSelection().includes(drag.nodeId)
        ? opts.getSelection().slice()
        : [drag.nodeId];
      drag.ghost = makeGhost(drag.ids.length);
      document.body.classList.add("cfd-dragging");
    }
    moveGhost(drag.ghost, e.clientX, e.clientY);
    drag.site = resolveDropSite(e.clientX, e.clientY, dstEl, opts.rootId);
    paintDropSite(dstEl, drag.site);
    opts.onHoverContainer?.(drag.site?.into || null);
  };

  const onUp = (e) => {
    if (!drag) return;
    const finished = drag;
    drag = null;
    clearDropPaint(dstEl);
    document.body.classList.remove("cfd-dragging");
    finished.ghost?.remove();
    if (!finished.active) {
      opts.selectFromRow?.(finished.nodeId, finished.event);
      return;
    }
    const site = resolveDropSite(e.clientX, e.clientY, dstEl, opts.rootId);
    if (site) opts.onDrop?.(finished.ids, site);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };
}

function makeGhost(count) {
  const el = document.createElement("div");
  el.className = "cfd-drag-ghost";
  el.textContent = count === 1 ? "1 item" : `${count} items`;
  document.body.appendChild(el);
  return el;
}

function moveGhost(el, x, y) {
  if (!el) return;
  el.style.left = `${x + 12}px`;
  el.style.top = `${y + 12}px`;
}

/** `{ parentId, index, into }` — `into` names the container row that
 *  should light up (and auto-expand) while hovering. */
export function resolveDropSite(x, y, dstEl, rootId) {
  const rect = dstEl.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const el = document.elementFromPoint(x, y)?.closest?.(".cfd-row");
  if (!el || !dstEl.contains(el)) {
    // Empty space in the column → the desk root, after everything.
    const rootRows = dstEl.querySelectorAll(`.cfd-row[data-parent-id="${cssEscape(rootId)}"]:not(.cfd-planned)`);
    return { parentId: rootId, index: rootRows.length, into: null };
  }
  const r = el.getBoundingClientRect();
  const rel = r.height ? (y - r.top) / r.height : 0.5;
  const parentId = el.dataset.parentId || rootId;
  const index = parseInt(el.dataset.index, 10) || 0;
  // The desk header is the root drop target — it has no "beside me".
  if (el.classList.contains("cfd-desk-root")) {
    return { parentId: rootId, index: parseInt(el.dataset.childCount, 10) || 0, into: rootId };
  }
  if (el.dataset.container === "1") {
    if (rel < 0.25) return { parentId, index, into: null };
    if (rel > 0.75) return { parentId, index: index + 1, into: null };
    return {
      parentId: el.dataset.nodeId,
      index: parseInt(el.dataset.childCount, 10) || 0,
      into: el.dataset.nodeId,
    };
  }
  return { parentId, index: rel < 0.5 ? index : index + 1, into: null };
}

function cssEscape(s) {
  return String(s || "").replace(/["\\]/g, "\\$&");
}

function paintDropSite(dstEl, site) {
  clearDropPaint(dstEl);
  if (!site) return;
  if (site.into) {
    const row = dstEl.querySelector(`.cfd-row[data-node-id="${cssEscape(site.into)}"]`);
    row?.classList.add("cfd-drop-into");
    return;
  }
  // A thin line at the boundary the copy would be inserted at.
  const rows = Array.from(
    dstEl.querySelectorAll(`.cfd-row[data-parent-id="${cssEscape(site.parentId)}"]:not(.cfd-planned)`),
  );
  const marker = document.createElement("div");
  marker.className = "cfd-drop-line";
  const anchor = rows[site.index];
  if (anchor) anchor.parentNode.insertBefore(marker, anchor);
  else if (rows.length) lastDescendantOf(rows[rows.length - 1]).after(marker);
  else {
    const parentRow = dstEl.querySelector(`.cfd-row[data-node-id="${cssEscape(site.parentId)}"]`);
    if (parentRow) parentRow.after(marker); else dstEl.appendChild(marker);
  }
}

/** Rows render flat with indentation, so "after this row" means after
 *  its whole expanded subtree — every following row deeper than it. */
function lastDescendantOf(row) {
  const depth = parseInt(row.dataset.depth, 10) || 0;
  let last = row;
  let next = row.nextElementSibling;
  while (next?.classList.contains("cfd-row") && (parseInt(next.dataset.depth, 10) || 0) > depth) {
    last = next;
    next = next.nextElementSibling;
  }
  return last;
}

export function clearDropPaint(dstEl) {
  dstEl.querySelectorAll(".cfd-drop-line").forEach((n) => n.remove());
  dstEl.querySelectorAll(".cfd-drop-into").forEach((n) => n.classList.remove("cfd-drop-into"));
}
