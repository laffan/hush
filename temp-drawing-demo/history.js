/* ============================================================
 * history.js — a tiny command stack.
 *
 * Domain-agnostic. Callers push entries of the form
 *   { undo: () => void, redo: () => void }
 * where each closure captures whatever it needs to replay the change.
 *
 * The module sets an internal `replaying` flag while undo/redo closures
 * run so that listeners (e.g. the stroke engine's onMutation callback)
 * can recognise the re-entrant call and skip re-recording.
 * ============================================================ */

const MAX_DEPTH = 200;

export function createHistory() {
  const undoStack = [];
  const redoStack = [];
  let replaying = false;

  function push(entry) {
    if (replaying) return;
    undoStack.push(entry);
    if (undoStack.length > MAX_DEPTH) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    const e = undoStack.pop();
    if (!e) return false;
    replaying = true;
    try { e.undo(); } finally { replaying = false; }
    redoStack.push(e);
    return true;
  }

  function redo() {
    const e = redoStack.pop();
    if (!e) return false;
    replaying = true;
    try { e.redo(); } finally { replaying = false; }
    undoStack.push(e);
    return true;
  }

  return {
    push,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    isReplaying: () => replaying,
    clear() { undoStack.length = 0; redoStack.length = 0; },
  };
}
