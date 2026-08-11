/**
 * Style modal — preview pane logic.
 *
 * Extracted from style-modal.js so the modal stays under the 700-line
 * cap. Owns the live demo render (typography, theme colours, header
 * scaling, line-indicator chrome, cursor demo) plus the simple
 * markdown-to-HTML formatter that feeds the preview text.
 */

import {
  escHtml,
  themeBackgrounds,
  themeForegrounds,
  resolveCursorMode,
  applyPreviewCursorMode,
} from "./styles-panel-shared.js";
import { getThemeById } from "../themes/index.js";

export const PREVIEW_MD = `# The Art of Writing

## Finding Your Voice

Every writer begins with a blank page and a spark of intention. The words that follow are shaped by years of reading, thinking, and living.

### On Simplicity

Good prose is like a [window pane](#) — clear, direct, and invisible. **Bold ideas** need not hide behind *ornate language*. Strip away the excess until only the essential remains.

> "Write drunk, edit sober." — Ernest Hemingway

The best sentences carry weight without effort, landing softly in the reader's mind. ~~Perfection~~ is not the goal — clarity is.`;

const FONT_FALLBACK_MAP = {
  "Helvetica": "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
  "EB Garamond": "'EB Garamond', 'Georgia', 'Times New Roman', serif",
  "Inter": "'Inter', system-ui, -apple-system, sans-serif",
  "Fira Code": "'Fira Code', 'Fira Mono', 'Consolas', monospace",
  "Source Sans Pro": "'Source Sans Pro', 'Helvetica Neue', 'Arial', sans-serif",
  "Source Serif Pro": "'Source Serif Pro', 'Georgia', 'Times New Roman', serif",
  "Libre Franklin": "'Libre Franklin', 'Helvetica Neue', 'Arial', sans-serif",
  "Libre Baskerville": "'Libre Baskerville', 'Georgia', 'Times New Roman', serif",
  "Karla": "'Karla', 'Helvetica Neue', 'Arial', sans-serif",
  "Lora": "'Lora', 'Georgia', 'Times New Roman', serif",
  "iA Writer Duo": "'iA Writer Duo', 'Menlo', 'Consolas', monospace",
  "iA Writer Mono": "'iA Writer Mono', 'Menlo', 'Consolas', monospace",
  "iA Writer Quattro": "'iA Writer Quattro', 'Helvetica Neue', 'Arial', sans-serif",
};

export function fontFallback(family) {
  return FONT_FALLBACK_MAP[family] || `'${family}', system-ui, sans-serif`;
}

/** Resolve a colour key against a theme. Returns a hex string suitable
 *  for <input type="color">; selection isn't a solid colour in the
 *  themes, so we pick a neutral approximation per appearance. */
export function themeColorFor(key, themeId, colorTab) {
  const theme = getThemeById(themeId);
  const bg = themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
  const fg = themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
  switch (key) {
    case "bg": return bg;
    case "fg": return fg;
    case "header": return theme?.headingColor || fg;
    case "cursor": return fg;
    case "lineIndicator": return fg;
    case "selection": return colorTab === "light" ? "#c8c8c8" : "#3a3a3a";
    default: return fg;
  }
}

/** Seed the colour overrides for the given appearance from the theme. */
export function seedColorsFromTheme(draft, colorTab, themeId) {
  if (!themeId) return;
  const filled = {
    bg: themeColorFor("bg", themeId, colorTab),
    fg: themeColorFor("fg", themeId, colorTab),
    header: themeColorFor("header", themeId, colorTab),
    cursor: themeColorFor("cursor", themeId, colorTab),
    selection: themeColorFor("selection", themeId, colorTab),
  };
  if (colorTab === "light") draft.lightColors = filled;
  else draft.darkColors = filled;
}

export function formatPreviewHtml(md) {
  return md.split("\n").map(line => {
    if (line.startsWith("### ")) return `<div class="preview-h3">${fmtInline(line.slice(4))}</div>`;
    if (line.startsWith("## ")) return `<div class="preview-h2">${fmtInline(line.slice(3))}</div>`;
    if (line.startsWith("# ")) return `<div class="preview-h1">${fmtInline(line.slice(2))}</div>`;
    if (line.startsWith("> ")) return `<div class="preview-bq">${fmtInline(line.slice(2))}</div>`;
    if (line.trim() === "") return `<div class="preview-blank">&nbsp;</div>`;
    return `<div>${fmtInline(line)}</div>`;
  }).join("");
}

function fmtInline(text) {
  return escHtml(text)
    .replace(/\[(.+?)\]\((.+?)\)/g, '<span class="preview-link" style="text-decoration:underline">$1</span>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

/** Render the live preview pane. `previewState` carries the
 *  dropdown-hover overrides (themeId, fontFamily) — non-null entries
 *  win over the draft. */
export function updatePreview(state, backdrop, draft, colorTab, previewState) {
  const pane = backdrop.querySelector("#style-preview-pane");
  if (!pane) return;
  const { themeId: previewThemeId, fontFamily: previewFontFamily } = previewState;

  // Hover-preview wins over the draft. Theme hover seeds fresh colors
  // so the pane shows the theme itself, not draft overrides.
  const draftThemeId = colorTab === "light" ? draft.lightThemeId : draft.darkThemeId;
  const themeId = previewThemeId || draftThemeId;
  const colors = previewThemeId
    ? {
        bg: themeColorFor("bg", previewThemeId, colorTab),
        fg: themeColorFor("fg", previewThemeId, colorTab),
        header: themeColorFor("header", previewThemeId, colorTab),
        cursor: themeColorFor("cursor", previewThemeId, colorTab),
        selection: themeColorFor("selection", previewThemeId, colorTab),
      }
    : (colorTab === "light" ? (draft.lightColors || {}) : (draft.darkColors || {}));

  const bg = colors.bg || themeBackgrounds[themeId] || (colorTab === "light" ? "#fafafa" : "#1a1a1a");
  const fg = colors.fg || themeForegrounds[themeId] || (colorTab === "light" ? "#1a1a1a" : "#e0e0e0");
  const cursor = colors.cursor || fg;
  const selection = colors.selection || "rgba(128, 128, 128, 0.3)";
  const editorDefaultFont = state.settings.fontFamily || "EB Garamond";
  const effectiveFont = previewFontFamily !== null
    ? (previewFontFamily || editorDefaultFont)
    : (draft.fontFamily || editorDefaultFont);
  const font = fontFallback(effectiveFont);
  const size = (draft.fontSize || state.settings.fontSize || 20) + "px";
  const lh = draft.lineHeight || state.settings.lineHeight || 1.6;
  const cursorMode = resolveCursorMode(draft, state.settings);

  pane.style.background = bg;
  pane.style.color = fg;
  pane.style.fontFamily = font;
  pane.style.fontSize = size;
  pane.style.lineHeight = lh;

  // Publish the resolved caret colour on the pane so a caret background
  // layer set to "match caret colour" reads the *draft's* caret rather
  // than the app's — the layer picks `--cursor` up off its host, which
  // is a child of this pane in the scoped preview.
  pane.style.setProperty("--cursor", cursor);

  // The preview's light / dark switch sits outside the pane (see
  // style-modal.js), so it can't inherit the preview's colours — paint
  // it here or it goes invisible whenever the preview and the modal
  // chrome land on the same tone.
  const appearanceToggle = backdrop.querySelector(".style-preview-appearance");
  if (appearanceToggle) appearanceToggle.style.color = fg;

  // Line indicator preview — toggle the matching `line-ind-<variant>`
  // class on the preview pane and publish the indicator colour from
  // the per-appearance colour set (cursor colour as fallback).
  const liColor = colors.lineIndicator
    || colors.cursor
    || (getThemeById(themeId) && getThemeById(themeId).headingColor)
    || cursor;
  pane.style.setProperty("--line-indicator-color", liColor);
  const liVariant = draft.lineIndicator && draft.lineIndicator !== "none" ? draft.lineIndicator : null;
  const allVariants = ["left-arrow", "double-arrow", "left-border", "border", "highlight"];
  allVariants.forEach(v => pane.classList.remove("line-ind-" + v));
  if (liVariant) pane.classList.add("line-ind-" + liVariant);

  const cursorEl = pane.querySelector(".preview-cursor");
  if (cursorEl) {
    const themeObj = getThemeById(themeId);
    const accent = colors.cursor || (themeObj && themeObj.headingColor) || cursor;
    applyPreviewCursorMode(cursorEl, cursorMode, accent, cursor);
  }

  const selEl = pane.querySelector(".preview-selected");
  if (selEl) selEl.style.background = selection;
  pane.querySelectorAll(".preview-link").forEach(el => { el.style.color = colors.links || fg; });

  const theme = getThemeById(themeId);
  const headingColor = draft.suppressHeaderColor
    ? fg
    : (colors.header || (theme ? theme.headingColor : fg));
  const scale = draft.headerScale != null ? draft.headerScale : 1.0;
  const baseSize = draft.fontSize || state.settings.fontSize || 20;
  const suppressSize = !!draft.suppressHeaderSize;
  const scales = { h1: 1.8, h2: 1.5, h3: 1.3 };
  pane.querySelectorAll(".preview-h1, .preview-h2, .preview-h3").forEach(el => {
    el.style.color = headingColor;
    el.style.textDecoration = draft.underlineHeaders ? "underline" : "";
    if (suppressSize) {
      el.style.fontSize = baseSize + "px";
    } else {
      const tag = el.classList.contains("preview-h1") ? "h1"
        : el.classList.contains("preview-h2") ? "h2" : "h3";
      el.style.fontSize = (baseSize * scales[tag] * scale) + "px";
    }
  });
}
