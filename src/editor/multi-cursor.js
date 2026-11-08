/**
 * Multiple cursors — ⌥-click in the text adds a cursor (or, ⌥-dragged, a
 * selection) beside the ones already there, and typing, deleting and
 * pasting then happen at every one of them. Escape goes back to the main
 * cursor alone. ⌥-click on a cursor that is already there removes it
 * (CodeMirror's own toggle for an added range).
 *
 * CodeMirror keeps one selection unless `allowMultipleSelections` is on;
 * `clickAddsSelectionRange` moves the add-a-range click from its default
 * (⌘-click on macOS, which Hush gives to links and the window) to ⌥.
 * `drawSelection` (in both extension lists already) draws the extra
 * carets, as `.cm-cursor-secondary`, so every cursor mode's `.cm-cursor`
 * rules apply to them too.
 *
 * Carried by BOTH extension lists, like everything the user types with.
 * Commands that act on "the" cursor (sentence moves, ⌘L, the outline's
 * moves) keep acting on the main one.
 */
import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";

/** Escape with more than one cursor: keep only the main one. Otherwise
 *  the key falls through to whatever else Escape does. */
function collapseToMain(view) {
  const sel = view.state.selection;
  if (sel.ranges.length < 2) return false;
  view.dispatch({ selection: EditorSelection.create([sel.main]), scrollIntoView: true });
  return true;
}

export function multiCursorExtension() {
  return [
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey),
    Prec.highest(keymap.of([{ key: "Escape", run: collapseToMain }])),
  ];
}
