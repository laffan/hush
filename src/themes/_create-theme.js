/**
 * createTheme — local equivalent of thememirror's createTheme.
 *
 * Wraps the surface colors (background, foreground, caret, selection,
 * lineHighlight, gutter*) into an `EditorView.theme()` and pairs it with
 * a `HighlightStyle` for the (Hush-curated) syntax tags.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";

export function createTheme({ variant, settings, styles }) {
  const theme = EditorView.theme(
    {
      "&": {
        backgroundColor: settings.background,
        color: settings.foreground,
      },
      ".cm-content": { caretColor: settings.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: settings.caret },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: settings.selection },
      ".cm-activeLine": { backgroundColor: settings.lineHighlight },
      ".cm-gutters": {
        backgroundColor: settings.gutterBackground,
        color: settings.gutterForeground,
      },
      ".cm-activeLineGutter": { backgroundColor: settings.lineHighlight },
    },
    { dark: variant === "dark" },
  );
  const highlightStyle = HighlightStyle.define(styles);
  return [theme, syntaxHighlighting(highlightStyle)];
}
