/**
 * Pane editor factory — creates a lightweight CodeMirror 6 editor
 * for use inside floating panes.  Shares theme/highlight styling with
 * the main editor but omits mode-specific plugins (ratchet, typewriter,
 * private mode, DRY, focus mode, etc.) since those apply per-session.
 */

import { EditorView, keymap, drawSelection, ViewPlugin, Decoration } from "@codemirror/view";
import { EditorState, Compartment, RangeSetBuilder } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags, Tag } from "@lezer/highlight";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "../themes.js";
import { createCalloutPlugin } from "../editor/plugins/callouts.js";
import { createLinkDecoratorPlugin } from "../editor/plugins/link-decorator.js";

// Reuse the custom inline parsers from the main editor
const commentTag = Tag.define();
const highlightTag = Tag.define();

const CommentDelim = { resolve: "Comment", mark: "CommentMark" };
const CommentExtension = {
  defineNodes: [
    { name: "Comment", style: commentTag },
    { name: "CommentMark", style: commentTag },
  ],
  parseInline: [{
    name: "Comment",
    parse(cx, next, pos) {
      if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
      if (cx.char(pos + 2) === 37) return -1;
      return cx.addDelimiter(CommentDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
const HighlightExtension = {
  defineNodes: [
    { name: "Highlight", style: highlightTag },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
      if (cx.char(pos + 2) === 61) return -1;
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis"
  }]
};

const headingMarkerDeco = Decoration.mark({ class: "heading-marker" });

const headingIndentPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = this.build(view); }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view) {
      const b = new RangeSetBuilder();
      const { from, to } = view.viewport;
      const doc = view.state.doc;
      for (let pos = from; pos <= to;) {
        const line = doc.lineAt(pos);
        const m = line.text.match(/^(#{1,6})\s/);
        if (m) {
          b.add(line.from, line.from, Decoration.line({ class: "heading-indent" }));
          b.add(line.from, line.from + m[0].length, headingMarkerDeco);
        }
        pos = line.to + 1;
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

function getMarkdownHighlight(headingColor) {
  const color = headingColor || undefined;
  return HighlightStyle.define([
    { tag: tags.heading1, fontSize: "calc(var(--font-size) * 1.8)", fontWeight: "700", lineHeight: "1.3", color },
    { tag: tags.heading2, fontSize: "calc(var(--font-size) * 1.5)", fontWeight: "700", lineHeight: "1.3", color },
    { tag: tags.heading3, fontSize: "calc(var(--font-size) * 1.3)", fontWeight: "600", lineHeight: "1.3", color },
    { tag: tags.heading4, fontSize: "calc(var(--font-size) * 1.15)", fontWeight: "600", color },
    { tag: tags.heading5, fontSize: "calc(var(--font-size) * 1.05)", fontWeight: "600", color },
    { tag: tags.heading6, fontSize: "var(--font-size)", fontWeight: "600", color },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.quote, fontStyle: "italic", opacity: "0.8" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, textDecoration: "underline" },
    { tag: tags.url, textDecoration: "underline", opacity: "0.7" },
    { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "calc(var(--font-size) * 0.9)" },
    { tag: commentTag, opacity: "0.4" },
    { tag: highlightTag, backgroundColor: "rgba(255, 208, 0, 0.3)", borderRadius: "2px" },
    { tag: tags.processingInstruction, opacity: "0.4" },
  ]);
}

/**
 * Create a CodeMirror editor suitable for a floating pane.
 * Returns { view, getContent, setContent, focus, destroy, reconfigureTheme }.
 */
export function createPaneEditor(container, appState, onChange) {
  const themeComp = new Compartment();
  const highlightComp = new Compartment();

  const activeTheme = getActiveTheme(appState.settings);
  const headingColor = activeTheme?.headingColor;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) onChange();
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

  const startState = EditorState.create({
    doc: "",
    extensions: [
      hushTheme,
      themeComp.of(activeTheme ? activeTheme.extension : []),
      highlightComp.of(syntaxHighlighting(getMarkdownHighlight(headingColor))),
      markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      createCalloutPlugin(),
      createLinkDecoratorPlugin(),
      headingIndentPlugin,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({ state: startState, parent: container });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    reconfigureTheme: (settings) => {
      const t = getActiveTheme(settings);
      view.dispatch({
        effects: [
          themeComp.reconfigure(t ? t.extension : []),
          highlightComp.reconfigure(syntaxHighlighting(getMarkdownHighlight(t?.headingColor))),
        ],
      });
    },
  };
}
