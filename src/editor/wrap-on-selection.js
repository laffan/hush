import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

/**
 * Replacement for `closeBrackets()` that only acts when text is selected.
 * Typing `"`, `'`, `` ` ``, `(`, `[`, or `{` with a non-empty selection
 * wraps the selection with the matching pair; with no selection the
 * keystroke falls through to the editor's default text insertion so the
 * user gets a single character without any phantom closer to delete.
 */
const PAIRS = { '"': '"', "'": "'", "(": ")", "[": "]", "{": "}", "`": "`" };

export const wrapOnSelection = EditorView.inputHandler.of((view, from, to, text) => {
  const close = PAIRS[text];
  if (!close) return false;
  const ranges = view.state.selection.ranges;
  if (!ranges.some((r) => !r.empty)) return false;
  const tr = view.state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(range.from + text.length),
      };
    }
    const selected = view.state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: text + selected + close },
      range: EditorSelection.range(range.from + text.length, range.to + text.length),
    };
  });
  view.dispatch(tr, { userEvent: "input.type" });
  return true;
});
