import { EditorView, keymap, drawSelection, placeholder, ViewPlugin, Decoration } from "@codemirror/view";
import { EditorState, Prec, Compartment, Annotation, RangeSetBuilder } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Tag } from "@lezer/highlight";
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
import { createTabMarkerPlugin } from "./plugins/tab-marker.js";
import { createCheckboxListPlugin } from "./plugins/checkbox-list.js";
import { createImageDecoratorPlugin } from "./plugins/image-decorator.js";
import { initEncourageTyping, clearEncourageTyping, onEncourageKeystroke, getEncourageDecorations } from "./plugins/encourage-typing.js";
import { setupTypewriterBoundary, removeTypewriterBoundary, applyTypewriterPadding, scrollCursorToTypewriterLine, getTypewriterBoundary, repositionTypewriterBoundary } from "./plugins/typewriter.js";
import { applyModes, applyFullscreen, updateColumnResizers, updateRatchetTimer } from "./modes.js";
import { updateWordCountDisplay, scheduleWordCountRecompute } from "./plugins/word-count.js";
import { createStickyHeadersPlugin, updateStickyHeaders } from "./plugins/sticky-headers.js";
import { buildCodeMirrorKeymap } from "../shortcuts.js";
import { buildEditorCommands, buildFixedKeymap } from "./commands.js";
import { headingIndentPlugin } from "./heading-indent.js";
import { createMultiLineCommentPlugin, createCommentAfterPlugin } from "./comment-plugins.js";
import { arrowUpFix } from "./arrow-up-fix.js";
import { createImagePasteExtension } from "./image-paste.js";
import { createGoogleDocsPasteExtension } from "./google-docs/paste-extension.js";
import { createGrammarCheckPlugin, createGrammarHoverTooltip } from "./plugins/grammar-check.js";
import { getMarkdownHighlight, resolveHeaderColorOverride } from "./markdown-highlight.js";

// Re-export for callers that imported these from editor.js historically.
export { headingIndentPlugin, createMultiLineCommentPlugin, createCommentAfterPlugin };
export { getMarkdownHighlight, resolveHeaderColorOverride };

// Custom tags for our extensions. Comment / Highlight content and their
// `%%` / `==` delimiters get separate tags so the markers can render at
// a much lower opacity than the wrapped content — otherwise the dense
// punctuation reads louder than the prose it's annotating.
export const commentTag = Tag.define();
export const commentMarkTag = Tag.define();
export const highlightTag = Tag.define();
export const highlightMarkTag = Tag.define();

// Custom inline parser for %% comments %%
const CommentDelim = { resolve: "Comment", mark: "CommentMark" };
export const CommentExtension = {
  defineNodes: [
    { name: "Comment", style: commentTag },
    { name: "CommentMark", style: commentMarkTag },
  ],
  parseInline: [{
    name: "Comment",
    parse(cx, next, pos) {
      if (next !== 37 /* % */ || cx.char(pos + 1) !== 37) return -1;
      // Don't match %%%
      if (cx.char(pos + 2) === 37) return -1;
      return cx.addDelimiter(CommentDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

// Custom inline parser for == highlight ==
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
export const HighlightExtension = {
  defineNodes: [
    { name: "Highlight", style: highlightTag },
    { name: "HighlightMark", style: highlightMarkTag },
  ],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
      // Don't match ===
      if (cx.char(pos + 2) === 61) return -1;
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();
const shortcutCompartment = new Compartment();
const bypassRatchet = Annotation.define();

/**
 * Build the shortcut extension for the current settings.  This is wrapped
 * in `Prec.highest` so it wins against CodeMirror's defaults and any
 * plugin keymaps.  Called on startup and again whenever settings change.
 */
/**
 * Default image-context resolver used by the main editor: when the user
 * is editing a Local Sync `.md`, image refs resolve relative to the
 * file's parent directory inside the mounted folder. Pane editors pass
 * their own resolver so the same plugin can render two different
 * contexts simultaneously.
 */
export function defaultLocalSyncContext(state) {
  const cur = state.currentLocalSync;
  if (!cur || !cur.folderId || !cur.relPath) return null;
  const slash = cur.relPath.lastIndexOf("/");
  const baseDir = slash >= 0 ? cur.relPath.slice(0, slash) : "";
  return { kind: "localSync", folderId: cur.folderId, baseDir };
}

export function buildShortcutExtension(state) {
  const commands = buildEditorCommands();
  const userBindings = buildCodeMirrorKeymap(state, commands);
  const fixed = buildFixedKeymap(state);
  return Prec.highest(keymap.of([...userBindings, ...fixed]));
}


export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function createFlagHighlightPlugin(stateRef) {
  const highlightRegex = /==[^=]+==/g;
  // Match `==NAME==`, `==NAME:==`, or `==NAME:content==`. The colon and
  // any trailing content are optional so a bare flag (`==MISSING==`)
  // still picks up its configured colour.
  const flagRegex = /^==([A-Za-z][A-Za-z0-9_-]{0,24})(?::[^=]*)?==$/;
  const defaultColor = "rgba(255, 208, 0, 0.3)";
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }
      buildDecorations(view) {
        const builder = new RangeSetBuilder();
        const doc = view.state.doc.toString();
        const colors = stateRef.settings.flagColors || {};
        let match;
        highlightRegex.lastIndex = 0;
        while ((match = highlightRegex.exec(doc)) !== null) {
          const flagMatch = match[0].match(flagRegex);
          let bg = defaultColor;
          if (flagMatch) {
            const color = colors[flagMatch[1].toUpperCase()];
            if (color) bg = hexToRgba(color, 0.3);
          }
          builder.add(
            match.index,
            match.index + match[0].length,
            Decoration.mark({ attributes: { style: `background-color: ${bg}; border-radius: 2px` } })
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}


/**
 * Build the shared CodeMirror extension set used by both the main editor
 * and floating pane editors.  This is the single source of truth for the
 * Hush writing experience (theme, syntax, shortcuts, plugins).
 *
 * @param {object}   state     AppState
 * @param {function} [onChange] Optional callback fired on every docChanged
 * @param {object}   [opts]
 * @param {function} [opts.getImageContext] Optional resolver returning a
 *   `{ kind: "localSync", folderId, baseDir }` shape so the image
 *   decorator + preview can target sibling files in a Local Sync folder
 *   instead of the global Images store. Defaults to reading
 *   `state.currentLocalSync` (fits the main editor; pane editors pass
 *   their own resolver since they may render a different doc than the
 *   main view).
 * @returns {{ extensions: Extension[], themeComp, highlightComp, shortcutComp }}
 */
export function createBaseExtensions(state, onChange, opts) {
  const getImageContext = opts?.getImageContext || (() => defaultLocalSyncContext(state));
  const _themeComp = new Compartment();
  const _highlightComp = new Compartment();
  const _shortcutComp = new Compartment();
  const _editableComp = new Compartment();

  const activeTheme = getActiveTheme(state.settings);
  const _s = state.settings.activeStyleId
    ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId) : null;
  const nh = _s?.suppressHeaderSize ?? state.settings.normalizeHeaders;
  const nhc = _s?.suppressHeaderColor ?? state.settings.normalizeHeaderColor;
  const hScale = _s?.headerScale ?? state.settings.headerScale ?? 1.0;
  const headerOverride = resolveHeaderColorOverride(state, _s);
  const underlineHeaders = _s?.underlineHeaders ?? state.settings.underlineHeaders ?? false;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) onChange(update);
  });

  const hushTheme = EditorView.theme({
    "&": { height: "100%" },
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
    ".cm-cursor": { borderLeftColor: "var(--cursor)", borderLeftWidth: "2px" },
    ".cm-gutters": { display: "none" },
  });

  const extensions = [
    hushTheme,
    _themeComp.of(activeTheme ? activeTheme.extension : []),
    _highlightComp.of(syntaxHighlighting(
      getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || activeTheme?.headingColor), hScale, { underline: underlineHeaders })
    )),
    markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
    history(),
    drawSelection(),
    wrapOnSelection,
    updateListener,
    _shortcutComp.of(buildShortcutExtension(state)),
    createCalloutPlugin(),
    createFootnotePlugin(state),
    createFlagHighlightPlugin(state),
    createLinkDecoratorPlugin(state),
    createWikilinkPlugin(state),
    createTabMarkerPlugin(),
    createCheckboxListPlugin(),
    createImageDecoratorPlugin(state, getImageContext),
    createImagePasteExtension(state, { getImageContext }),
    createGoogleDocsPasteExtension(),
    headingIndentPlugin,
    createStickyHeadersPlugin(state),
    createMultiLineCommentPlugin(),
    createCommentAfterPlugin(),
    arrowUpFix,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    Prec.highest(keymap.of(buildFixedKeymap(state))),
    placeholder("Start writing..."),
    EditorView.lineWrapping,
    _editableComp.of(EditorView.editable.of(true)),
  ];

  return {
    extensions,
    themeComp: _themeComp,
    highlightComp: _highlightComp,
    editableComp: _editableComp,
    shortcutComp: _shortcutComp,
  };
}

/** Toggle block cursor class and set color to heading color. */
function applyBlockCursor(state) {
  const container = document.getElementById("editor-container");
  if (!container) return;
  let block = !!state.settings.blockCursor;
  // Active style can override
  if (state.settings.activeStyleId && state.settings.styles) {
    const style = state.settings.styles.find(s => s.id === state.settings.activeStyleId);
    if (style && style.blockCursor != null) block = style.blockCursor;
  }
  container.classList.toggle("block-cursor", block);
  const theme = getActiveTheme(state.settings);
  if (theme && theme.headingColor) {
    container.style.setProperty("--block-cursor-color", theme.headingColor);
  } else {
    container.style.removeProperty("--block-cursor-color");
  }
}

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
    if (update.docChanged) {
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
    // Typewriter: scroll cursor to fixed position on every update
    if (state.typewriterMode && (update.docChanged || update.selectionSet || update.focusChanged)) {
      requestAnimationFrame(() => scrollCursorToTypewriterLine(update.view, state));
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
  const wikilinkPlugin = createWikilinkPlugin(state);
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
      ratchetKeymap,
      ratchetFilter,
      ratchetMouseFilter,
      privateModePlugin,
      dryHighlightPlugin,
      focusModePlugin,
      calloutPlugin,
      footnotePlugin,
      flagHighlightPlugin,
      linkDecoratorPlugin,
      wikilinkPlugin,
      tabMarkerPlugin,
      checkboxListPlugin,
      imageDecoratorPlugin,
      createGoogleDocsPasteExtension(),
      headingIndentPlugin,
      stickyHeadersPlugin,
      multiLineCommentPlugin,
      commentAfterPlugin,
      grammarCheckPlugin,
      grammarHoverTooltip,
      encouragePlugin,
      projectViewField,
      separatorFilter,
      arrowUpFix,
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
      removeTypewriterBoundary(view, state);
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
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [bypassRatchet.of(true), bypassSeparatorFilter.of(true)],
      });
    },
    focus: () => view.focus(),
    reconfigureTheme: (ext) => {
      view.dispatch({ effects: themeCompartment.reconfigure(ext || []) });
    },
  };
}
