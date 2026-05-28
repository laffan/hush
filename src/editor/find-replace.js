/**
 * Find & Replace entry points — both Cmd+F and the cross-files variant
 * now mount the sidebar Find panel (see src/sidebar/find-panel.js). The
 * old floating find-bar / find-all overlays have been retired in favour
 * of a single, unified panel that:
 *   - shows current-document matches first, then the rest of the desk
 *   - highlights matches inline in the editor
 *   - supports replace via a twirl-disclosed input + "global" toggle
 */

import { findPanelGoNext, findPanelGoPrev, closeFindPanel } from "../sidebar/find-panel.js";

/**
 * Open the Find panel. If the editor has a non-empty selection, that text
 * pre-populates the search field (matching VS Code / TextEdit behaviour).
 */
export function openFindReplace(view, state) {
  const initialQuery = readSelectionAsQuery(view, state);
  state.emit("show-find-panel", { initialQuery });
}

/**
 * Cross-file find historically lived in a separate floating panel. With
 * the sidebar redesign there's just one panel that already covers the
 * whole desk, so this is a thin alias.
 */
export function openFindAll(view, state) {
  openFindReplace(view, state);
}

/** Cmd+G — advance to the next match within the find panel. Returns true
 *  only when the panel is open so the binding can fall through otherwise. */
export function findNext() {
  return findPanelGoNext();
}

/** Cmd+Shift+G — previous match. */
export function findPrev() {
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
