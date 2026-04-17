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

  // Inactive panes disable pointer-events on their content (see
  // floating-pane.css), which would also hide them from elementFromPoint
  // during the drop search. Add a body class for the duration of the
  // drag so the CSS override re-enables pointer-events.
  document.body.classList.add("text-drag-active");

  // Ghost follows the cursor. Parent is <html> so we're above anything
  // the app might stack inside body (floating panes live at z-index 90
  // but nested stacking contexts can still mask a body-level child).
  const ghost = document.createElement("div");
  ghost.className = "text-drag-ghost";
  const preview = text.length > 80 ? text.slice(0, 77) + "\u2026" : text;
  ghost.textContent = preview;
  ghost.style.left = initialEvent.clientX + 12 + "px";
  ghost.style.top = initialEvent.clientY + 12 + "px";
  document.documentElement.appendChild(ghost);

  let shiftHeld = !!initialEvent.shiftKey;
  updateGhostMode(ghost, shiftHeld);

  const startX = initialEvent.clientX;
  const startY = initialEvent.clientY;
  const MOVE_THRESHOLD = 4;
  let moved = false;
  let hoveredPane = null;

  function setHoveredPane(paneEl) {
    if (paneEl === hoveredPane) return;
    if (hoveredPane) hoveredPane.classList.remove("pane-drop-target");
    hoveredPane = paneEl;
    if (hoveredPane) hoveredPane.classList.add("pane-drop-target");
  }

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
    // Highlight the pane currently under the cursor (if any).
    const target = findDropTarget(e.clientX, e.clientY);
    const targetEl = target && targetElementOf(target);
    setHoveredPane(targetEl ? targetEl.closest(".floating-pane") : null);
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
    setHoveredPane(null);
    document.body.classList.remove("text-drag-active");
    active = null;
  }

  function onUp(e) {
    const deleteSource = shiftHeld || e.shiftKey;
    // Resolve the drop target BEFORE cleanup, since cleanup removes the
    // body.text-drag-active class that re-enables pointer-events on
    // inactive panes. Without this order elementFromPoint would return
    // something behind the pane and the drop would silently no-op.
    const target = moved ? findDropTarget(e.clientX, e.clientY) : null;
    cleanup();
    if (!target) return;

    // If the drop landed inside a floating pane, activate that pane first
    // so its editor becomes editable and focused. The pane's own
    // pointerdown handler wires focusPane() via this synthetic event.
    focusPaneIfInside(targetElementOf(target));
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
 * Wire a notebook canvas as a cmd-drag source. A cmd-mousedown on a text
 * shape starts a drag with that shape's text; Shift at drop deletes the
 * shape.
 *
 * @param {HTMLCanvasElement} canvasEl
 * @param {HTMLElement} containerEl Ancestor of canvasEl.
 * @param {object} state   DrawingState from notes-canvas.
 * @param {object} helpers { findTextShapeAt, hitTestLink? }
 * @param {() => void} [markDirty]
 * @returns {() => void} unregister
 */
export function attachNotebookTextShapeDrag(canvasEl, containerEl, state, helpers, markDirty) {
  const handler = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.button !== 0) return;
    if (!(e.target instanceof Node) || !canvasEl.contains(e.target)) return;
    const rect = canvasEl.getBoundingClientRect();
    const canvasPt = {
      x: (e.clientX - rect.left - state.camera.x) / state.camera.zoom,
      y: (e.clientY - rect.top - state.camera.y) / state.camera.zoom,
    };
    const hit = helpers.findTextShapeAt(state.shapes, canvasPt);
    if (!hit) return;
    if (helpers.hitTestLink && helpers.hitTestLink(canvasPt, hit)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    startTextDrag({
      text: hit.text,
      initialEvent: e,
      onDrop: (deleteSource) => {
        if (!deleteSource) return;
        state.shapes = state.shapes.filter((s) => s.id !== hit.id);
        state.selectedIds = new Set();
        state.notify("shapes");
        state.notify("selectedIds");
        state.recordHistory();
        if (markDirty) markDirty();
      },
    });
  };
  containerEl.addEventListener("pointerdown", handler, true);
  return () => containerEl.removeEventListener("pointerdown", handler, true);
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

function targetElementOf(target) {
  if (!target) return null;
  if (target.kind === "nb") return target.canvasEl;
  if (target.kind === "cm") return target.view.dom;
  return null;
}

function findDropTarget(x, y) {
  // Walk the whole stack at the drop point, not just the topmost element.
  // The ghost (though pointer-events:none) and other siblings can still
  // show up here, so we look for the first element that matches a known
  // drop target type.
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!(el instanceof Element)) continue;

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

/** If `el` lives inside a .floating-pane, trigger its pane's focus logic
 *  so the drop target becomes the active pane (editable + focused). */
function focusPaneIfInside(el) {
  if (!(el instanceof Element)) return;
  const paneEl = el.closest(".floating-pane");
  if (!paneEl) return;
  paneEl.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, pointerType: "mouse",
  }));
}
