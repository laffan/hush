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
    reconfigureTheme: (settings) => {
      const t = getActiveTheme(settings);
      const style = settings.activeStyleId
        ? (settings.styles || []).find(s => s.id === settings.activeStyleId) : null;
      const nh = style?.suppressHeaderSize ?? settings.normalizeHeaders;
      const nhc = style?.suppressHeaderColor ?? settings.normalizeHeaderColor;
      const hScale = style?.headerScale ?? settings.headerScale ?? 1.0;
      const headerOverride = (style && ((settings.appearance === "dark" ? style.darkColors : style.lightColors)?.header))
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
