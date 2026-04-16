/**
 * Pane editor factory — creates a fully-featured CodeMirror 6 editor
 * for use inside floating panes.  Uses the same plugins, syntax
 * highlighting, and shortcut bindings as the main editor.  Omits only
 * per-session mode plugins (ratchet, typewriter, private mode) and
 * project-view separators since panes show single files.
 */

import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { EditorState, Prec, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { getActiveTheme } from "../themes.js";
import {
  CommentExtension, HighlightExtension,
  getMarkdownHighlight, buildShortcutExtension,
  headingIndentPlugin,
  createFlagHighlightPlugin, createMultiLineCommentPlugin, createCommentAfterPlugin,
} from "../editor/editor.js";
import { createCalloutPlugin } from "../editor/plugins/callouts.js";
import { createLinkDecoratorPlugin } from "../editor/plugins/link-decorator.js";
import { createFootnotePlugin } from "../editor/plugins/footnotes.js";
import { createStickyHeadersPlugin } from "../editor/plugins/sticky-headers.js";
import { buildFixedKeymap } from "../editor/commands.js";

const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();
const shortcutCompartment = new Compartment();

/**
 * Resolve the initial markdown highlight style from current settings,
 * respecting active-style overrides for header normalization / color.
 */
function resolveHighlight(settings) {
  const style = settings.activeStyleId
    ? (settings.styles || []).find(s => s.id === settings.activeStyleId)
    : null;
  const nh = style?.suppressHeaderSize ?? settings.normalizeHeaders;
  const nhc = style?.suppressHeaderColor ?? settings.normalizeHeaderColor;
  const headingColor = nhc ? undefined : getActiveTheme(settings)?.headingColor;
  return getMarkdownHighlight(nh, headingColor);
}

/**
 * Create a CodeMirror editor suitable for a floating pane.
 * Returns { view, getContent, setContent, focus, destroy, reconfigureTheme }.
 */
export function createPaneEditor(container, appState, onChange) {
  const activeTheme = getActiveTheme(appState.settings);

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

  const footnotePlugin = createFootnotePlugin(appState);
  const calloutPlugin = createCalloutPlugin();
  const flagHighlightPlugin = createFlagHighlightPlugin(appState);
  const linkDecoratorPlugin = createLinkDecoratorPlugin();
  const stickyHeadersPlugin = createStickyHeadersPlugin(appState);
  const multiLineCommentPlugin = createMultiLineCommentPlugin();
  const commentAfterPlugin = createCommentAfterPlugin();
  const initialShortcuts = buildShortcutExtension(appState);

  const startState = EditorState.create({
    doc: "",
    extensions: [
      hushTheme,
      themeCompartment.of(activeTheme ? activeTheme.extension : []),
      highlightCompartment.of(syntaxHighlighting(resolveHighlight(appState.settings))),
      markdown({ extensions: [Strikethrough, CommentExtension, HighlightExtension] }),
      history(),
      drawSelection(),
      closeBrackets(),
      updateListener,
      shortcutCompartment.of(initialShortcuts),
      calloutPlugin,
      footnotePlugin,
      flagHighlightPlugin,
      linkDecoratorPlugin,
      headingIndentPlugin,
      stickyHeadersPlugin,
      multiLineCommentPlugin,
      commentAfterPlugin,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
      Prec.highest(keymap.of(buildFixedKeymap(appState))),
      placeholder("Start writing..."),
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
          themeCompartment.reconfigure(t ? t.extension : []),
          highlightCompartment.reconfigure(syntaxHighlighting(resolveHighlight(settings))),
          shortcutCompartment.reconfigure(buildShortcutExtension(appState)),
        ],
      });
    },
  };
}
