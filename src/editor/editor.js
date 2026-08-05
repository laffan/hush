import { EditorView, keymap, drawSelection, placeholder, ViewPlugin } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Strikethrough, Table } from "@lezer/markdown";
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
import { createCitationPlugin } from "./plugins/citation-decorator.js";
import { createInlinePanePlugin, openInlinePaneForWikilink } from "../pane/pane-inline.js";
import { createTabMarkerPlugin } from "./plugins/tab-marker.js";
import { createCheckboxListPlugin } from "./plugins/checkbox-list.js";
import { createTableRendererPlugin } from "./plugins/table-renderer.js";
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
import { createCommentAnchorPlugin } from "./plugins/comment-anchors.js";
import { createGoogleDocsPasteExtension } from "./google-docs/paste-extension.js";
import { createGrammarCheckPlugin, createGrammarHoverTooltip } from "./plugins/grammar-check.js";
import { createSpellcheckPlugin, spellcheckClickHandler } from "./plugins/spellcheck.js";
import { getMarkdownHighlight, resolveHeaderColorOverride } from "./markdown-highlight.js";
import {
  commentTag, commentMarkTag, highlightTag, highlightMarkTag,
  CommentExtension, HighlightExtension,
} from "./markdown-extensions.js";
import { createFlagHighlightPlugin, hexToRgba } from "./flag-highlight.js";
import { createYouAreHerePlugin } from "./plugins/you-are-here.js";
import {
  defaultLocalSyncContext, buildShortcutExtension, createBaseExtensions,
  programmaticAnnotations, isProgrammaticUpdate,
} from "./base-extensions.js";
import { applyBlockCursor } from "./block-cursor.js";
import {
  bypassRatchet, createRatchetExtensions, setRatchetAnchor,
  deskRatchetActive, deskOnlyRatchet,
} from "./ratchet.js";
import { bindLineIndicatorToContainer, createLineIndicatorPlugin } from "./line-indicator.js";
import { buildFoldingExtension } from "./folding.js";
import { createFoldArrowPlugin } from "./fold-arrow.js";
import { createPropertiesPlugin } from "./plugins/properties.js";

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

/**
 * Creates the CodeMirror 6 editor instance.
 */
export function createEditor(container, state) {
  // Track the previous cursor line so we can fire a rename when the
  // user moves off line 1. First-line rename is the "filename follows
  // title" behavior users expected — gated on cursor leaving the title
  // to avoid the per-keystroke sync churn the old always-rename path
  // used to cause on the sync layer.
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
    // Programmatic changes (file load, pane mirror, sync apply, version
    // restore) are not user edits: no dirty flag, no snapshot keystroke,
    // no title-rename debounce. Word count still needs a recompute since
    // the visible text changed.
    const programmatic = update.docChanged && isProgrammaticUpdate(update);
    if (update.docChanged && !runwayOnly && !programmatic) {
      state.markDirty();
      state.trackKeystroke();
      scheduleWordCountRecompute(state);
      if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
      titleDebounceTimer = setTimeout(() => {
        queueMicrotask(() => { void state.maybeRenameFromFirstLine?.(); });
      }, TITLE_DEBOUNCE_MS);
      if (state.ratchetMode) onEncourageKeystroke(update.view, state);
    } else if (programmatic && !runwayOnly) {
      scheduleWordCountRecompute(state);
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
        // A programmatic load can land the mapped cursor on any line —
        // that's not the user leaving the title, so track the new line
        // without firing the rename.
        if (prevCursorLine === 1 && line !== 1 && !programmatic) {
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
    // Keep the scroller's dock insets in sync when the doc changes.
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

  // Ratchet — the timed session's keymap / transaction filter / mouse
  // block, plus the per-desk Ratchet mode that runs the same rules with
  // no clock. Lives in `editor/ratchet.js` so pane, stack, and Zen
  // surfaces enforce the desk mode from the same source.
  const ratchetExtensions = createRatchetExtensions(state, { enforceSelection: true });

  // Global keyboard shortcuts — built from `state.settings` so the settings
  // panel can change bindings at runtime via the shortcut compartment.
  const initialShortcuts = buildShortcutExtension(state);

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
  const youAreHerePlugin = createYouAreHerePlugin();
  const linkDecoratorPlugin = createLinkDecoratorPlugin(state);
  const wikilinkPlugin = createWikilinkPlugin(state, {
    onInlinePaneRequest: (_view, { title, occurrence }) =>
      openInlinePaneForWikilink(state, { title, occurrence }),
  });
  const citationPlugin = createCitationPlugin(state);
  const inlinePanePlugin = createInlinePanePlugin(state);
  const tabMarkerPlugin = createTabMarkerPlugin();
  const checkboxListPlugin = createCheckboxListPlugin();
  const tableRendererPlugin = createTableRendererPlugin();
  const imageDecoratorPlugin = createImageDecoratorPlugin(state, () => defaultLocalSyncContext(state));
  const stickyHeadersPlugin = createStickyHeadersPlugin(state);
  const multiLineCommentPlugin = createMultiLineCommentPlugin();
  const commentAfterPlugin = createCommentAfterPlugin();
  const commentAnchorPlugin = createCommentAnchorPlugin(state);
  const grammarCheckPlugin = createGrammarCheckPlugin(state);
  const grammarHoverTooltip = createGrammarHoverTooltip(state);
  const spellcheckPlugin = createSpellcheckPlugin(state);

  // Encourage typing decorations — fades new text when user stops typing in ratchet mode
  const encouragePlugin = ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = getEncourageDecorations(view); }
      update(update) { this.decorations = getEncourageDecorations(update.view); }
    },
    { decorations: (v) => v.decorations }
  );

  // Retained so fresh per-file EditorStates (see loadDocState below) can
  // be created with the exact extension set the live state uses.
  const baseExtensions = [
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
      markdown({ extensions: [Strikethrough, Table, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      wrapOnSelection,
      updateListener,
      blurListener,
      shortcutCompartment.of(initialShortcuts),
      readOnlyCompartment.of([]),
      ratchetExtensions,
      privateModePlugin,
      dryHighlightPlugin,
      focusModePlugin,
      calloutPlugin,
      footnotePlugin,
      flagHighlightPlugin,
      youAreHerePlugin,
      buildFoldingExtension(),
      createFoldArrowPlugin(),
      createLineIndicatorPlugin(state),
      linkDecoratorPlugin,
      wikilinkPlugin,
      citationPlugin,
      inlinePanePlugin,
      tabMarkerPlugin,
      checkboxListPlugin,
      tableRendererPlugin,
      imageDecoratorPlugin,
      createGoogleDocsPasteExtension(),
      headingIndentPlugin,
      findHighlightField,
      instanceHighlightField,
      stickyHeadersPlugin,
      multiLineCommentPlugin,
      commentAfterPlugin,
      commentAnchorPlugin,
      grammarCheckPlugin,
      grammarHoverTooltip,
      spellcheckPlugin,
      spellcheckClickHandler,
      encouragePlugin,
      createPropertiesPlugin(state),
      projectViewField,
      separatorFilter,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      placeholder("Start writing..."),
      EditorView.lineWrapping,
  ];

  const startState = EditorState.create({
    doc: "",
    extensions: baseExtensions,
  });

  const view = new EditorView({
    state: startState,
    parent: container,
  });

  // ── Per-file EditorState cache ────────────────────────────────────
  // The main editor shows every doc / project / Local Folder file the
  // user opens. Historically it kept ONE EditorState across all of
  // them, so a single CodeMirror undo history spanned file switches —
  // pressing ⌘Z past a switch boundary replaced the current file's
  // content with the previous file's text. Instead, the state (with
  // its undo history, selection, and fold state) is stashed per file
  // key on switch-away and restored on revisit; opening a file with no
  // stashed state starts a fresh state with an empty history.
  const MAX_CACHED_STATES = 20;
  const docStateCache = new Map(); // key -> EditorState, insertion order = LRU

  const carriedCompartments = [
    themeCompartment, highlightCompartment, shortcutCompartment, readOnlyCompartment,
  ];

  /** Swap in `next` as the editor state, carrying the live compartment
   *  configuration (theme / highlight / shortcuts / read-only) with it —
   *  a stashed state remembers the style that was active when it was
   *  put away, and a fresh state only knows the boot-time config. */
  function swapEditorState(next) {
    const liveConfigs = carriedCompartments.map((c) => c.get(view.state));
    view.setState(next);
    const effects = [];
    carriedCompartments.forEach((c, i) => {
      if (liveConfigs[i] !== undefined) effects.push(c.reconfigure(liveConfigs[i]));
    });
    if (effects.length) view.dispatch({ effects });
  }

  /** Every doc a ratcheted desk opens starts fully locked: whatever it
   *  already holds is committed text, and only what the user writes
   *  from here (plus line 1, the filename) is theirs to change. Runs
   *  after the content load so the end position is the real one — a
   *  restored EditorState carries its own stale anchor otherwise. */
  function relockForDeskRatchet() {
    if (!deskOnlyRatchet(state)) return;
    // Typewriter mode parks a runway of blank lines past the real end;
    // anchoring on those would lock the cursor out of the document.
    const text = view.state.doc.toString();
    const end = state.typewriterMode ? stripTypewriterRunwayText(text).length : text.length;
    setRatchetAnchor(view, end);
  }

  /** Bring the buffer to `text` as a minimal-splice diff, excluded from
   *  the undo history (`programmaticAnnotations`). Loading, mirroring,
   *  and restoring content are app actions, not user edits — existing
   *  history entries are mapped through the change by CodeMirror. */
  function applyContentDiff(text) {
    const cur = view.state.doc.toString();
    if (cur === text) return;
    let from = 0;
    const minLen = Math.min(cur.length, text.length);
    while (from < minLen && cur.charCodeAt(from) === text.charCodeAt(from)) from++;
    let curTo = cur.length;
    let newTo = text.length;
    while (curTo > from && newTo > from
      && cur.charCodeAt(curTo - 1) === text.charCodeAt(newTo - 1)) {
      curTo--;
      newTo--;
    }
    view.dispatch({
      changes: { from, to: curTo, insert: text.slice(from, newTo) },
      annotations: [bypassRatchet.of(true), bypassSeparatorFilter.of(true), ...programmaticAnnotations()],
    });
  }

  // Desk Ratchet is a persisted per-desk setting rather than a session,
  // so it flips on a `mode-changed` (the palette toggle) *and* on a desk
  // switch. Re-anchoring is gated on an actual transition: `mode-changed`
  // fires for every other mode too, and re-anchoring on each of those
  // would cut off the word the user is in the middle of typing.
  let deskRatchetOn = deskRatchetActive(state);
  let timedRatchetOn = !!state.ratchetMode;
  function syncDeskRatchet() {
    const next = deskRatchetActive(state);
    if (next === deskRatchetOn) return;
    deskRatchetOn = next;
    // Turning it on locks everything already written; turning it off
    // hands the whole document back.
    if (next) relockForDeskRatchet();
    else if (!state.ratchetMode) setRatchetAnchor(view, 0);
  }
  state.on("active-desk-changed", syncDeskRatchet);

  state.on("mode-changed", () => {
    syncDeskRatchet();
    // Capture the resting scroll offset up front. The typewriter-off branch
    // below clears the scroller padding and then re-applies it via a path
    // that reads offsetHeight (forcing a reflow while the scroll range is
    // momentarily shrunk) — the browser clamps scrollTop during that window
    // and the document visibly jumps toward the top. We restore the saved
    // offset afterwards so toggling e.g. focus mode leaves the view put.
    const modeScroller = document.querySelector("#editor-container .cm-scroller");
    const savedModeScrollTop = modeScroller ? modeScroller.scrollTop : null;
    applyModes(state);
    updateRatchetTimer(state);
    updateWordCountDisplay(state);
    view.dispatch({ effects: [] });
    const wasTimedRatchet = timedRatchetOn;
    timedRatchetOn = !!state.ratchetMode;
    if (state.ratchetMode) {
      // Anchor at the user's current cursor position so they can
      // continue writing from wherever they were. The previous
      // behaviour shoved the cursor to the end of the document — fine
      // for an empty doc, hostile when starting mid-thought.
      setRatchetAnchor(view, view.state.selection.main.head);
      view.focus();
      initEncourageTyping(view, state, bypassRatchet);
    } else {
      // Only the *end of a session* releases the lock, and only as far
      // as the desk allows: a ratcheted desk keeps everything written
      // so far locked. Other mode toggles leave the anchor alone so
      // they can't cut off the word being typed.
      if (wasTimedRatchet) {
        if (deskRatchetOn) relockForDeskRatchet(); else setRatchetAnchor(view, 0);
      }
      clearEncourageTyping();
    }
    if (state.typewriterMode) {
      setupTypewriterBoundary(view, state);
    } else {
      stripTypewriterRunway(view);
      removeTypewriterBoundary(view, state);
      // Restore the plain scroller padding (dock insets) that the
      // typewriter just blew away.
      applyEditorScrollerPadding(state);
      // Keep the user where they were instead of letting the padding churn
      // clamp them upward. Skip when ratchet is active — it pins the current
      // line to centre and owns the scroll position itself.
      if (!state.ratchetMode && modeScroller && savedModeScrollTop != null
          && modeScroller.scrollTop !== savedModeScrollTop) {
        modeScroller.scrollTop = savedModeScrollTop;
      }
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
    /** Replace the buffer with `text`. Every caller is a programmatic
     *  path (file load, mirror from a pane, restore, ref rewrite), so
     *  the change is applied as a minimal diff excluded from the undo
     *  history — user edits recorded before it survive and map through. */
    setContent: (text) => {
      applyContentDiff(text);
      // Seed the runway for the freshly-loaded doc — without this a
      // file-switch while typewriter is on would land short docs back
      // in the broken state until the user's next keystroke.
      if (state.typewriterMode) ensureTypewriterRunway(view, state);
      relockForDeskRatchet();
    },
    /** Apply externally-produced content (sync pull, watcher reload,
     *  sibling-window broadcast) as a minimal diff so the cursor and
     *  the undo history map through the change. Callers go through
     *  sync/apply-external.js#applyExternalDocContent, which owns the
     *  pull-lock / dirty bookkeeping around this dispatch. */
    applyExternalContent: (text) => {
      applyContentDiff(text);
      // In typewriter mode the buffer carries an artificial trailing
      // runway the incoming text doesn't have; the diff strips it, so
      // re-seed like setContent does.
      if (state.typewriterMode) ensureTypewriterRunway(view, state);
    },
    /** Stash the live EditorState under a file key before switching
     *  away, so the file's undo history / selection / folds are still
     *  there when it's reopened. Callers: openFile / openProject /
     *  openLocalSyncFile / newFile / showEmptyPane in the state layer. */
    stashDocState: (key) => {
      if (!key) return;
      docStateCache.delete(key);
      docStateCache.set(key, view.state);
      while (docStateCache.size > MAX_CACHED_STATES) {
        docStateCache.delete(docStateCache.keys().next().value);
      }
    },
    /** Load `text` for the file identified by `key`: restore the
     *  stashed EditorState when one exists (diffing in any content the
     *  file gained while it was away — sync pulls, pane edits), or
     *  start a fresh state with an empty undo history. Either way this
     *  file's ⌘Z can never reach back into the previously open file. */
    loadDocState: (key, text) => {
      const cached = key ? docStateCache.get(key) : null;
      if (cached) docStateCache.delete(key);
      swapEditorState(cached || EditorState.create({ doc: "", extensions: baseExtensions }));
      applyContentDiff(text);
      if (state.typewriterMode) ensureTypewriterRunway(view, state);
      relockForDeskRatchet();
      requestAnimationFrame(() => applyEditorScrollerPadding(state));
      scheduleWordCountRecompute(state);
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
