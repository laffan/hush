/**
 * Markdown syntax-highlight style + header-colour resolution.
 *
 * Extracted from `editor.js` so the main editor module stays under the
 * 700-line cap. Both the main editor and floating pane editors compose
 * their CodeMirror highlight extension from `getMarkdownHighlight()`,
 * picking heading colour via `resolveHeaderColorOverride()` against the
 * active style + appearance, and heading size via `headingSizeOf()`.
 */
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { commentTag, commentMarkTag, highlightTag, highlightMarkTag } from "./markdown-extensions.js";
import { getActiveTheme } from "../themes/index.js";

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

/**
 * The heading colour a surface should actually paint: the style's
 * override if it has one, else the resolved theme's own. The `||` pair
 * was hand-written at half a dozen call sites; anything new that needs
 * the colour — the `--heading-color` custom property the outline's
 * "next item" reads, for one — takes it from here so a future change to
 * the fallback reaches every one of them.
 */
export function resolveHeadingColor(state, activeStyle) {
  return resolveHeaderColorOverride(state, activeStyle) || getActiveTheme(state.settings)?.headingColor || null;
}

/** Each heading level's size over the body text at the default setting. */
const HEADING_RATIOS = [1.8, 1.5, 1.3, 1.15, 1.05, 1.0];

/** The style editor's Size slider runs over this range. */
export const HEADING_SIZE_MIN = 0;
export const HEADING_SIZE_MAX = 3;

const clampSize = (v) => Math.min(HEADING_SIZE_MAX, Math.max(HEADING_SIZE_MIN, v));

/**
 * A style's (or the Default style's settings') heading size: 0 sets
 * headings at the body size, 1 is the default progression, and each step
 * past it adds that much again of each level's lift over the body. Read
 * from `headingSize`; a style saved before it had one carries the old
 * `headerScale`, which multiplied the whole size (so it could never reach
 * the body size), and is converted so its H1 keeps the size it had.
 * Null when the object has neither.
 */
export function resolveHeadingSize(obj) {
  if (typeof obj?.headingSize === "number" && Number.isFinite(obj.headingSize)) {
    return clampSize(obj.headingSize);
  }
  if (typeof obj?.headerScale === "number" && obj.headerScale > 0) {
    return clampSize((HEADING_RATIOS[0] * obj.headerScale - 1) / (HEADING_RATIOS[0] - 1));
  }
  return null;
}

/** The heading size a surface paints: the style's, else the Default
 *  style's (settings), else 1. */
export function headingSizeOf(style, settings) {
  return resolveHeadingSize(style) ?? resolveHeadingSize(settings) ?? 1;
}

/** The `headerScale` an older build reads for `size`, written beside
 *  `headingSize` so a style synced to one keeps its H1 size there. */
export function legacyHeaderScale(size) {
  return (1 + (HEADING_RATIOS[0] - 1) * size) / HEADING_RATIOS[0];
}

/** Font size of heading `level` (1–6) as a multiple of the body size. */
export function headingFontScale(level, size) {
  const r = HEADING_RATIOS[Math.min(6, Math.max(1, level)) - 1];
  return 1 + (r - 1) * size;
}

// One HighlightStyle per distinct set of arguments. Each `define` mints a
// fresh StyleModule — new class names, new rules mounted in the document —
// so rebuilding on every theme / style event (a slider drag fires dozens)
// grew the stylesheet without bound and slowed every style recalc after.
const highlightCache = new Map();
const HIGHLIGHT_CACHE_MAX = 32;

// Build the markdown highlight style, optionally normalizing heading sizes/colors.
// `headingSize` is the style's heading size (see `resolveHeadingSize`; default 1).
export function getMarkdownHighlight(normalizeHeaders, headingColor, headingSize, opts) {
  const underline = opts?.underline === true;
  const color = headingColor || undefined;
  const k = typeof headingSize === "number" && Number.isFinite(headingSize) ? clampSize(headingSize) : 1.0;
  const key = `${!!normalizeHeaders}|${color || ""}|${k}|${underline}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;
  const built = buildMarkdownHighlight(normalizeHeaders, color, k, underline);
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) highlightCache.delete(highlightCache.keys().next().value);
  highlightCache.set(key, built);
  return built;
}

function buildMarkdownHighlight(normalizeHeaders, color, k, underline) {
  const size = (level) => `calc(var(--font-size) * ${headingFontScale(level, k)})`;
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
        { tag: tags.heading1, fontSize: size(1), fontWeight: "700", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading2, fontSize: size(2), fontWeight: "700", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading3, fontSize: size(3), fontWeight: "600", lineHeight: "1.3", color, textDecoration: td },
        { tag: tags.heading4, fontSize: size(4), fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading5, fontSize: size(5), fontWeight: "600", color, textDecoration: td },
        { tag: tags.heading6, fontSize: size(6), fontWeight: "600", color, textDecoration: td },
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
