/**
 * Shuffle Editor — structural undo / redo.
 *
 * Extracted from shuffle-editor.js to keep the lifecycle file under the
 * repo's 700-line cap. Snapshots capture the full node layout (column
 * order + margin positions + strike / comment flags). `pushSnapshot`
 * records the pre-action state and invalidates the redo stack; `undo` /
 * `redo` swap the live layout with the stack tops.
 *
 * All functions close over the active-session object `a`
 * (`{ editorNodes, marginNodes, history, redoStack }`) plus the caller's
 * `makeNode` / `render`, so the controller can destructure the returned
 * helpers and use them as if they were local.
 */

export function createShuffleHistory(a, { makeNode, render }) {
  function snapNode(n) {
    return { text: n.text, strike: n.strike, comment: n.comment, x: n.x, y: n.y };
  }
  function nodeFromSnap(s, where) {
    const n = makeNode(s.text, where, s.x || 0, s.y || 0);
    n.strike = !!s.strike;
    n.comment = !!s.comment;
    return n;
  }
  function serialize() {
    return {
      editor: a.editorNodes.map(snapNode),
      margin: a.marginNodes.map(snapNode),
    };
  }
  /** Build the current snapshot with `node`'s text swapped for `text` —
   *  used by commitEdit to record the pre-edit state without disturbing
   *  anything else that happened during the edit (e.g. a mid-edit
   *  sentence split already pushed its own snapshot). */
  function serializeWithNodeText(node, text) {
    const snap = serialize();
    const list = node.where === "editor" ? snap.editor : snap.margin;
    const idx = (node.where === "editor" ? a.editorNodes : a.marginNodes).indexOf(node);
    if (idx >= 0) list[idx] = { ...list[idx], text };
    return snap;
  }
  function pushSnapshot(snap) {
    a.history.push(snap);
    if (a.history.length > 120) a.history.shift();
    // A fresh action invalidates whatever was undone before it.
    a.redoStack.length = 0;
  }
  function applySnapshot(snap) {
    a.editorNodes = snap.editor.map((s) => nodeFromSnap(s, "editor"));
    a.marginNodes = snap.margin.map((s) => nodeFromSnap(s, "margin"));
    render();
  }
  function undo() {
    const snap = a.history.pop();
    if (!snap) return;
    a.redoStack.push(serialize());
    applySnapshot(snap);
  }
  function redo() {
    const snap = a.redoStack.pop();
    if (!snap) return;
    a.history.push(serialize());
    applySnapshot(snap);
  }
  return { serialize, serializeWithNodeText, pushSnapshot, undo, redo };
}
