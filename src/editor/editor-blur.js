/**
 * The main editor's blur handler.
 *
 * Blur rename-checks — catches "user clicked the sidebar / command
 * palette while the cursor was still on line 1." It also collapses the
 * DOM selection, so the next click into `cm-content` lands a fresh
 * single-point cursor instead of extending the old browser-side range to
 * the click position (Chrome/WebKit both treat the leftover selection as
 * a live anchor for mousedown when the editor regains focus via a click
 * into the margin and back).
 *
 * Except on iPad when the whole web view lost focus. The system emoji
 * picker takes focus from the web view and then inserts at the selection
 * the page left behind; with that selection cleared, a picked emoji went
 * nowhere. So on iOS the collapse waits a tick and is skipped when the
 * document itself no longer has focus — the picker, or the app going to
 * the background — and still runs when focus moved on inside Hush.
 */
import { EditorView } from "@codemirror/view";
import { isIOS } from "../settings/settings-ui.js";

function collapseSelectionIn(view) {
  try {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (view.contentDOM.contains(range.startContainer) || view.contentDOM.contains(range.endContainer)) {
      sel.removeAllRanges();
    }
  } catch (_) { /* ignore — selection inspection can throw across shadow boundaries */ }
}

export function createMainEditorBlurListener(state) {
  const ios = isIOS();
  return EditorView.domEventHandlers({
    blur: (_, view) => {
      queueMicrotask(() => { void state.maybeRenameFromFirstLine?.(); });
      if (!ios) {
        collapseSelectionIn(view);
        return;
      }
      setTimeout(() => {
        if (view.hasFocus || !document.hasFocus()) return;
        collapseSelectionIn(view);
      }, 0);
    },
  });
}
