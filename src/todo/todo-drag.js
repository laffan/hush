/**
 * Dragging a to-do by its grip (the hover tools, between "+" and ×).
 *
 * A to-do moves only among its own kind: an inactive one within its
 * desk's list, a primed one within the primed to-dos at the top. The
 * active to-do (always first) and completed ones have no grip. The row
 * moves live among the rows it may pass while the pointer is down; the
 * drop commits the new order of that set through `reorderTodos`, which
 * leaves every other to-do where it was.
 */
import { reorderTodos } from "./todo-store.js";

/** The rows a dragged row may pass: its siblings of the same status. */
function peersOf(row) {
  const list = row.parentElement;
  if (!list) return [];
  const kind = row.classList.contains("is-primed") ? ".is-primed" : ".is-inactive";
  return [...list.querySelectorAll(`:scope > .todo-item${kind}`)];
}

/**
 * Wire the grips in `body`. `setDragging(on)` holds the panel's renders
 * while a row is on the move (a render would take it out from under the
 * pointer) and lets them run after.
 */
export function wireTodoDrag(state, body, setDragging) {
  body.addEventListener("pointerdown", (e) => {
    const grip = e.target instanceof Element ? e.target.closest(".todo-grip") : null;
    const row = grip?.closest(".todo-item");
    if (!row || e.button !== 0) return;
    const peers = peersOf(row);
    if (peers.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const list = row.parentElement;
    const start = peers.map((r) => r.dataset.id);
    setDragging(true);
    row.classList.add("dragging");
    body.classList.add("reordering");
    // On the window, not captured on the grip: moving the row through
    // the list re-inserts it, and a re-inserted element loses its
    // pointer capture — the drag stalled at the first step.

    const onMove = (me) => {
      const others = peersOf(row).filter((r) => r !== row);
      // Before the first peer whose middle is below the pointer; else
      // after the last one.
      const target = others.find((r) => {
        const rect = r.getBoundingClientRect();
        return me.clientY < rect.top + rect.height / 2;
      });
      if (target) { if (row.nextElementSibling !== target) list.insertBefore(row, target); }
      else {
        const last = others[others.length - 1];
        if (last && last.nextElementSibling !== row) last.after(row);
      }
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      row.classList.remove("dragging");
      body.classList.remove("reordering");
      const order = peersOf(row).map((r) => r.dataset.id);
      try { if (order.join() !== start.join()) await reorderTodos(state, order); }
      finally { setDragging(false); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}
