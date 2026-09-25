/**
 * Drag-to-reorder for the multi-select view's rows.
 *
 * The order is the selection's own (`state.selectedDocIds`), not the
 * files' place in the tree: nothing moves in the sidebar, but every
 * batch action reads its rows in this order — the stack's columns, the
 * new project's documents, Combine's starting order, and the text Copy
 * to Clipboard joins.
 *
 * Pointer-driven so it works on touch, with the same thin drop marker as
 * the Combine modal's list. The move and up listeners sit on `document`
 * rather than on the handle, so a pointer that leaves the handle mid-drag
 * still finishes the drag. The handle is a button: ArrowUp / ArrowDown
 * move its row one place for keyboard users.
 */

/** A press on the handle released somewhere else on the row still
 *  produces a `click` on their common ancestor — the row, which opens its
 *  file. Swallow the one click that belongs to the gesture just ended; it
 *  is dispatched in the same task as the `pointerup`, so the listener is
 *  gone again before anything else can reach it. */
function swallowClick() {
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener("click", stop, true);
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

/**
 * @param listEl   the `<ul>` holding the rows (`[data-file-id]` on each)
 * @param onReorder called with the new fileId order when a drag or a
 *                  key press actually moved something
 */
export function wireMultiSelectReorder(listEl, onReorder) {
  if (!listEl) return;
  const rowsOf = () => Array.from(listEl.querySelectorAll(".ms-view-row"));
  const idsOf = (rows) => rows.map((r) => r.dataset.fileId);

  listEl.querySelectorAll(".ms-view-drag").forEach((handle) => {
    // The row itself opens its file on click; the handle must never
    // count as a click on the row.
    handle.addEventListener("click", (e) => e.stopPropagation());

    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      e.stopPropagation();
      const rows = rowsOf();
      const from = rows.indexOf(handle.closest(".ms-view-row"));
      const to = from + (e.key === "ArrowUp" ? -1 : 1);
      if (from < 0 || to < 0 || to >= rows.length) return;
      const ids = idsOf(rows);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      onReorder(ids, moved);
    });

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rows = rowsOf();
      const dragRow = handle.closest(".ms-view-row");
      const dragIdx = rows.indexOf(dragRow);
      if (dragIdx < 0) return;
      dragRow.classList.add("ms-view-row-dragging");

      // Slot the pointer is over: the index of the first row whose
      // midpoint is below it, or the end of the list.
      const computeTarget = (clientY) => {
        for (let j = 0; j < rows.length; j++) {
          const rect = rows[j].getBoundingClientRect();
          if (clientY < rect.top + rect.height / 2) return j;
        }
        return rows.length;
      };
      const isMove = (t) => t !== dragIdx && t !== dragIdx + 1;
      const clearMarker = () => listEl.querySelectorAll(".ms-view-drop").forEach((d) => d.remove());

      const onMove = (ev) => {
        const target = computeTarget(ev.clientY);
        clearMarker();
        if (!isMove(target)) return;
        const marker = document.createElement("li");
        marker.className = "ms-view-drop";
        listEl.insertBefore(marker, rows[target] || null);
      };
      const finish = (ev, commit) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        dragRow.classList.remove("ms-view-row-dragging");
        clearMarker();
        swallowClick();
        if (!commit) return;
        const target = computeTarget(ev.clientY);
        if (!isMove(target)) return;
        const ids = idsOf(rows);
        const [moved] = ids.splice(dragIdx, 1);
        ids.splice(target > dragIdx ? target - 1 : target, 0, moved);
        onReorder(ids, moved);
      };
      const onUp = (ev) => finish(ev, true);
      const onCancel = (ev) => finish(ev, false);

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    });
  });
}
