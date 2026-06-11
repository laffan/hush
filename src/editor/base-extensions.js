import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { Prec, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Strikethrough } from "@lezer/markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { wrapOnSelection } from "./wrap-on-selection.js";
import { getActiveTheme } from "../themes/index.js";
import { createFootnotePlugin } from "./plugins/footnotes.js";
import { createFocusModePlugin } from "./plugins/focus-mode.js";
import { createCalloutPlugin } from "./plugins/callouts.js";
import { createLinkDecoratorPlugin } from "./plugins/link-decorator.js";
import { createWikilinkPlugin } from "./plugins/wikilink-decorator.js";
import { createCitationPlugin } from "./plugins/citation-decorator.js";
import { createTabMarkerPlugin } from "./plugins/tab-marker.js";
import { createCheckboxListPlugin } from "./plugins/checkbox-list.js";
import { createImageDecoratorPlugin } from "./plugins/image-decorator.js";
import { createStickyHeadersPlugin } from "./plugins/sticky-headers.js";
import { buildCodeMirrorKeymap, matchesDomEvent } from "../shortcuts.js";
import { buildEditorCommands, buildFixedKeymap } from "./commands.js";
import { toggleStrikethrough } from "./formatting.js";
import { headingIndentPlugin } from "./heading-indent.js";
import { findHighlightField } from "./find-decorations.js";
import { instanceHighlightField } from "./select-instance-highlight.js";
import { createMultiLineCommentPlugin, createCommentAfterPlugin } from "./comment-plugins.js";
import { createCommentAnchorPlugin } from "./plugins/comment-anchors.js";
import { createImagePasteExtension } from "./image-paste.js";
import { createGoogleDocsPasteExtension } from "./google-docs/paste-extension.js";
import { getMarkdownHighlight, resolveHeaderColorOverride } from "./markdown-highlight.js";
import { CommentExtension, HighlightExtension } from "./markdown-extensions.js";
import { createFlagHighlightPlugin } from "./flag-highlight.js";
import { createLineIndicatorPlugin } from "./line-indicator.js";
import { createSpellcheckPlugin, spellcheckClickHandler } from "./plugins/spellcheck.js";

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

  // Catch Cmd+Backquote at the DOM-event layer so the strikethrough toggle
  // fires reliably across keyboard layouts. The grave key registers as a
  // combining-accent dead key on many layouts (event.key === "Dead"), and
  // on some platforms / CodeMirror builds the literal "`" doesn't match
  // the stored "Mod+`" binding either, so the user-customizable keymap
  // entry alone isn't enough. Match the physical code instead.
  const strikethroughFallback = EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.code !== "Backquote") return false;
      if (!(e.metaKey || e.ctrlKey)) return false;
      if (matchesDomEvent(e, state.settings.shortcutStrikethrough)) {
        toggleStrikethrough(view);
        e.preventDefault();
        return true;
      }
      return false;
    },
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
    strikethroughFallback,
    _shortcutComp.of(buildShortcutExtension(state)),
    createCalloutPlugin(),
    createFootnotePlugin(state),
    createFlagHighlightPlugin(state),
    createLineIndicatorPlugin(state),
    createLinkDecoratorPlugin(state),
    createWikilinkPlugin(state),
    createCitationPlugin(state),
    createTabMarkerPlugin(),
    createCheckboxListPlugin(),
    createImageDecoratorPlugin(state, getImageContext),
    createImagePasteExtension(state, { getImageContext }),
    createGoogleDocsPasteExtension(),
    headingIndentPlugin,
    findHighlightField,
    instanceHighlightField,
    createStickyHeadersPlugin(state),
    createMultiLineCommentPlugin(),
    createCommentAfterPlugin(),
    createCommentAnchorPlugin(state),
    createSpellcheckPlugin(state),
    spellcheckClickHandler,
    createFocusModePlugin(state),
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
