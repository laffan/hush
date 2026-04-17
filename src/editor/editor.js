import { EditorView, keymap, drawSelection, placeholder, ViewPlugin, Decoration } from "@codemirror/view";
import { EditorState, Prec, Compartment, Annotation, RangeSetBuilder } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags, Tag } from "@lezer/highlight";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "../themes.js";
import { createPrivateModePlugin } from "./plugins/private-mode.js";
import { createDryHighlightPlugin } from "./plugins/dry-highlight.js";
import { createFootnotePlugin } from "./plugins/footnotes.js";
import { createProjectViewField, createSeparatorFilter, bypassSeparatorFilter } from "./plugins/project-view.js";
import { createFocusModePlugin } from "./plugins/focus-mode.js";
import { createCalloutPlugin } from "./plugins/callouts.js";
import { createLinkDecoratorPlugin } from "./plugins/link-decorator.js";
import { initEncourageTyping, clearEncourageTyping, onEncourageKeystroke, getEncourageDecorations } from "./plugins/encourage-typing.js";
import { setupTypewriterBoundary, removeTypewriterBoundary, applyTypewriterPadding, scrollCursorToTypewriterLine, getTypewriterBoundary, repositionTypewriterBoundary } from "./plugins/typewriter.js";
import { applyModes, applyFullscreen, updateColumnResizers, updateRatchetTimer } from "./modes.js";
import { createStickyHeadersPlugin, updateStickyHeaders } from "./plugins/sticky-headers.js";
import { buildCodeMirrorKeymap } from "../shortcuts.js";
import { buildEditorCommands, buildFixedKeymap } from "./commands.js";

// Custom tags for our extensions
export const commentTag = Tag.define();
export const highlightTag = Tag.define();

// Custom inline parser for %% comments %%
const CommentDelim = { resolve: "Comment", mark: "CommentMark" };
export const CommentExtension = {
  defineNodes: [
    { name: "Comment", style: commentTag },
    { name: "CommentMark", style: commentTag },
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
    { name: "HighlightMark", style: tags.processingInstruction },
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
export function buildShortcutExtension(state) {
  const commands = buildEditorCommands();
  const userBindings = buildCodeMirrorKeymap(state, commands);
  const fixed = buildFixedKeymap(state);
  return Prec.highest(keymap.of([...userBindings, ...fixed]));
}

// Plugin that pulls heading markers (# ## etc.) into the left margin so
// heading text aligns with body text.  Uses mark decorations with absolute
// positioning — no measurement needed, works at any font size.
const headingMarkerDeco = Decoration.mark({ class: "heading-marker" });

export const headingIndentPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged
          || update.transactions.some(tr => tr.effects.length > 0)) {
        this.decorations = this.buildDecorations(update.view);
      }
    }
    buildDecorations(view) {
      const builder = new RangeSetBuilder();
      const { from, to } = view.viewport;
      const doc = view.state.doc;
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        const m = line.text.match(/^(#{1,6})\s/);
        if (m) {
          // Line decoration: position:relative so the marker can be absolute
          builder.add(line.from, line.from, Decoration.line({ class: "heading-indent" }));
          // Mark decoration: wrap the "## " prefix
          builder.add(line.from, line.from + m[0].length, headingMarkerDeco);
        }
        pos = line.to + 1;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

// Build the markdown highlight style, optionally normalizing heading sizes/colors.
// `headerScale` is a multiplier on the default heading progression (default 1.0).
export function getMarkdownHighlight(normalizeHeaders, headingColor, headerScale) {
  const color = headingColor || undefined;
  const k = typeof headerScale === "number" && headerScale > 0 ? headerScale : 1.0;
  const headingStyles = normalizeHeaders
    ? [
        { tag: tags.heading1, fontWeight: "700", color },
        { tag: tags.heading2, fontWeight: "700", color },
        { tag: tags.heading3, fontWeight: "600", color },
        { tag: tags.heading4, fontWeight: "600", color },
        { tag: tags.heading5, fontWeight: "600", color },
        { tag: tags.heading6, fontWeight: "600", color },
      ]
    : [
        { tag: tags.heading1, fontSize: `calc(var(--font-size) * ${1.8 * k})`, fontWeight: "700", lineHeight: "1.3", color },
        { tag: tags.heading2, fontSize: `calc(var(--font-size) * ${1.5 * k})`, fontWeight: "700", lineHeight: "1.3", color },
        { tag: tags.heading3, fontSize: `calc(var(--font-size) * ${1.3 * k})`, fontWeight: "600", lineHeight: "1.3", color },
        { tag: tags.heading4, fontSize: `calc(var(--font-size) * ${1.15 * k})`, fontWeight: "600", color },
        { tag: tags.heading5, fontSize: `calc(var(--font-size) * ${1.05 * k})`, fontWeight: "600", color },
        { tag: tags.heading6, fontSize: `calc(var(--font-size) * ${1.0 * k})`, fontWeight: "600", color },
      ];

  return HighlightStyle.define([
    ...headingStyles,
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.quote, fontStyle: "italic", opacity: "0.8" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, textDecoration: "underline" },
    { tag: tags.url, textDecoration: "underline", opacity: "0.7" },
    { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "calc(var(--font-size) * 0.9)" },
    // Custom syntax: %% comments %% — dimmed out
    { tag: commentTag, opacity: "0.4" },
    // Custom syntax: == highlight == — highlighted background (flag-typed highlights get per-flag color from plugin)
    { tag: highlightTag, borderRadius: "2px" },
    // Dim the markdown syntax characters (# * _ ` %% == ~~ etc.)
    { tag: tags.processingInstruction, opacity: "0.4" },
  ]);
}

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function createFlagHighlightPlugin(stateRef) {
  const highlightRegex = /==[^=]+==/g;
  const flagRegex = /^==([A-Za-z][A-Za-z0-9_-]{0,24}):\s*[^=]+==$/;
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

// Plugin that handles multi-line %% comment %% blocks (the inline parser only works within a single line)
export function createMultiLineCommentPlugin() {
  const commentRegex = /%%/g;
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
        const positions = [];
        let m;
        commentRegex.lastIndex = 0;
        while ((m = commentRegex.exec(doc)) !== null) {
          // Skip %%% (triple percent)
          if (doc[m.index + 2] === "%" || (m.index > 0 && doc[m.index - 1] === "%")) continue;
          positions.push(m.index);
        }
        // Pair up delimiters — only decorate pairs that span multiple lines
        for (let i = 0; i + 1 < positions.length; i += 2) {
          const open = positions[i];
          const close = positions[i + 1];
          const openLine = view.state.doc.lineAt(open).number;
          const closeLine = view.state.doc.lineAt(close).number;
          if (openLine !== closeLine) {
            builder.add(open, close + 2, Decoration.mark({ attributes: { style: "opacity: 0.4" } }));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Plugin that handles the "comment after" marker: ---% makes everything after it semi-gray
export function createCommentAfterPlugin() {
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
        const doc = view.state.doc;
        const text = doc.toString();
        const marker = "---%";
        const idx = text.indexOf(marker);
        if (idx !== -1) {
          // Apply dim styling from the marker to end of document
          const markerLine = doc.lineAt(idx);
          builder.add(markerLine.from, doc.length, Decoration.mark({ attributes: { style: "opacity: 0.35" } }));
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
 * @returns {{ extensions: Extension[], themeComp, highlightComp, shortcutComp }}
 */
export function createBaseExtensions(state, onChange) {
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
  // Header color override from style's color overrides (light/dark resolved by
  // applyActiveStyle into --header-color; fall back to theme headingColor).
  const headerOverride = (_s && ((state.settings.appearance === "dark" ? _s.darkColors : _s.lightColors)?.header))
    || undefined;

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
      getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || activeTheme?.headingColor), hScale)
    )),
    markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
    history(),
    drawSelection(),
    closeBrackets(),
    updateListener,
    _shortcutComp.of(buildShortcutExtension(state)),
    createCalloutPlugin(),
    createFootnotePlugin(state),
    createFlagHighlightPlugin(state),
    createLinkDecoratorPlugin(),
    headingIndentPlugin,
    createStickyHeadersPlugin(state),
    createMultiLineCommentPlugin(),
    createCommentAfterPlugin(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
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
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      state.markDirty();
      state.trackKeystroke();
      if (state.ratchetMode) onEncourageKeystroke(update.view, state);
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

  const ratchetFilter = EditorState.transactionFilter.of((tr) => {
    if (!state.ratchetMode || tr.annotation(bypassRatchet)) return tr;
    if (tr.docChanged) {
      // Find the lock point: position after the last space or newline.
      // Content before the lock point is permanently locked.
      const doc = tr.startState.doc.toString();
      const lastSpaceIdx = Math.max(doc.lastIndexOf(" "), doc.lastIndexOf("\n"));
      const lockPoint = lastSpaceIdx + 1;

      let reject = false;
      tr.changes.iterChanges((fromA, toA) => {
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
  const linkDecoratorPlugin = createLinkDecoratorPlugin();
  const stickyHeadersPlugin = createStickyHeadersPlugin(state);
  const multiLineCommentPlugin = createMultiLineCommentPlugin();
  const commentAfterPlugin = createCommentAfterPlugin();

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
        const headerOverride = (_s && ((state.settings.appearance === "dark" ? _s.darkColors : _s.lightColors)?.header))
          || undefined;
        return getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || getActiveTheme(state.settings)?.headingColor), hScale);
      })())),
      markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
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
      headingIndentPlugin,
      stickyHeadersPlugin,
      multiLineCommentPlugin,
      commentAfterPlugin,
      encouragePlugin,
      projectViewField,
      separatorFilter,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
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
    view.dispatch({ effects: [] });
    if (state.ratchetMode) {
      const end = view.state.doc.length;
      view.dispatch({ selection: { anchor: end }, annotations: bypassRatchet.of(true) });
      view.focus();
      initEncourageTyping(view, state, bypassRatchet);
    } else {
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

  state.on("style-changed", () => applyBlockCursor(state));

  function resolveHeaderArgs() {
    const t = getActiveTheme(state.settings);
    const _activeStyle = state.settings.activeStyleId
      ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId)
      : null;
    const normalizeHeaders = _activeStyle?.suppressHeaderSize ?? state.settings.normalizeHeaders;
    const normalizeHeaderColor = _activeStyle?.suppressHeaderColor ?? state.settings.normalizeHeaderColor;
    const hScale = _activeStyle?.headerScale ?? state.settings.headerScale ?? 1.0;
    const headerOverride = (_activeStyle && ((state.settings.appearance === "dark" ? _activeStyle.darkColors : _activeStyle.lightColors)?.header))
      || undefined;
    const headingColor = normalizeHeaderColor ? undefined : (headerOverride || t?.headingColor);
    return { t, normalizeHeaders, headingColor, hScale };
  }

  state.on("theme-changed", () => {
    const { t, normalizeHeaders, headingColor, hScale } = resolveHeaderArgs();
    view.dispatch({ effects: [
      themeCompartment.reconfigure(t ? t.extension : []),
      highlightCompartment.reconfigure(
        syntaxHighlighting(getMarkdownHighlight(normalizeHeaders, headingColor, hScale))
      ),
    ] });
  });

  state.on("settings-changed", () => {
    const _activeStyle = state.settings.activeStyleId
      ? (state.settings.styles || []).find(s => s.id === state.settings.activeStyleId)
      : null;
    const _fs = _activeStyle?.fontSize || state.settings.fontSize;
    document.documentElement.style.setProperty("--font-size", _fs + "px");
    const _lh = _activeStyle?.lineHeight || state.settings.lineHeight;
    document.documentElement.style.setProperty("--line-height", _lh);
    const { normalizeHeaders, headingColor, hScale } = resolveHeaderArgs();
    view.dispatch({
      effects: [
        highlightCompartment.reconfigure(
          syntaxHighlighting(getMarkdownHighlight(normalizeHeaders, headingColor, hScale))
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
