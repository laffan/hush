import { EditorView, keymap, drawSelection, placeholder, ViewPlugin } from "@codemirror/view";
import { EditorState, Prec, Compartment, Annotation } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { wrapOnSelection } from "./wrap-on-selection.js";
import { getActiveTheme } from "../themes/index.js";
import { createPrivateModePlugin } from "./plugins/private-mode.js";
import { createDryHighlightPlugin } from "./plugins/dry-highlight.js";
import { createFootnotePlugin } from "./plugins/footnotes.js";
import { createProjectViewField, createSeparatorFilter, bypassSeparatorFilter } from "./plugins/project-view.js";
import { createFocusModePlugin } from "./plugins/focus-mode.js";
import { createCalloutPlugin } from "./plugins/callouts.js";
import { createLinkDecoratorPlugin } from "./plugins/link-decorator.js";
import { createWikilinkPlugin } from "./plugins/wikilink-decorator.js";
import { createInlinePanePlugin, openInlinePaneForWikilink } from "../pane/pane-inline.js";
import { createTabMarkerPlugin } from "./plugins/tab-marker.js";
import { createCheckboxListPlugin } from "./plugins/checkbox-list.js";
import { createImageDecoratorPlugin } from "./plugins/image-decorator.js";
import { initEncourageTyping, clearEncourageTyping, onEncourageKeystroke, getEncourageDecorations } from "./plugins/encourage-typing.js";
import {
  setupTypewriterBoundary, removeTypewriterBoundary, applyTypewriterPadding,
  scrollCursorToTypewriterLine, getTypewriterBoundary, repositionTypewriterBoundary,
  ensureTypewriterRunway, stripTypewriterRunway, stripTypewriterRunwayText,
  typewriterRunwayAnnotation,
} from "./plugins/typewriter.js";
import { applyModes, applyFullscreen, updateColumnResizers, updateRatchetTimer, applyEditorScrollerPadding } from "./modes.js";
import { updateWordCountDisplay, scheduleWordCountRecompute } from "./plugins/word-count.js";
import { createStickyHeadersPlugin, updateStickyHeaders } from "./plugins/sticky-headers.js";
import { headingIndentPlugin } from "./heading-indent.js";
import { findHighlightField } from "./find-decorations.js";
import { instanceHighlightField } from "./select-instance-highlight.js";
import { createMultiLineCommentPlugin, createCommentAfterPlugin } from "./comment-plugins.js";
import { createGoogleDocsPasteExtension } from "./google-docs/paste-extension.js";
import { createGrammarCheckPlugin, createGrammarHoverTooltip } from "./plugins/grammar-check.js";
import { getMarkdownHighlight, resolveHeaderColorOverride } from "./markdown-highlight.js";
import {
  commentTag, commentMarkTag, highlightTag, highlightMarkTag,
  CommentExtension, HighlightExtension,
} from "./markdown-extensions.js";
import { createFlagHighlightPlugin, hexToRgba } from "./flag-highlight.js";
import {
  defaultLocalSyncContext, buildShortcutExtension, createBaseExtensions,
} from "./base-extensions.js";
import { applyBlockCursor } from "./block-cursor.js";
import { bindLineIndicatorToContainer, createLineIndicatorPlugin } from "./line-indicator.js";

// Re-export for callers that imported these from editor.js historically.
export { headingIndentPlugin, createMultiLineCommentPlugin, createCommentAfterPlugin };
export { getMarkdownHighlight, resolveHeaderColorOverride };
export { commentTag, commentMarkTag, highlightTag, highlightMarkTag };
export { CommentExtension, HighlightExtension };
export { hexToRgba, createFlagHighlightPlugin };
export { defaultLocalSyncContext, buildShortcutExtension, createBaseExtensions };

const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();
const shortcutCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const bypassRatchet = Annotation.define();

/**
 * Creates the CodeMirror 6 editor instance.
 */
export function createEditor(container, state) {
  // Track the previous cursor line so we can fire a rename when the
  // user moves off line 1. First-line rename is the "filename follows
  // title" behavior users expected — gated on cursor leaving the title
  // to avoid the per-keystroke sync churn the old always-rename path
  // caused on Dropbox.
  let prevCursorLine = 1;
  // Debounced first-line rename. The cursor-leaves-line-1 / blur /
  // autosave-not-on-line-1 triggers below cover most cases, but a user
  // who types a title and never moves their cursor would otherwise
  // never see the file rename. After ~1.5 s of typing idle we run the
  // same `maybeRenameFromFirstLine` flow as the other triggers.
  let titleDebounceTimer = null;
  const TITLE_DEBOUNCE_MS = 1500;
  const updateListener = EditorView.updateListener.of((update) => {
    // Typewriter runway dispatches are app-internal — they don't
    // represent real edits, so skip the dirty / autosave / rename /
    // word-count side effects. (The runway is the blank lines we
    // append at the end of a short doc so the scroll lock has
    // something to slide.)
    const runwayOnly = update.docChanged
      && update.transactions.length > 0
      && update.transactions.every((tr) => tr.annotation(typewriterRunwayAnnotation));
    if (update.docChanged && !runwayOnly) {
      state.markDirty();
      state.trackKeystroke();
      scheduleWordCountRecompute(state);
      if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
      titleDebounceTimer = setTimeout(() => {
        queueMicrotask(() => { void state.maybeRenameFromFirstLine?.(); });
      }, TITLE_DEBOUNCE_MS);
      if (state.ratchetMode) onEncourageKeystroke(update.view, state);
    } else if (update.selectionSet) {
      // Selection changes feed the word count for two reasons:
      // project mode tracks which sub-doc the cursor is in (per-doc /
      // total split), and any mode needs the `.has-selection`
      // hover-pointer-events toggle synced as soon as the user
      // selects or clears text.
      scheduleWordCountRecompute(state);
    }
    if (update.selectionSet || update.docChanged) {
      try {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head).number;
        if (prevCursorLine === 1 && line !== 1) {
          // Fire in a microtask so any in-flight dispatch completes
          // before we trigger rename + tree mutation.
          queueMicrotask(() => { void state.maybeRenameFromFirstLine?.(); });
        }
        prevCursorLine = line;
      } catch { /* ignore — doc may be empty or in-flight */ }
    }
    // Typewriter: keep the cursor on the boundary, and top up the
    // runway whenever the user makes a real edit so the scroll lock
    // always has enough doc length to slide against.
    if (state.typewriterMode && !runwayOnly && (update.docChanged || update.selectionSet || update.focusChanged)) {
      requestAnimationFrame(() => {
        if (update.docChanged) ensureTypewriterRunway(update.view, state);
        scrollCursorToTypewriterLine(update.view, state);
      });
    }
    // Non-typewriter scroll-to-centre: paddingTop is a function of
    // contentHeight (shrinks as content grows). Recompute when the
    // doc changes so the last line stays reachable at the vertical
    // midpoint across short → long transitions.
    if (update.docChanged && !state.typewriterMode) {
      requestAnimationFrame(() => applyEditorScrollerPadding(state));
    }
    // Ratchet: ensure cursor stays at end of document
    if (state.ratchetMode && update.selectionSet) {
      const end = update.state.doc.length;
      const main = update.state.selection.main;
      if (main.anchor !== end || main.head !== end) {
        update.view.dispatch({ selection: { anchor: end } });
      }
    }
  });

  // Editor blur also rename-checks — catches "user clicked the sidebar /
  // command palette while cursor was still on line 1."
  // Also collapse the DOM selection on blur so the next click into
  // `cm-content` lands a fresh single-point cursor instead of extending
  // the old browser-side range to the click position (Chrome/WebKit
  // both treat the leftover selection as a live anchor for mousedown
  // when the editor regains focus via click into the margin and back).
  const blurListener = EditorView.domEventHandlers({
    blur: (_, view) => {
      queueMicrotask(() => { void state.maybeRenameFromFirstLine?.(); });
      try {
        const sel = window.getSelection?.();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (view.contentDOM.contains(range.startContainer) || view.contentDOM.contains(range.endContainer)) {
          sel.removeAllRanges();
        }
      } catch (_) { /* ignore — selection inspection can throw across shadow boundaries */ }
    },
  });

  // Minimal theme
  const hushTheme = EditorView.theme({
    "&": {
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-family)",
      fontSize: "var(--font-size)",
      lineHeight: "var(--line-height)",
    },
    ".cm-content": {
      caretColor: "var(--cursor)",
      fontFamily: "var(--font-family)",
      padding: "0",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--cursor)",
      borderLeftWidth: "2px",
    },
    ".cm-gutters": {
      display: "none",
    },
  });

  // Ratchet mode: block deletion, navigation, selection, undo
  const ratchetBlockedKeys = "Delete ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Mod-ArrowLeft Mod-ArrowRight Mod-ArrowUp Mod-ArrowDown Shift-ArrowLeft Shift-ArrowRight Shift-ArrowUp Shift-ArrowDown Shift-Home Shift-End Mod-Shift-ArrowLeft Mod-Shift-ArrowRight Mod-Shift-ArrowUp Mod-Shift-ArrowDown Mod-a Mod-z Mod-Shift-z Mod-x".split(" ");
  const ratchetKeymap = Prec.highest(
    keymap.of(ratchetBlockedKeys.map(key => ({ key, run: () => state.ratchetMode })))
  );

  // Global keyboard shortcuts — built from `state.settings` so the settings
  // panel can change bindings at runtime via the shortcut compartment.
  const initialShortcuts = buildShortcutExtension(state);

  // Ratchet captures the cursor position when the session starts.
  // Edits before this anchor are forbidden — earlier content is locked.
  // After the anchor, we still honour the "edit the in-progress word"
  // relaxation: the user can backspace within the most recent word
  // they've typed, but not into committed text. Both conditions
  // collapse to one lock point per transaction.
  let ratchetAnchor = 0;

  const ratchetFilter = EditorState.transactionFilter.of((tr) => {
    if (!state.ratchetMode || tr.annotation(bypassRatchet)) return tr;
    if (tr.docChanged) {
      const doc = tr.startState.doc.toString();
      // Look for the most recent whitespace at or after `ratchetAnchor`
      // and before the cursor — this is the boundary of the user's
      // current in-progress word. Searching globally (the previous
      // implementation) broke mid-document ratchet sessions because
      // the last whitespace in the *whole* doc is usually past where
      // the user is editing, locking out their cursor entirely.
      const cursor = tr.startState.selection.main.head;
      let wordStart = ratchetAnchor;
      for (let i = cursor - 1; i >= ratchetAnchor; i--) {
        const c = doc.charCodeAt(i);
        if (c === 32 /* space */ || c === 10 /* \n */) { wordStart = i + 1; break; }
      }
      const lockPoint = Math.max(ratchetAnchor, wordStart);

      let reject = false;
      tr.changes.iterChanges((fromA) => {
        if (fromA < lockPoint) reject = true;
      });
      if (reject) return [];
    }
    return tr;
  });

  const ratchetMouseFilter = EditorView.domEventHandlers({
    mousedown: () => state.ratchetMode,
  });

  const activeTheme = getActiveTheme(state.settings);
  const initialCmTheme = activeTheme ? activeTheme.extension : [];

  const privateModePlugin = createPrivateModePlugin(state);
  const dryHighlightPlugin = createDryHighlightPlugin(state);
  const footnotePlugin = createFootnotePlugin(state);
  const focusModePlugin = createFocusModePlugin(state);
  const calloutPlugin = createCalloutPlugin();
  const projectViewField = createProjectViewField(state);
  const separatorFilter = createSeparatorFilter(state);
  const flagHighlightPlugin = createFlagHighlightPlugin(state);
  const linkDecoratorPlugin = createLinkDecoratorPlugin(state);
  const wikilinkPlugin = createWikilinkPlugin(state, {
    onInlinePaneRequest: (_view, { title, occurrence }) =>
      openInlinePaneForWikilink(state, { title, occurrence }),
  });
  const inlinePanePlugin = createInlinePanePlugin(state);
  const tabMarkerPlugin = createTabMarkerPlugin();
  const checkboxListPlugin = createCheckboxListPlugin();
  const imageDecoratorPlugin = createImageDecoratorPlugin(state, () => defaultLocalSyncContext(state));
  const stickyHeadersPlugin = createStickyHeadersPlugin(state);
  const multiLineCommentPlugin = createMultiLineCommentPlugin();
  const commentAfterPlugin = createCommentAfterPlugin();
  const grammarCheckPlugin = createGrammarCheckPlugin(state);
  const grammarHoverTooltip = createGrammarHoverTooltip(state);

  // Encourage typing decorations — fades new text when user stops typing in ratchet mode
  const encouragePlugin = ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = getEncourageDecorations(view); }
      update(update) { this.decorations = getEncourageDecorations(update.view); }
    },
    { decorations: (v) => v.decorations }
  );

  const startState = EditorState.create({
    doc: "",
    extensions: [
      hushTheme,
      themeCompartment.of(initialCmTheme),
      highlightCompartment.of(syntaxHighlighting((() => {
        const _s = state.settings.activeStyleId ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId) : null;
        const nh = _s?.suppressHeaderSize ?? state.settings.normalizeHeaders;
        const nhc = _s?.suppressHeaderColor ?? state.settings.normalizeHeaderColor;
        const hScale = _s?.headerScale ?? state.settings.headerScale ?? 1.0;
        const headerOverride = resolveHeaderColorOverride(state, _s);
        const underline = _s?.underlineHeaders ?? state.settings.underlineHeaders ?? false;
        return getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || getActiveTheme(state.settings)?.headingColor), hScale, { underline });
      })())),
      markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      wrapOnSelection,
      updateListener,
      blurListener,
      shortcutCompartment.of(initialShortcuts),
      readOnlyCompartment.of([]),
      ratchetKeymap,
      ratchetFilter,
      ratchetMouseFilter,
      privateModePlugin,
      dryHighlightPlugin,
      focusModePlugin,
      calloutPlugin,
      footnotePlugin,
      flagHighlightPlugin,
      createLineIndicatorPlugin(state),
      linkDecoratorPlugin,
      wikilinkPlugin,
      inlinePanePlugin,
      tabMarkerPlugin,
      checkboxListPlugin,
      imageDecoratorPlugin,
      createGoogleDocsPasteExtension(),
      headingIndentPlugin,
      findHighlightField,
      instanceHighlightField,
      stickyHeadersPlugin,
      multiLineCommentPlugin,
      commentAfterPlugin,
      grammarCheckPlugin,
      grammarHoverTooltip,
      encouragePlugin,
      projectViewField,
      separatorFilter,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      placeholder("Start writing..."),
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({
    state: startState,
    parent: container,
  });

  state.on("mode-changed", () => {
    applyModes(state);
    updateRatchetTimer(state);
    updateWordCountDisplay(state);
    view.dispatch({ effects: [] });
    if (state.ratchetMode) {
      // Anchor at the user's current cursor position so they can
      // continue writing from wherever they were. The previous
      // behaviour shoved the cursor to the end of the document — fine
      // for an empty doc, hostile when starting mid-thought.
      ratchetAnchor = view.state.selection.main.head;
      view.focus();
      initEncourageTyping(view, state, bypassRatchet);
    } else {
      ratchetAnchor = 0;
      clearEncourageTyping();
    }
    if (state.typewriterMode) {
      setupTypewriterBoundary(view, state);
    } else {
      stripTypewriterRunway(view);
      removeTypewriterBoundary(view, state);
      // Restore the short-doc-aware paddingTop / 50vh paddingBottom
      // that the typewriter just blew away.
      applyEditorScrollerPadding(state);
    }
  });

  state.on("fullscreen-changed", async () => {
    await applyFullscreen(state);
    // macOS fullscreen transition desynchronises CodeMirror's internal
    // focus state from the DOM: activeElement stays on cm-content and
    // hasFocus() recovers, but CM still ignores key events.  Blur then
    // re-focus forces CM to re-run its focusin handler.
    function refocusEditor() {
      view.contentDOM.blur();
      view.focus();
    }
    setTimeout(() => {
      refocusEditor();
      if (state.typewriterMode && getTypewriterBoundary()) {
        repositionTypewriterBoundary(state);
        applyTypewriterPadding(view, state);
        requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
      }
    }, 100);
  });

  window.addEventListener("resize", () => {
    if (state.typewriterMode && getTypewriterBoundary()) {
      repositionTypewriterBoundary(state);
      applyTypewriterPadding(view, state);
      requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
    }
  });

  // iPad: visualViewport resize (keyboard show/hide) triggers typewriter repositioning
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (state.typewriterMode && getTypewriterBoundary()) {
        repositionTypewriterBoundary(state);
        applyTypewriterPadding(view, state);
      }
      if (state.typewriterMode) {
        requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
      }
    });
  }

  updateColumnResizers(state);
  applyBlockCursor(state);
  bindLineIndicatorToContainer(document.getElementById("editor-container"), state);
  updateWordCountDisplay(state);
  state.on("file-opened", () => scheduleWordCountRecompute(state));

  state.on("style-changed", () => applyBlockCursor(state));

  function resolveHeaderArgs() {
    const t = getActiveTheme(state.settings);
    const _activeStyle = state.settings.activeStyleId
      ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId)
      : null;
    const normalizeHeaders = _activeStyle?.suppressHeaderSize ?? state.settings.normalizeHeaders;
    const normalizeHeaderColor = _activeStyle?.suppressHeaderColor ?? state.settings.normalizeHeaderColor;
    const hScale = _activeStyle?.headerScale ?? state.settings.headerScale ?? 1.0;
    const headerOverride = resolveHeaderColorOverride(state, _activeStyle);
    const headingColor = normalizeHeaderColor ? undefined : (headerOverride || t?.headingColor);
    const underline = _activeStyle?.underlineHeaders ?? state.settings.underlineHeaders ?? false;
    return { t, normalizeHeaders, headingColor, hScale, underline };
  }

  state.on("theme-changed", () => {
    const { t, normalizeHeaders, headingColor, hScale, underline } = resolveHeaderArgs();
    view.dispatch({ effects: [
      themeCompartment.reconfigure(t ? t.extension : []),
      highlightCompartment.reconfigure(
        syntaxHighlighting(getMarkdownHighlight(normalizeHeaders, headingColor, hScale, { underline }))
      ),
    ] });
  });

  state.on("settings-changed", () => {
    updateWordCountDisplay(state);
    const _activeStyle = state.settings.activeStyleId
      ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId)
      : null;
    const _fs = _activeStyle?.fontSize || state.settings.fontSize;
    document.documentElement.style.setProperty("--font-size", _fs + "px");
    const _lh = _activeStyle?.lineHeight || state.settings.lineHeight;
    document.documentElement.style.setProperty("--line-height", _lh);
    const { normalizeHeaders, headingColor, hScale, underline } = resolveHeaderArgs();
    view.dispatch({
      effects: [
        highlightCompartment.reconfigure(
          syntaxHighlighting(getMarkdownHighlight(normalizeHeaders, headingColor, hScale, { underline }))
        ),
        // Rebuild the shortcut keymap from the freshly-saved settings so
        // edits in the Settings > Shortcuts panel take effect immediately
        // (no restart needed).
        shortcutCompartment.reconfigure(buildShortcutExtension(state)),
      ],
    });
    // Update typewriter line opacity
    if (getTypewriterBoundary()) {
      getTypewriterBoundary().style.opacity = state.settings.typewriterLineOpacity ?? 0.08;
    }
    // Toggle sticky headers
    updateStickyHeaders(view, state);
    // Toggle block cursor
    applyBlockCursor(state);
  });

  return {
    view,
    getContent: () => {
      const text = view.state.doc.toString();
      // While typewriter mode is on the doc carries an artificial
      // runway of trailing blank lines. Every consumer of the editor
      // text (autosave, sync, word count, paste, etc.) should see the
      // clean version.
      return state.typewriterMode ? stripTypewriterRunwayText(text) : text;
    },
    setContent: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [bypassRatchet.of(true), bypassSeparatorFilter.of(true)],
      });
      // Seed the runway for the freshly-loaded doc — without this a
      // file-switch while typewriter is on would land short docs back
      // in the broken state until the user's next keystroke.
      if (state.typewriterMode) ensureTypewriterRunway(view, state);
    },
    focus: () => view.focus(),
    reconfigureTheme: (ext) => {
      view.dispatch({ effects: themeCompartment.reconfigure(ext || []) });
    },
    /** Toggle a hard read-only lock on the editor — used for trashed
     *  files so the user can still read them without the risk of edits
     *  being autosaved into a file they meant to delete. */
    setReadOnly: (ro) => {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(
          ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
        ),
      });
    },
  };
}
