import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { Prec, Compartment, Annotation, Transaction } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Strikethrough, Table } from "@lezer/markdown";
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
import { buildCodeMirrorKeymap, parseShortcut, isPhysicalKey, modifiersMatch } from "../shortcuts.js";
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
import { createYouAreHerePlugin } from "./plugins/you-are-here.js";
import { createLineIndicatorPlugin } from "./line-indicator.js";
import { createSpellcheckPlugin, spellcheckClickHandler } from "./plugins/spellcheck.js";
import { buildFoldingExtension } from "./folding.js";
import { createFoldArrowPlugin } from "./fold-arrow.js";
import { createPropertiesPlugin } from "./plugins/properties.js";
import { createTableRendererPlugin } from "./plugins/table-renderer.js";
import { createRatchetExtensions } from "./ratchet.js";

/**
 * Marks a transaction as app-driven rather than user-typed: file loads,
 * pane↔main mirrors, external sync applies, version restores. Dispatches
 * carrying this annotation are excluded from the CodeMirror undo history
 * (paired with `Transaction.addToHistory.of(false)`) and skip the
 * dirty / keystroke / rename side effects in the editors' update
 * listeners — loading a doc is not an edit. History entries recorded
 * before such a change are mapped through it by CodeMirror, so a user's
 * undo stack survives a sync pull or a pane mirror instead of treating
 * it as one giant undoable replacement.
 */
export const programmaticChange = Annotation.define();

/** Annotation list for a programmatic dispatch. */
export function programmaticAnnotations() {
  return [programmaticChange.of(true), Transaction.addToHistory.of(false)];
}

/** True when every transaction in `update` is a programmatic change. */
export function isProgrammaticUpdate(update) {
  return update.transactions.length > 0
    && update.transactions.every((tr) => tr.annotation(programmaticChange));
}

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
 * Catch Cmd+Backquote at the DOM-event layer so the strikethrough toggle
 * fires reliably across keyboard layouts and platforms. CodeMirror's
 * keymap matches on `event.key`, and grave is the one key in the app's
 * bindings that routinely arrives without a usable one — on layouts
 * where it is a combining accent it reports `event.key === "Dead"`.
 *
 * The first version of this fallback swapped one single signal for
 * another: `event.code === "Backquote"`. That is no more guaranteed to
 * be populated than `key` is — WebKit has left `code` empty for
 * hardware keyboards, and the shortcut stayed dead wherever it did.
 * `isPhysicalKey` walks `code` → `keyCode` → the character itself and
 * takes whichever the platform actually filled in, so no one of them
 * has to be the right one.
 *
 * Only the modifiers come from the stored binding: once the physical
 * key is identified, re-checking `event.key` against it is the very
 * comparison that was failing.
 *
 * A binding recorded before `shortcutKeyFromEvent` existed can read
 * `"...+Dead"` — the same physical key under the name the layout gave
 * it — so that spelling is honoured too rather than left dead.
 *
 * **Every doc surface needs this, not just the ones built from
 * `createBaseExtensions`.** `editor.js` assembles its own extension list
 * and was missing it, so Cmd+` did nothing in the main editor while
 * working fine in a pane — which reads as the shortcut being unbound.
 * Exported so the two lists can't drift again.
 *
 * @param {object} state AppState (or a per-editor mode context proxy)
 */
export function createStrikethroughFallback(state) {
  return EditorView.domEventHandlers({
    keydown(e, view) {
      const binding = parseShortcut(state.settings?.shortcutStrikethrough);
      // Only stands in for a grave-key binding. Rebind Strikethrough to
      // anything else and the keymap matches it on `event.key` without
      // help, so this must not fire for it.
      if (!binding || (binding.key !== "`" && binding.key !== "Dead")) return false;
      if (!isPhysicalKey(e, "`")) return false;
      if (!modifiersMatch(e, binding)) return false;
      toggleStrikethrough(view);
      e.preventDefault();
      return true;
    },
  });
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
 * @param {boolean} [opts.fragment] This surface holds a slice of a
 *   document rather than the whole thing (the Selection Focus overlay).
 *   Ratchet reads a buffer's edges as the document's — line 1 as the
 *   filename, the end as the writing edge — and neither is true of a
 *   fragment, so it locks the slice whole instead.
 * @param {boolean} [opts.flushLineIndicator] This surface has no gutter
 *   outside its text column for the line indicator's arrows / border
 *   stripes to hang in (a pane, a stack column), so they attach to the
 *   surface's own edges and the highlight runs edge to edge.
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
    // Programmatic changes (content load, pane mirror, external sync
    // apply) are not user edits — skip the dirty/sync onChange so a
    // mirror can't mark the pane dirty or echo back to its source.
    if (update.docChanged && onChange && !isProgrammaticUpdate(update)) onChange(update);
  });

  const strikethroughFallback = createStrikethroughFallback(state);

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
    markdown({ extensions: [Strikethrough, Table, CommentExtension, HighlightExtension] }),
    history(),
    drawSelection(),
    wrapOnSelection,
    updateListener,
    strikethroughFallback,
    // Forward-only writing reaches every doc surface, not just the main
    // editor — a pane or stack column would otherwise be a way around a
    // ratcheted desk. The pointer handling stays off here so a
    // programmatic jump (shelf search hit, scrollToPosition) can still
    // move a reference surface's cursor.
    createRatchetExtensions(state, { fragment: !!opts?.fragment }),
    _shortcutComp.of(buildShortcutExtension(state)),
    createCalloutPlugin(),
    createFootnotePlugin(state),
    createFlagHighlightPlugin(state),
    createYouAreHerePlugin(),
    createLineIndicatorPlugin(state, { flush: !!opts?.flushLineIndicator }),
    createLinkDecoratorPlugin(state),
    createWikilinkPlugin(state),
    createCitationPlugin(state),
    createTabMarkerPlugin(),
    createCheckboxListPlugin(),
    createTableRendererPlugin(),
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
    buildFoldingExtension(),
    createFoldArrowPlugin(),
    createPropertiesPlugin(state),
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
