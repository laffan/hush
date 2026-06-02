import { getActiveTheme } from "../themes/index.js";
import { resolveStyleForAppearance } from "../sidebar/styles-panel.js";

/** Resolve the cursor mode (system / block / underline). New `cursorMode`
 *  field wins; fall back to the legacy `blockCursor` boolean. Style
 *  override beats global setting. */
function resolveCursorMode(state, style) {
  if (style) {
    if (style.cursorMode) return style.cursorMode;
    if (style.blockCursor != null) return style.blockCursor ? "block" : "system";
  }
  if (state.settings.cursorMode) return state.settings.cursorMode;
  return state.settings.blockCursor ? "block" : "system";
}

/** Apply the cursor mode (system / block / underline) and pick its colour.
 *  A style's explicit cursor-colour override wins (so the override keeps
 *  working in block / underline mode); otherwise the cursor falls back
 *  to the active theme's heading colour for visibility. Also publishes
 *  `--line-indicator-color` (style override → cursor colour fallback)
 *  so the line-indicator plugin's CSS variants paint on-brand.
 *
 *  Targets every editor-surface root in the DOM: the main editor
 *  container plus any Zen Focus overlay currently mounted. Zen has its
 *  own CodeMirror outside `#editor-container`, so it needs the cursor
 *  classes painted on its own root for the CSS to bite. */
export function applyBlockCursor(state) {
  const targets = [];
  const main = document.getElementById("editor-container");
  if (main) targets.push(main);
  const zen = document.querySelector(".zen-focus-overlay");
  if (zen) targets.push(zen);
  const sel = document.querySelector(".selection-focus-overlay");
  if (sel) targets.push(sel);
  if (!targets.length) return;
  let style = null;
  let cursorOverride = null;
  let lineIndicatorOverride = null;
  if (state.settings.activeStyleId && state.settings.styles) {
    style = state.settings.styles.find(s => s.id === state.settings.activeStyleId) || null;
    if (style) {
      const { colors } = resolveStyleForAppearance(style, state.settings.appearance);
      const overrides = colors || style.colorOverrides || {};
      cursorOverride = overrides.cursor || null;
      lineIndicatorOverride = overrides.lineIndicator || null;
    }
  } else {
    let appearance = state.settings.appearance || "dark";
    if (appearance === "auto") {
      appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const def = appearance === "dark"
      ? (state.settings.defaultDarkColors || {})
      : (state.settings.defaultLightColors || {});
    cursorOverride = def.cursor || null;
    lineIndicatorOverride = def.lineIndicator || null;
  }
  const mode = resolveCursorMode(state, style);
  const theme = getActiveTheme(state.settings);
  const fallbackCursor = (theme && theme.headingColor) || null;
  const liColor = lineIndicatorOverride || cursorOverride || fallbackCursor;
  for (const el of targets) {
    el.classList.toggle("block-cursor", mode === "block");
    el.classList.toggle("underline-cursor", mode === "underline");
    if (cursorOverride) {
      el.style.setProperty("--block-cursor-color", cursorOverride);
    } else if (fallbackCursor) {
      el.style.setProperty("--block-cursor-color", fallbackCursor);
    } else {
      el.style.removeProperty("--block-cursor-color");
    }
    if (liColor) {
      el.style.setProperty("--line-indicator-color", liColor);
    } else {
      el.style.removeProperty("--line-indicator-color");
    }
  }
}
