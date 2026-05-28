/**
 * Markdown syntax-highlight style + header-colour resolution.
 *
 * Extracted from `editor.js` so the main editor module stays under the
 * 700-line cap. Both the main editor and floating pane editors compose
 * their CodeMirror highlight extension from `getMarkdownHighlight()`,
 * picking heading colour/scale via `resolveHeaderColorOverride()` against
 * the active style + appearance.
 */
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { commentTag, commentMarkTag, highlightTag, highlightMarkTag } from "./editor.js";

// Resolve the header color override for the active style (or the Default
// style — its colors live on `defaultLightColors`/`defaultDarkColors`),
// honouring the current appearance including "auto".
export function resolveHeaderColorOverride(state, activeStyle) {
  let mode = state.settings.appearance || "dark";
  if (mode === "auto") {
    mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (activeStyle) {
    const colors = mode === "dark" ? activeStyle.darkColors : activeStyle.lightColors;
    return colors?.header || undefined;
  }
  const defaults = mode === "dark" ? state.settings.defaultDarkColors : state.settings.defaultLightColors;
  return defaults?.header || undefined;
}

// Build the markdown highlight style, optionally normalizing heading sizes/colors.
// `headerScale` is a multiplier on the default heading progression (default 1.0).
export function getMarkdownHighlight(normalizeHeaders, headingColor, headerScale, opts) {
  const underline = opts?.underline === true;
  const color = headingColor || undefined;
  const k = typeof headerScale === "number" && headerScale > 0 ? headerScale : 1.0;
  const td = underline ? "underline" : undefined;
  const headingStyles = normalizeHeaders
    ? [
        { tag: tags.heading1, fontWeight: "700", color, textDecoration: td },
        { tag: tags.heading2, fontWeight: "700", color, textDecoration: td },
        { tag: tags.heading3, fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading4, fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading5, fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading6, fontWeight: "600", color, textDecoration: td },
      ]
    : [
        { tag: tags.heading1, fontSize: `calc(var(--font-size) * ${1.8 * k})`, fontWeight: "700", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading2, fontSize: `calc(var(--font-size) * ${1.5 * k})`, fontWeight: "700", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading3, fontSize: `calc(var(--font-size) * ${1.3 * k})`, fontWeight: "600", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading4, fontSize: `calc(var(--font-size) * ${1.15 * k})`, fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading5, fontSize: `calc(var(--font-size) * ${1.05 * k})`, fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading6, fontSize: `calc(var(--font-size) * ${1.0 * k})`, fontWeight: "600", color, textDecoration: td },
      ];

  return HighlightStyle.define([
    ...headingStyles,
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.quote, fontStyle: "italic", opacity: "0.8" },
    { tag: tags.strikethrough, textDecoration: "line-through", opacity: "0.3" },
    { tag: tags.link, textDecoration: "underline", color: "var(--link, currentColor)" },
    { tag: tags.url, textDecoration: "underline", opacity: "0.7", color: "var(--link, currentColor)" },
    { tag: tags.monospace, fontFamily: "'Fira Code', 'Consolas', monospace", fontSize: "calc(var(--font-size) * 0.9)" },
    // Custom syntax: %% comments %% — content dimmed; markers nearly invisible.
    // Body opacity drives off --comment-opacity (user-controlled slider).
    // Comment opacity is handled by the ViewPlugin in comment-plugins.js
    // via inline style attributes (guarantees the user's slider always
    // takes effect regardless of theme specificity).
    { tag: commentTag },
    { tag: commentMarkTag },
    // Custom syntax: == highlight == — highlighted background (flag-typed highlights get per-flag color from plugin)
    { tag: highlightTag, borderRadius: "2px" },
    { tag: highlightMarkTag, opacity: "0.2" },
    // Dim the markdown syntax characters (# * _ ` ~~ etc.)
    { tag: tags.processingInstruction, opacity: "0.4" },
  ]);
}
