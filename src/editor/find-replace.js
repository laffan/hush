/**
 * Find & Replace entry points. The two are separate surfaces, split by
 * scope rather than by capability — each does find and replace for the
 * scope it owns:
 *   - Cmd+F → the quick-find bar (`quick-find.js`), floating over the
 *     focused editor: matches in that one surface, with a twirl-
 *     disclosed replacement that rewrites all of them at once.
 *   - Cmd+Shift+F → the sidebar Find panel (`sidebar/find-panel.js`):
 *     current document first, then the rest of the desk, with a replace
 *     that rewrites every match in every document listed.
 */

import { findPanelGoNext, findPanelGoPrev, closeFindPanel } from "../sidebar/find-panel.js";
import { isQuickFindOpen, quickFindGoNext, quickFindGoPrev, openQuickFind, closeQuickFind } from "./quick-find.js";

/**
 * Open the Find panel. If the editor has a non-empty selection, that text
 * pre-populates the search field (matching VS Code / TextEdit behaviour).
 */
export function openFindReplace(view, state) {
  const initialQuery = readSelectionAsQuery(view, state);
  state.emit("show-find-panel", { initialQuery });
}

/**
 * Open the minimal current-document quick find (Cmd+F). Requires a live
 * CodeMirror view — notebooks/stacks without a focused editor get nothing.
 */
export function openQuickFindBar(view, state) {
  // Second press of the bound shortcut closes the bar — keeps the
  // find-and-go feel tight (open, jump, dismiss with the same key).
  if (isQuickFindOpen()) {
    closeQuickFind();
    return true;
  }
  // Within-document find is doc-shaped, so it means different things per
  // surface:
  //   - Stacks: no single document to search → disabled outright (return
  //     true so the keystroke is swallowed rather than half-opening a bar
  //     against one column).
  //   - Notebooks: open the shape shelf and focus its Search box — but
  //     only when no editor actually holds focus. A focused doc/PDF pane
  //     floating over the canvas still gets its own quick-find bar (the
  //     `view` we get there is the focused pane, not the stale main one).
  if (state && state.currentStackFileId) return true;
  const viewFocused = !!(view && view.hasFocus);
  if (state && state.currentNotebookFileId && !viewFocused) {
    state.emit("notebook-open-shelf-search");
    return true;
  }
  const v = view || (state && state.editor ? state.editor.view : null);
  if (!v) return false;
  return openQuickFind(v);
}

/** Cmd+G — advance to the next match. Prefers the quick-find bar when it's
 *  open, otherwise drives the sidebar Find panel. Returns true only when
 *  something handled it so the binding can fall through otherwise. */
export function findNext() {
  if (isQuickFindOpen()) return quickFindGoNext();
  return findPanelGoNext();
}

/** Cmd+Shift+G — previous match. */
export function findPrev() {
  if (isQuickFindOpen()) return quickFindGoPrev();
  return findPanelGoPrev();
}

/** Programmatic close (used by Esc handling in callers that own the bar). */
export function closeFind() {
  closeFindPanel();
}

function readSelectionAsQuery(view, state) {
  // Editor selection wins — it's the conventional "selected text seeds
  // the search field" behaviour. Fall back to the OS-level selection so
  // notebooks (whose text shapes don't use CodeMirror) and stack tiles
  // still feed the search field when the user has highlighted text.
  if (view && view.state) {
    const sel = view.state.selection.main;
    if (sel && !sel.empty) {
      const slice = view.state.sliceDoc(sel.from, sel.to);
      if (slice && !slice.includes("\n")) return slice;
    }
  }
  try {
    const docSel = window.getSelection?.();
    if (docSel && docSel.rangeCount > 0) {
      const text = docSel.toString();
      if (text && !text.includes("\n") && text.length < 200) return text;
    }
  } catch (_) {}
  return "";
}
