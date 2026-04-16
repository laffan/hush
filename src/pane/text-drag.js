/**
 * Cmd-drag text between panes and to the underlying document.
 *
 * The source is either a pane editor's current selection or a notebook
 * pane's text shape. On pointerup over any CodeMirror editor the dragged
 * text is inserted at the drop coordinate. Holding Shift at drop deletes
 * the source (selection range or text shape).
 */
import { EditorView } from "@codemirror/view";

let active = null;

/**
 * Start a custom text-drag session.
 *
 * @param {object} opts
 * @param {string} opts.text                 The text to drag.
 * @param {PointerEvent} opts.initialEvent   The pointerdown that triggered the drag.
 * @param {(deleteSource: boolean) => void} [opts.onDrop]
 *   Called after a successful drop, with `true` when the source should be
 *   removed (Shift was held at pointerup).
 */
export function startTextDrag({ text, initialEvent, onDrop }) {
  if (active || !text) return;

  const ghost = document.createElement("div");
  ghost.className = "text-drag-ghost";
  const preview = text.length > 80 ? text.slice(0, 77) + "\u2026" : text;
  ghost.textContent = preview;
  ghost.style.left = initialEvent.clientX + 12 + "px";
  ghost.style.top = initialEvent.clientY + 12 + "px";
  document.body.appendChild(ghost);

  let shiftHeld = !!initialEvent.shiftKey;
  updateGhostMode(ghost, shiftHeld);

  const startX = initialEvent.clientX;
  const startY = initialEvent.clientY;
  const MOVE_THRESHOLD = 4;
  let moved = false;

  function onMove(e) {
    if (!moved) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy >= MOVE_THRESHOLD * MOVE_THRESHOLD) moved = true;
    }
    ghost.style.left = e.clientX + 12 + "px";
    ghost.style.top = e.clientY + 12 + "px";
    if (e.shiftKey !== shiftHeld) {
      shiftHeld = e.shiftKey;
      updateGhostMode(ghost, shiftHeld);
    }
  }

  function onKey(e) {
    if (e.shiftKey !== shiftHeld) {
      shiftHeld = e.shiftKey;
      updateGhostMode(ghost, shiftHeld);
    }
  }

  function cleanup() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    ghost.remove();
    active = null;
  }

  function onUp(e) {
    const deleteSource = shiftHeld || e.shiftKey;
    cleanup();
    // A cmd+click without a real drag shouldn't insert the text.
    if (!moved) return;
    const target = findDropTarget(e.clientX, e.clientY);
    if (!target) return;
    insertIntoEditor(target.view, text, e.clientX, e.clientY);
    if (onDrop) onDrop(deleteSource);
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  active = { ghost, cleanup };
}

export function isTextDragging() {
  return active !== null;
}

function updateGhostMode(ghost, deleteOnDrop) {
  ghost.classList.toggle("text-drag-ghost-move", deleteOnDrop);
}

function findDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const cm = el.closest(".cm-editor");
  if (!cm) return null;
  const view = EditorView.findFromDOM(cm);
  if (!view) return null;
  return { view };
}

function insertIntoEditor(view, text, x, y) {
  // Prefer the coordinate directly under the cursor; fall back to the
  // current selection's head if the point lies between lines.
  let pos = view.posAtCoords({ x, y });
  if (pos == null) pos = view.posAtCoords({ x, y }, false);
  if (pos == null) pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  view.focus();
}
