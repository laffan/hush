/**
 * Cmd-drag text between docs/panes and notebooks.
 *
 * Source: a CodeMirror editor's current selection (main or pane) or a
 * notebook's text shape. On pointerup over any CodeMirror editor the
 * dragged text is inserted at the drop coordinate; over a registered
 * notebook canvas it's added as a text shape at the drop coordinate.
 * Holding Shift at drop deletes the source.
 */
import { EditorView } from "@codemirror/view";

let active = null;

// Notebook canvases registered as drop targets.
const notebookTargets = new Set();

/**
 * Register a notebook canvas as a drop target. Returns an unregister fn.
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} state The notebook's DrawingState
 */
export function registerNotebookDropTarget(canvasEl, state) {
  const entry = { canvasEl, state };
  notebookTargets.add(entry);
  return () => { notebookTargets.delete(entry); };
}

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
    if (target.kind === "cm") {
      insertIntoEditor(target.view, text, e.clientX, e.clientY);
    } else if (target.kind === "nb") {
      insertIntoNotebook(target.state, target.canvasEl, text, e.clientX, e.clientY);
    }
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

/**
 * Wire a CodeMirror editor as a cmd-drag source.
 *
 * Listens on `containerEl` in the capture phase so the handler runs
 * before CodeMirror's own pointerdown on contentDOM (listeners on the
 * target element fire in registration order regardless of phase, so we
 * need an ancestor to win the race).
 *
 * @param {EditorView} view       The CodeMirror view whose selection seeds the drag.
 * @param {HTMLElement} containerEl An ancestor of view.contentDOM.
 * @returns {() => void} unregister
 */
export function attachEditorTextDrag(view, containerEl) {
  const handler = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.button !== 0) return;
    if (!(e.target instanceof Node) || !view.contentDOM.contains(e.target)) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    // Only trigger if pointerdown lands on (or inside) the selection range.
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null || pos < sel.from || pos > sel.to) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const text = view.state.sliceDoc(sel.from, sel.to);
    const from = sel.from;
    const to = sel.to;
    startTextDrag({
      text,
      initialEvent: e,
      onDrop: (deleteSource) => {
        if (deleteSource) {
          view.dispatch({ changes: { from, to, insert: "" } });
        }
      },
    });
  };
  containerEl.addEventListener("pointerdown", handler, true);
  return () => containerEl.removeEventListener("pointerdown", handler, true);
}

function updateGhostMode(ghost, deleteOnDrop) {
  ghost.classList.toggle("text-drag-ghost-move", deleteOnDrop);
}

function findDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;

  // Notebook canvas targets — matched by direct element identity so we
  // don't accidentally catch unrelated canvases.
  for (const entry of notebookTargets) {
    if (entry.canvasEl === el || entry.canvasEl.contains(el)) {
      return { kind: "nb", canvasEl: entry.canvasEl, state: entry.state };
    }
  }

  const cm = el.closest(".cm-editor");
  if (cm) {
    const view = EditorView.findFromDOM(cm);
    if (view) return { kind: "cm", view };
  }
  return null;
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

function insertIntoNotebook(state, canvasEl, text, clientX, clientY) {
  if (typeof state.addTextShapeAtPosition !== "function") return;
  const rect = canvasEl.getBoundingClientRect();
  const canvasPt = {
    x: (clientX - rect.left - state.camera.x) / state.camera.zoom,
    y: (clientY - rect.top - state.camera.y) / state.camera.zoom,
  };
  state.addTextShapeAtPosition(text, canvasPt);
}

