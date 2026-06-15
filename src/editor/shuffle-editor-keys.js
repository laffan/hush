/**
 * Shuffle Editor — keyboard handling.
 *
 * Extracted so the lifecycle file stays under the repo's 700-line cap.
 * Installs a capture-phase keydown listener for the open overlay:
 *
 *   • Escape — close (or dismiss the compare modal).
 *   • Cmd/Ctrl+Z — structural undo (yields to native text undo while a node
 *     is being edited).
 *   • Cmd/Ctrl+↑/↓ — shift the current sentence; Shift+↑/↓ — move the focus.
 *     These work even while a node is being edited (overriding the default
 *     caret movement).
 *   • a / d / s / c — act on the hovered sentence, falling back to the
 *     focused one; hover always wins. Only when not editing / comparing.
 */

export function installShuffleKeyboard(active, ctrl, hooks) {
  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (active.compare) hooks.dismissCompare(); else hooks.beginClose();
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    const editing = !!document.activeElement?.isContentEditable;
    if (meta && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      if (editing) return; // let the browser handle text undo
      e.preventDefault();
      ctrl.undo();
      return;
    }
    // Arrow nav works whether or not a sentence is being edited.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (meta || e.shiftKey)) {
      e.preventDefault();
      ctrl.arrowNav(e.key === "ArrowUp" ? -1 : 1, meta);
      return;
    }
    if (active.compare || editing) return;
    // Hover wins; fall back to the focused (selected) sentence.
    const target = active.hoverNode || active.focusNode;
    if (meta || e.shiftKey || e.altKey || !target) return;
    const k = e.key.toLowerCase();
    if (k === "a") { e.preventDefault(); ctrl.moveNodeToEditor(target); }
    else if (k === "d") { e.preventDefault(); ctrl.moveNodeToMargin(target); }
    else if (k === "s") { e.preventDefault(); ctrl.toggleNodeFlag(target, "strike"); }
    else if (k === "c") { e.preventDefault(); ctrl.toggleNodeFlag(target, "comment"); }
  };
  document.addEventListener("keydown", onKeydown, true);
  return () => document.removeEventListener("keydown", onKeydown, true);
}
