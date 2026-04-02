import { EditorView, keymap, drawSelection, placeholder, ViewPlugin, Decoration } from "@codemirror/view";
import { EditorState, EditorSelection, Prec, Compartment, Annotation, RangeSetBuilder } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags, Tag } from "@lezer/highlight";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "./themes.js";
import { createPrivateModePlugin } from "./private-mode.js";
import { createDryHighlightPlugin } from "./dry-highlight.js";
import { openSettingsWindow } from "./settings-ui.js";
import { openFindReplace, openFindAll, findNext, findPrev } from "./find-replace.js";
import { selectSentence, reduceSentenceSelection, shiftSelectionToNextSentence, shiftSelectionToPreviousSentence, moveSentenceForward, moveSentenceBack, deleteToSentenceEnd, jumpToNextSentence, jumpToPrevSentence, jumpToPrevParagraph, jumpToNextParagraph } from "./sentence-navigator.js";
import { toggleBold, toggleItalic, toggleHighlight, toggleComment, toggleStrikethrough } from "./formatting.js";
import { createFootnotePlugin, insertFootnote } from "./footnotes.js";
import { createProjectViewField, createSeparatorFilter, bypassSeparatorFilter } from "./project-view.js";
import { createFocusModePlugin } from "./focus-mode.js";
import { createCalloutPlugin } from "./callouts.js";
import { openZoteroModal } from "./zotero.js";
import { createLinkDecoratorPlugin } from "./link-decorator.js";
import { initEncourageTyping, clearEncourageTyping, onEncourageKeystroke, getEncourageDecorations } from "./encourage-typing.js";
import { setupTypewriterBoundary, removeTypewriterBoundary, applyTypewriterPadding, scrollCursorToTypewriterLine, applyRatchetTypewriterPadding, getTypewriterBoundary, repositionTypewriterBoundary } from "./typewriter.js";
import { applyModes, applyFullscreen, updateColumnResizers, updateRatchetTimer } from "./editor-modes.js";

// Custom tags for our extensions
const commentTag = Tag.define();
const highlightTag = Tag.define();

// Custom inline parser for %% comments %%
const CommentDelim = { resolve: "Comment", mark: "CommentMark" };
const CommentExtension = {
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
const HighlightExtension = {
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
const bypassRatchet = Annotation.define();

// Plugin that measures the actual width of heading markers (# ## etc.) and
// applies a precise negative text-indent so heading text aligns with body text.
// Uses DOM measurement instead of CSS approximation for cross-platform accuracy.
const headingIndentPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.applied = new Set(); this.applyIndents(view); }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.applyIndents(update.view);
      }
    }
    applyIndents(view) {
      const { from, to } = view.viewport;
      const doc = view.state.doc;
      const seen = new Set();
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        seen.add(line.from);
        const match = line.text.match(/^(#{1,6})\s/);
        if (match) {
          // Find the .cm-line DOM element for this line
          const domPos = view.domAtPos(line.from);
          const lineEl = domPos?.node?.nodeType === 1
            ? domPos.node.closest(".cm-line")
            : domPos?.node?.parentElement?.closest(".cm-line");
          if (lineEl) {
            // The first child span contains the # marks (styled as processingInstruction)
            const firstSpan = lineEl.querySelector("span");
            if (firstSpan) {
              const markWidth = firstSpan.getBoundingClientRect().width;
              if (markWidth > 0) {
                lineEl.style.textIndent = `-${Math.round(markWidth)}px`;
                this.applied.add(line.from);
              }
            }
          }
        } else {
          // Clear indent from non-heading lines that previously had it
          if (this.applied.has(line.from)) {
            const domPos = view.domAtPos(line.from);
            const lineEl = domPos?.node?.nodeType === 1
              ? domPos.node.closest(".cm-line")
              : domPos?.node?.parentElement?.closest(".cm-line");
            if (lineEl) lineEl.style.textIndent = "";
            this.applied.delete(line.from);
          }
        }
        pos = line.to + 1;
      }
    }
    destroy() { this.applied.clear(); }
  }
);

// Build the markdown highlight style, optionally normalizing heading sizes/colors
function getMarkdownHighlight(normalizeHeaders, headingColor) {
  const color = headingColor || undefined;
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
        { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3", color },
        { tag: tags.heading2, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3", color },
        { tag: tags.heading3, fontSize: "1.3em", fontWeight: "600", lineHeight: "1.3", color },
        { tag: tags.heading4, fontSize: "1.15em", fontWeight: "600", color },
        { tag: tags.heading5, fontSize: "1.05em", fontWeight: "600", color },
        { tag: tags.heading6, fontSize: "1em", fontWeight: "600", color },
      ];

  return HighlightStyle.define([
    ...headingStyles,
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, textDecoration: "underline" },
    { tag: tags.url, textDecoration: "underline", opacity: "0.7" },
    { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "0.9em" },
    // Custom syntax: %% comments %% — dimmed out
    { tag: commentTag, opacity: "0.4" },
    // Custom syntax: == highlight == — highlighted background (flag-typed highlights get per-flag color from plugin)
    { tag: highlightTag, borderRadius: "2px" },
    // Dim the markdown syntax characters (# * _ ` %% == ~~ etc.)
    { tag: tags.processingInstruction, opacity: "0.4" },
  ]);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function createFlagHighlightPlugin(stateRef) {
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
    // Typewriter / Ratchet: scroll cursor to fixed position on every update
    const shouldScroll = state.typewriterMode || state.ratchetMode;
    if (shouldScroll && (update.docChanged || update.selectionSet || update.focusChanged)) {
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

  // Global keyboard shortcuts
  const globalKeymap = Prec.highest(
    keymap.of([
      { key: "Mod-s", run: () => { state.saveCurrentFile(); state.createManualSnapshot(); return true; } },
      { key: "Mod-,", run: () => { openSettingsWindow(state); return true; } },
      { key: "Mod-Shift-p", run: () => { state.togglePrivate(); return true; } },
      { key: "Mod-l", run: (view) => selectSentence(view) },
      { key: "Alt-Shift-l", run: (view) => reduceSentenceSelection(view) },
      { key: "Mod-Shift-l", run: (view) => { openZoteroModal(view, state); return true; } },
      { key: "Mod-ArrowRight", run: (view) => jumpToNextSentence(view) },
      { key: "Mod-ArrowLeft", run: (view) => jumpToPrevSentence(view) },
      { key: "Mod-Shift-ArrowRight", run: (view) => shiftSelectionToNextSentence(view) },
      { key: "Mod-Shift-ArrowLeft", run: (view) => shiftSelectionToPreviousSentence(view) },
      { key: "Alt-Mod-ArrowRight", run: (view) => moveSentenceForward(view) },
      { key: "Alt-Mod-ArrowLeft", run: (view) => moveSentenceBack(view) },
      { key: "Alt-Shift-Backspace", run: (view) => deleteToSentenceEnd(view) },
      { key: "Mod-b", run: (view) => toggleBold(view) },
      { key: "Mod-i", run: (view) => toggleItalic(view) },
      { key: "Mod-=", run: (view) => toggleHighlight(view) },
      { key: "Mod-/", run: (view) => toggleComment(view) },
      { key: "Mod-`", run: (view) => toggleStrikethrough(view) },
      { key: "Mod-Shift-m", run: (view) => insertFootnote(view) },
      { key: "Mod-Shift-t", run: () => { state.toggleTypewriter(); return true; } },
      { key: "Mod-Shift-r", run: () => { state.toggleDry(); return true; } },
      { key: "Mod-Shift-y", run: () => { state.toggleFocus(); return true; } },
      { key: "Mod-ArrowUp", run: (view) => jumpToPrevParagraph(view) },
      { key: "Mod-ArrowDown", run: (view) => jumpToNextParagraph(view) },
      { key: "Mod-n", run: () => { state.newFile(); return true; } },
      { key: "Mod-f", run: (view) => { openFindReplace(view, state); return true; } },
      { key: "Mod-Shift-f", run: (view) => { openFindAll(view, state); return true; } },
      { key: "Mod-g", run: () => findNext() },
      { key: "Mod-Shift-g", run: () => findPrev() },
      { key: "Mod-d", run: (view) => {
        const sel = view.state.selection.main;
        if (sel.empty) {
          const line = view.state.doc.lineAt(sel.head);
          const text = line.text;
          const offset = sel.head - line.from;
          let start = offset, end = offset;
          while (start > 0 && /\w/.test(text[start - 1])) start--;
          while (end < text.length && /\w/.test(text[end])) end++;
          if (start !== end) {
            view.dispatch({ selection: { anchor: line.from + start, head: line.from + end } });
          }
        } else {
          const selected = view.state.sliceDoc(sel.from, sel.to);
          const docText = view.state.doc.toString();
          const allRanges = view.state.selection.ranges;
          const lastRange = allRanges[allRanges.length - 1];
          const searchFrom = Math.max(lastRange.from, lastRange.to);
          let nextIdx = docText.indexOf(selected, searchFrom);
          if (nextIdx === -1) nextIdx = docText.indexOf(selected, 0);
          const alreadySelected = allRanges.some(r => {
            const from = Math.min(r.anchor, r.head);
            return from === nextIdx;
          });
          if (nextIdx !== -1 && !alreadySelected) {
            const ranges = allRanges.map(r =>
              EditorSelection.range(r.anchor, r.head)
            );
            ranges.push(EditorSelection.range(nextIdx, nextIdx + selected.length));
            view.dispatch({
              selection: EditorSelection.create(ranges, ranges.length - 1)
            });
          }
        }
        return true;
      }},
      { key: "Mod-Shift-d", run: (view) => {
        const sel = view.state.selection.main;
        if (sel.empty) return false;
        const selected = view.state.sliceDoc(sel.from, sel.to);
        const docText = view.state.doc.toString();
        const allRanges = view.state.selection.ranges;
        const firstRange = allRanges[0];
        const searchBefore = Math.min(firstRange.from, firstRange.to);
        let prevIdx = docText.lastIndexOf(selected, searchBefore - 1);
        if (prevIdx === -1) prevIdx = docText.lastIndexOf(selected);
        const alreadySelected = allRanges.some(r => {
          const from = Math.min(r.anchor, r.head);
          return from === prevIdx;
        });
        if (prevIdx !== -1 && !alreadySelected) {
          const ranges = allRanges.map(r =>
            EditorSelection.range(r.anchor, r.head)
          );
          ranges.unshift(EditorSelection.range(prevIdx, prevIdx + selected.length));
          view.dispatch({
            selection: EditorSelection.create(ranges, 0)
          });
        }
        return true;
      }},
    ])
  );

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
      highlightCompartment.of(syntaxHighlighting(getMarkdownHighlight(state.settings.normalizeHeaders, state.settings.normalizeHeaderColor ? undefined : getActiveTheme(state.settings)?.headingColor))),
      markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      globalKeymap,
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
      applyRatchetTypewriterPadding(view);
      requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
      initEncourageTyping(view, state, bypassRatchet);
    } else {
      clearEncourageTyping();
      if (!state.typewriterMode) {
        view.scrollDOM.style.paddingTop = "";
        view.scrollDOM.style.paddingBottom = "";
      }
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
      if (state.ratchetMode) {
        applyRatchetTypewriterPadding(view);
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
    if (state.ratchetMode) {
      applyRatchetTypewriterPadding(view);
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
      if (state.typewriterMode || state.ratchetMode) {
        requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
      }
    });
  }

  updateColumnResizers(state);

  state.on("theme-changed", () => {
    const t = getActiveTheme(state.settings);
    const headingColor = state.settings.normalizeHeaderColor ? undefined : t?.headingColor;
    view.dispatch({ effects: [
      themeCompartment.reconfigure(t ? t.extension : []),
      highlightCompartment.reconfigure(
        syntaxHighlighting(getMarkdownHighlight(state.settings.normalizeHeaders, headingColor))
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
    const t = getActiveTheme(state.settings);
    const headingColor = state.settings.normalizeHeaderColor ? undefined : t?.headingColor;
    view.dispatch({
      effects: highlightCompartment.reconfigure(
        syntaxHighlighting(getMarkdownHighlight(state.settings.normalizeHeaders, headingColor))
      ),
    });
    // Update typewriter line opacity
    if (getTypewriterBoundary()) {
      getTypewriterBoundary().style.opacity = state.settings.typewriterLineOpacity ?? 0.08;
    }
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
