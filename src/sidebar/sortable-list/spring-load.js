/**
 * Spring-loaded folders — the OS behaviour for a drag held over a
 * closed folder. A collapsed row takes the drop as it is (the item lands
 * inside without the folder opening); only a hover that stays on the
 * row for SPRING_OPEN_MS opens it, and a folder opened that way closes
 * again as soon as the drag moves onto a row outside it, so passing over
 * folders on the way to another one leaves the tree as it was.
 *
 * Every function takes the SortableList instance as `this`, like the
 * drag handlers in drag-drop.js, and works on `this.dragSession`:
 *   springId / springTimer  the folder being counted down, and its timer
 *   autoExpandedIds         folders this drag has sprung open
 */

import { parsePath, isAncestorPath } from "./utils.js";

export const SPRING_OPEN_MS = 1000;

/** Start counting down on `itemId`, unless it already is. `onOpen` runs
 *  when the hover has lasted long enough. */
export function armSpring(itemId, onOpen) {
  const s = this.dragSession;
  if (!s || s.springId === itemId) return;
  disarmSpring.call(this);
  s.springId = itemId;
  s.springTimer = setTimeout(() => {
    if (this.dragSession !== s || s.springId !== itemId) return;
    s.springTimer = null;
    onOpen(itemId);
  }, SPRING_OPEN_MS);
}

export function disarmSpring() {
  const s = this.dragSession;
  if (!s) return;
  if (s.springTimer) clearTimeout(s.springTimer);
  s.springTimer = null;
  s.springId = null;
}

/** Path of a rendered row, by id — sprung folders are open, so theirs
 *  is always in the DOM. */
function renderedPath(id) {
  const el = this.container.querySelector(`.sl-item[data-id="${this._escapeForAttribute(id)}"]`);
  return el ? parsePath(el.dataset.path ?? "") : null;
}

/** Close every sprung folder that doesn't contain `path` (the row under
 *  the pointer, or the list a drop lands in). Returns true when one
 *  closed, i.e. the list needs re-rendering. */
export function closeSpringsOutside(path) {
  const s = this.dragSession;
  if (!s || !s.autoExpandedIds.size) return false;
  let closed = false;
  for (const id of [...s.autoExpandedIds]) {
    const folderPath = renderedPath.call(this, id);
    if (folderPath && isAncestorPath(folderPath, path)) continue;
    s.autoExpandedIds.delete(id);
    this.state.collapsedIds.add(id);
    closed = true;
  }
  return closed;
}

/** Re-render mid-drag. The rows are rebuilt, so the copy of the dragged
 *  row is marked again — it stays faded, and the hover scan (which skips
 *  `.dragging`) never offers it as a drop target for itself. */
export function renderDuringDrag() {
  this.render();
  const s = this.dragSession;
  if (!s) return;
  const el = this.container.querySelector(`.sl-item[data-path="${s.originPath.join("/")}"]`);
  el?.classList.add("dragging");
}
