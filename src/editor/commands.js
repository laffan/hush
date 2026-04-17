/**
 * Editor command registry.
 *
 * This is the single authoritative list of what every user-customizable
 * shortcut actually *does*.  Each entry maps a settings key (e.g.
 * `shortcutBold`) to a handler `(state, view) => boolean | void`.
 *
 * The same map is consumed by:
 *   - `editor.js`, which turns it into a CodeMirror keymap using the
 *     user's stored shortcut strings.
 *   - `main.js`, which uses it as a fallback dispatcher for window
 *     keydown events (e.g. when focus is in a sidebar input).
 *
 * Adding a new shortcut is a three-step job:
 *   1. Add a field to `AppSettings` (Rust) with a default.
 *   2. Add an entry to `shortcutCategories` in `settings/settings-tabs.js`.
 *   3. Add a command handler here.
 */

import { EditorSelection } from "@codemirror/state";
import { openSettingsWindow } from "../settings/settings-ui.js";
import { openFindReplace, openFindAll, findNext, findPrev } from "./find-replace.js";
import { getLockedStyleId } from "../sidebar/styles-panel.js";
import { toggleCommandPalette } from "../command-palette.js";
import {
  selectSentence, reduceSentenceSelection, shiftSelectionToNextSentence,
  shiftSelectionToPreviousSentence, moveSentenceForward, moveSentenceBack,
  deleteToSentenceEnd, jumpToNextSentence, jumpToPrevSentence,
  jumpToPrevParagraph, jumpToNextParagraph, joinLines, selectParagraph,
} from "./sentence-navigator.js";
import {
  toggleBold, toggleItalic, toggleHighlight, toggleComment, toggleStrikethrough,
} from "./formatting.js";
import { insertFootnote } from "./plugins/footnotes.js";
import { openZoteroModal } from "../zotero.js";

/** Multi-cursor "select next occurrence" — was inline in editor.js. */
function selectNextInstance(view) {
  const sel = view.state.selection.main;
  if (sel.empty) {
    const line = view.state.doc.lineAt(sel.head);
    const text = line.text;
    const offset = sel.head - line.from;
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    if (start !== end) {
      view.dispatch({ selection: { anchor: line.from + start, head: line.from + end } });
    }
    return true;
  }
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const docText = view.state.doc.toString();
  const allRanges = view.state.selection.ranges;
  const lastRange = allRanges[allRanges.length - 1];
  const searchFrom = Math.max(lastRange.from, lastRange.to);
  let nextIdx = docText.indexOf(selected, searchFrom);
  if (nextIdx === -1) nextIdx = docText.indexOf(selected, 0);
  const alreadySelected = allRanges.some((r) => {
    const from = Math.min(r.anchor, r.head);
    return from === nextIdx;
  });
  if (nextIdx !== -1 && !alreadySelected) {
    const ranges = allRanges.map((r) => EditorSelection.range(r.anchor, r.head));
    ranges.push(EditorSelection.range(nextIdx, nextIdx + selected.length));
    view.dispatch({
      selection: EditorSelection.create(ranges, ranges.length - 1),
    });
  }
  return true;
}

/** Multi-cursor "select previous occurrence". */
function selectPreviousInstance(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const docText = view.state.doc.toString();
  const allRanges = view.state.selection.ranges;
  const firstRange = allRanges[0];
  const searchBefore = Math.min(firstRange.from, firstRange.to);
  let prevIdx = docText.lastIndexOf(selected, searchBefore - 1);
  if (prevIdx === -1) prevIdx = docText.lastIndexOf(selected);
  const alreadySelected = allRanges.some((r) => {
    const from = Math.min(r.anchor, r.head);
    return from === prevIdx;
  });
  if (prevIdx !== -1 && !alreadySelected) {
    const ranges = allRanges.map((r) => EditorSelection.range(r.anchor, r.head));
    ranges.unshift(EditorSelection.range(prevIdx, prevIdx + selected.length));
    view.dispatch({
      selection: EditorSelection.create(ranges, 0),
    });
  }
  return true;
}

/**
 * Switch to a style by index (0 = Default, 1–4 = first four user styles).
 * Shows a brief toast if the current document has a locked style.
 */
function switchStyleByIndex(state, index) {
  const lockedId = getLockedStyleId(state);
  if (lockedId) {
    showLockedStyleToast(state);
    return true;
  }
  const styles = state.settings.styles || [];
  const targetId = index === 0 ? null : (styles[index - 1]?.id ?? null);
  // Index beyond available styles — ignore silently
  if (index > 0 && !styles[index - 1]) return true;
  if (state.settings.activeStyleId !== targetId) {
    state.updateSettings({ activeStyleId: targetId, globalStyleId: targetId });
    state.emit("style-changed");
  }
  return true;
}

/** Show a brief auto-dismissing toast when a locked style blocks switching. */
function showLockedStyleToast(state) {
  // Remove any existing toast
  document.querySelectorAll(".style-locked-toast").forEach(el => el.remove());
  const toast = document.createElement("div");
  toast.className = "style-locked-toast";
  // Determine locked style name
  const lockedId = getLockedStyleId(state);
  let styleName = "Default";
  if (lockedId && lockedId !== "__default__") {
    const s = (state.settings.styles || []).find(st => st.id === lockedId);
    if (s) styleName = s.name;
  }
  toast.textContent = `Style locked to "${styleName}" for this document`;
  document.body.appendChild(toast);
  // Force reflow then add visible class for transition
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add("visible");
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * Returns the full commands map, ready to feed into
 * `buildCodeMirrorKeymap(state, commands)` or `dispatchDomShortcut(...)`.
 *
 * Every handler takes `(state, view)`.  `view` may be `null` when invoked
 * from the window-level DOM fallback — handlers that need the editor view
 * should bail out gracefully in that case.
 */
export function buildEditorCommands() {
  // IMPORTANT: Iteration order matters for conflict resolution.  If two
  // shortcuts map to the same key combo (usually via a user customisation),
  // the first one in this object wins — CodeMirror picks the first matching
  // binding.  Default bindings are chosen to avoid clashes out of the box.
  return {
    // ===== General =====
    shortcutFind: (state, view) => {
      if (!view) return false;
      openFindReplace(view, state);
      return true;
    },
    shortcutFindAll: (state, view) => {
      if (!view) return false;
      openFindAll(view, state);
      return true;
    },
    shortcutOpenFullscreen: (state) => { state.toggleFullscreen(); return true; },
    shortcutTogglePrivate: (state) => { state.togglePrivate(); return true; },
    shortcutToggleSidebar: (state) => { state.emit("toggle-left-panel"); return true; },
    shortcutToggleOutline: (state) => { state.emit("toggle-outline-panel"); return true; },
    shortcutTypewriter: (state) => { state.toggleTypewriter(); return true; },
    shortcutToggleDry: (state) => { state.toggleDry(); return true; },
    shortcutToggleFocus: (state) => { state.toggleFocus(); return true; },
    shortcutNewFile: (state) => { state.newFile(); return true; },
    shortcutSave: (state) => {
      state.saveCurrentFile();
      if (typeof state.createManualSnapshot === "function") state.createManualSnapshot();
      return true;
    },
    // findNext/findPrev return `true` only when the find bar is open; we
    // propagate that so the binding falls through to browser/default
    // behaviour when there's nothing to navigate.
    shortcutFindNext: () => findNext(),
    shortcutFindPrev: () => findPrev(),
    shortcutZotero: (state, view) => {
      if (!view) return false;
      openZoteroModal(view, state);
      return true;
    },

    // ===== Styles =====
    shortcutStyleDefault: (state) => switchStyleByIndex(state, 0),
    shortcutStyle1: (state) => switchStyleByIndex(state, 1),
    shortcutStyle2: (state) => switchStyleByIndex(state, 2),
    shortcutStyle3: (state) => switchStyleByIndex(state, 3),
    shortcutStyle4: (state) => switchStyleByIndex(state, 4),

    // ===== Editing =====
    shortcutSelectSentence: (_state, view) => (view ? selectSentence(view) : false),
    shortcutSelectParagraph: (_state, view) => (view ? selectParagraph(view) : false),
    shortcutReduceSentence: (_state, view) => (view ? reduceSentenceSelection(view) : false),
    shortcutSelectNext: (_state, view) => (view ? selectNextInstance(view) : false),
    shortcutSelectPrevious: (_state, view) => (view ? selectPreviousInstance(view) : false),
    shortcutJumpNextSentence: (_state, view) => (view ? jumpToNextSentence(view) : false),
    shortcutJumpPrevSentence: (_state, view) => (view ? jumpToPrevSentence(view) : false),
    shortcutJumpNextParagraph: (_state, view) => (view ? jumpToNextParagraph(view) : false),
    shortcutJumpPrevParagraph: (_state, view) => (view ? jumpToPrevParagraph(view) : false),
    shortcutNextSentence: (_state, view) => (view ? shiftSelectionToNextSentence(view) : false),
    shortcutPrevSentence: (_state, view) => (view ? shiftSelectionToPreviousSentence(view) : false),
    shortcutMoveSentenceForward: (_state, view) => (view ? moveSentenceForward(view) : false),
    shortcutMoveSentenceBack: (_state, view) => (view ? moveSentenceBack(view) : false),
    shortcutDeleteToSentenceEnd: (_state, view) => (view ? deleteToSentenceEnd(view) : false),
    shortcutJoinLines: (_state, view) => (view ? joinLines(view) : false),

    // ===== Formatting =====
    shortcutBold: (_state, view) => (view ? toggleBold(view) : false),
    shortcutItalic: (_state, view) => (view ? toggleItalic(view) : false),
    shortcutHighlight: (_state, view) => (view ? toggleHighlight(view) : false),
    shortcutComment: (_state, view) => (view ? toggleComment(view) : false),
    shortcutStrikethrough: (_state, view) => (view ? toggleStrikethrough(view) : false),
    shortcutInsertFootnote: (_state, view) => (view ? insertFootnote(view) : false),
  };
}

/**
 * Hardcoded bindings that are *not* user-customizable.  Platform
 * conventions like `Cmd+,` to open settings belong here.  Everything
 * else should live in `buildEditorCommands()` so users can change it.
 */
export function buildFixedKeymap(state) {
  return [
    { key: "Mod-,", run: () => { openSettingsWindow(state); return true; } },
    { key: "Mod-p", run: () => { toggleCommandPalette(state); return true; } },
  ];
}
