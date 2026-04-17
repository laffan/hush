/**
 * Pane editor factory — creates a fully-featured CodeMirror 6 editor
 * for use inside floating panes.  Uses `createBaseExtensions` from
 * editor.js so pane editors share the exact same plugin / shortcut /
 * theme setup as the main editor.
 */

import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { getActiveTheme } from "../themes.js";
import {
  createBaseExtensions, getMarkdownHighlight, buildShortcutExtension,
} from "../editor/editor.js";

/**
 * Create a CodeMirror editor suitable for a floating pane.
 * Returns { view, getContent, setContent, focus, blur, destroy, reconfigureTheme }.
 */
export function createPaneEditor(container, appState, onChange) {
  const { extensions, themeComp, highlightComp, shortcutComp, editableComp } =
    createBaseExtensions(appState, onChange ? () => onChange() : null);

  const startState = EditorState.create({ doc: "", extensions });
  const view = new EditorView({ state: startState, parent: container });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    setEditable: (editable) => {
      view.dispatch({ effects: editableComp.reconfigure(EditorView.editable.of(editable)) });
    },
    destroy: () => view.destroy(),
    /** Reconfigure theme from the given settings. When `lockedStyleId` is
     *  provided, the pane uses that style instead of the session's active
     *  style — this is how panes showing a document with "Lock Style to
     *  Document" enabled end up with the locked style even when the main
     *  editor is showing something else. */
    reconfigureTheme: (settings, lockedStyleId) => {
      const effective = lockedStyleId
        ? resolveLockedStyleSettings(settings, lockedStyleId)
        : settings;
      const t = getActiveTheme(effective);
      const style = effective.activeStyleId
        ? (effective.styles || []).find(s => s.id === effective.activeStyleId) : null;
      const nh = style?.suppressHeaderSize ?? effective.normalizeHeaders;
      const nhc = style?.suppressHeaderColor ?? effective.normalizeHeaderColor;
      const hScale = style?.headerScale ?? effective.headerScale ?? 1.0;
      const headerOverride = (style && ((effective.appearance === "dark" ? style.darkColors : style.lightColors)?.header))
        || undefined;
      view.dispatch({
        effects: [
          themeComp.reconfigure(t ? t.extension : []),
          highlightComp.reconfigure(syntaxHighlighting(
            getMarkdownHighlight(nh, nhc ? undefined : (headerOverride || t?.headingColor), hScale)
          )),
          shortcutComp.reconfigure(buildShortcutExtension(appState)),
        ],
      });
    },
  };
}

/** Build a shallow copy of settings with its activeStyleId swapped for
 *  the locked style id. "__default__" means "no style" — explicitly clear
 *  activeStyleId so the default theme/font is used. */
function resolveLockedStyleSettings(settings, lockedStyleId) {
  if (lockedStyleId === "__default__") {
    return { ...settings, activeStyleId: null };
  }
  const exists = (settings.styles || []).some(s => s.id === lockedStyleId);
  if (!exists) return settings; // style was deleted — fall back to session
  return { ...settings, activeStyleId: lockedStyleId };
}
