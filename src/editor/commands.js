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
import { toggleWordCount } from "./plugins/word-count.js";

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
    shortcutTypewriter: (state) => {
      if (state.currentStackFileId) {
        import("../stack/stack-bridge.js").then(({ getStackInstance }) => {
          const inst = getStackInstance();
          if (inst) inst.toggleActiveTypewriter();
        });
        return true;
      }
      state.toggleTypewriter();
      return true;
    },
    shortcutToggleDry: (state) => { state.toggleDry(); return true; },
    shortcutToggleFocus: (state) => { state.toggleFocus(); return true; },
    shortcutZenFocus: (state) => { state.toggleZenFocus(); return true; },
    shortcutToggleWordCount: (state) => toggleWordCount(state),
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
      openZoteroModal(view || null, state);
      return true;
    },

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
