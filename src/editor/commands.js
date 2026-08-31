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
import { openFindReplace, openQuickFindBar, findNext, findPrev } from "./find-replace.js";
import { toggleCommandPalette } from "../command-palette.js";
import {
  selectSentence, reduceSentenceSelection, shiftSelectionToNextSentence,
  shiftSelectionToPreviousSentence, moveSentenceForward, moveSentenceBack,
  deleteToSentenceEnd, jumpToNextSentence, jumpToPrevSentence,
  jumpToPrevParagraph, jumpToNextParagraph, joinLines, joinLinesUp, selectParagraph,
  selectToParagraphAbove, selectToParagraphBelow, insertBreakAfter, insertBreakBefore,
} from "./sentence-navigator.js";
import {
  toggleBold, toggleItalic, toggleHighlight, toggleComment, toggleStrikethrough,
} from "./formatting.js";
import { insertFootnote } from "./plugins/footnotes.js";
import { openZoteroModal } from "../zotero.js";
import { openShuffleEditor } from "./shuffle-editor.js";
import { toggleWordCount } from "./plugins/word-count.js";
import { getActiveModeContext, toggleModeOnContext } from "../state/mode-context.js";
import { setInstanceHighlightsEffect, findAllOccurrences } from "./select-instance-highlight.js";

/** Hunt for an editor surface whose active selection is non-empty and
 *  return a payload the Selection Focus overlay can mount a fresh
 *  CodeMirror against: source view reference (for write-back), the
 *  selection range, the selected text, the column width to mirror, and
 *  the source's font-size in px so the overlay can bump it 10 %. Priority
 *  mirrors the Zen source picker — explicit view arg > active stack
 *  column > active pane > main editor. Returns null when nothing is
 *  selected; the focus shortcut then falls through to its normal
 *  per-context Focus toggle. */
function captureSelectionFocusPayload(state, view) {
  const candidates = [];
  if (view) candidates.push(view);
  const ctx = getActiveModeContext(state);
  if (ctx?.view && !candidates.includes(ctx.view)) candidates.push(ctx.view);
  if (state.editor?.view && !candidates.includes(state.editor.view)) {
    candidates.push(state.editor.view);
  }
  for (const v of candidates) {
    try {
      const sel = v.state.selection.main;
      if (sel.empty) continue;
      const text = v.state.sliceDoc(sel.from, sel.to);
      if (!text.trim()) continue;
      const cs = getComputedStyle(v.contentDOM || v.dom);
      // Column width: measure the content DOM rather than reading the
      // CSS var, so panes / stack columns hand over their own
      // narrower-than-main column instead of the global value.
      const rect = (v.contentDOM || v.dom).getBoundingClientRect();
      const columnWidth = Math.max(200, Math.round(rect.width));
      const fontSizePx = parseFloat(cs.fontSize) || 16;
      return {
        sourceView: v,
        from: sel.from,
        to: sel.to,
        text,
        columnWidth,
        fontSizePx,
      };
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

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
      const word = text.slice(start, end);
      view.dispatch({
        selection: { anchor: line.from + start, head: line.from + end },
        effects: setInstanceHighlightsEffect.of(findAllOccurrences(view.state.doc.toString(), word)),
      });
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
      effects: setInstanceHighlightsEffect.of(findAllOccurrences(docText, selected)),
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
      effects: setInstanceHighlightsEffect.of(findAllOccurrences(docText, selected)),
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
      // The Find panel works without a CodeMirror view too — notebooks /
      // stacks use the window selection fallback for query seeding.
      openFindReplace(view || (state.editor ? state.editor.view : null), state);
      return true;
    },
    // Minimal current-document quick find (Cmd+F). Needs a focused editor;
    // without one, fall through so the keystroke isn't swallowed.
    shortcutQuickFind: (state, view) => openQuickFindBar(view, state),
    shortcutOpenFullscreen: (state) => { state.toggleFullscreen(); return true; },
    shortcutTogglePrivate: (state) => { state.togglePrivate(); return true; },
    shortcutToggleSidebar: (state) => { state.emit("toggle-left-panel"); return true; },
    shortcutToggleOutline: (state) => { state.emit("toggle-outline-panel"); return true; },
    shortcutTypewriter: (state) => toggleModeOnContext(state, "typewriterMode"),
    shortcutToggleDry: (state) => toggleModeOnContext(state, "dryMode"),
    shortcutToggleFocus: (state, view) => {
      // Already inside Selection Focus — the same shortcut exits.
      if (state.selectionFocus) { state.toggleSelectionFocus(); return true; }
      // Non-empty selection in the active editor surface → enter
      // Selection Focus instead of regular per-context Focus mode.
      const captured = captureSelectionFocusPayload(state, view);
      if (captured) { state.toggleSelectionFocus(captured); return true; }
      return toggleModeOnContext(state, "focusMode");
    },
    shortcutZenFocus: (state) => { state.toggleZenFocus(); return true; },
    // Spellcheck rides `createBaseExtensions`, so it reaches panes and
    // stack columns as well as the main editor — `toggleSpellcheck`
    // owns the "is there a doc surface in play" gate (see
    // state-modes.js), and swallows the key either way so the keystroke
    // doesn't fall through to the browser on a canvas.
    shortcutToggleSpellcheck: (state) => { state.toggleSpellcheck(); return true; },
    shortcutToggleWordCount: (state) => toggleWordCount(state),
    // View/Hide properties (metadata frontmatter). Lazy-import keeps the
    // command registry out of the plugin's import cycle with
    // base-extensions.js.
    shortcutToggleProperties: (state) => {
      import("./plugins/properties.js").then((m) => m.togglePropertiesVisibility(state));
      return true;
    },
    shortcutNewFile: (state) => { state.newFile(); return true; },
    shortcutNewFilePane: (state) => {
      // Mirror the "New document as pane" palette entry. The pane and
      // picker modules load lazily so the command registry stays out of
      // their dependency graphs.
      Promise.all([
        import("../command-palette-pickers.js"),
        import("../pane/pane-manager.js"),
      ]).then(async ([pickers, paneManager]) => {
        const created = await state.newFile(null, { openImmediately: false });
        if (!created) return;
        const { x, y } = pickers.paneAnchorClickPoint(state);
        paneManager.createPane(created.fileId, created.name, "document", x, y);
      });
      return true;
    },
    shortcutNewNotebook: (state) => {
      // Mirror promptNewNotebookName (command-palette-pickers) without
      // pulling in that module's heavy dependency graph from the editor
      // command registry — lazy-import the modal helper directly.
      import("../sidebar/files-panel-shared.js").then(({ showPromptModal }) => {
        showPromptModal({
          title: "New notebook",
          label: "Name",
          placeholder: "New Notebook",
          initialValue: "New Notebook",
          confirmLabel: "Create",
          onConfirm: (name) => state.createNotebook(name),
        });
      });
      return true;
    },
    shortcutNewNotebookPane: (state) => {
      // "New notebook as pane" — same name prompt as shortcutNewNotebook,
      // then the created notebook opens as a floating pane instead of
      // taking over the main view.
      import("../sidebar/files-panel-shared.js").then(({ showPromptModal }) => {
        showPromptModal({
          title: "New notebook",
          label: "Name",
          placeholder: "New Notebook",
          initialValue: "New Notebook",
          confirmLabel: "Create",
          onConfirm: async (name) => {
            const [pickers, paneManager] = await Promise.all([
              import("../command-palette-pickers.js"),
              import("../pane/pane-manager.js"),
            ]);
            const created = await state.createNotebook(name, null, { openImmediately: false });
            if (!created) return;
            const { x, y } = pickers.paneAnchorClickPoint(state);
            paneManager.createPane(created.fileId, created.name, "notebook", x, y);
          },
        });
      });
      return true;
    },
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
    // Shuffle Editor (sentences, list-current). Returns false when there's
    // no selection to shuffle so the key falls through.
    shortcutShuffleSentences: (state) => openShuffleEditor(state, "list-current"),
    shortcutSwitchDesks: (state) => {
      const desks = state.settings?.desks || [];
      if (desks.length < 2) return false;
      import("../command-palette.js").then((m) => m.openDeskPalette(state));
      return true;
    },

    // ===== Editing =====
    shortcutSelectSentence: (_state, view) => (view ? selectSentence(view) : false),
    shortcutSelectParagraph: (_state, view) => (view ? selectParagraph(view) : false),
    shortcutSelectParagraphUp: (_state, view) => (view ? selectToParagraphAbove(view) : false),
    shortcutSelectParagraphDown: (_state, view) => (view ? selectToParagraphBelow(view) : false),
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
    shortcutJoinLinesUp: (_state, view) => (view ? joinLinesUp(view) : false),
    // ⌘↩ / ⌘⇧↩. The "after" half was CodeMirror's own `insertBlankLine`
    // riding in with the default keymap; binding it explicitly here puts
    // it in Settings beside its mirror image and makes both rebindable.
    // `buildShortcutExtension` wraps these at Prec.highest, so ours wins
    // over the default without having to unbind it.
    //
    // Both check `hasFocus`, which their neighbours here don't need to.
    // The window-level fallback hands every command `state.editor.view`
    // — the main editor, which is built once at boot and never torn down
    // — so on a canvas these would otherwise open a line in the document
    // hidden behind it. Returning false lets the keystroke fall through
    // instead.
    shortcutInsertBreakAfter: (_state, view) =>
      (view && view.hasFocus ? insertBreakAfter(view) : false),
    shortcutInsertBreakBefore: (_state, view) =>
      (view && view.hasFocus ? insertBreakBefore(view) : false),

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
