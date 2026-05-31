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
 *  to the active theme's heading colour for visibility. */
export function applyBlockCursor(state) {
  const container = document.getElementById("editor-container");
  if (!container) return;
  let style = null;
  let cursorOverride = null;
  if (state.settings.activeStyleId && state.settings.styles) {
    style = state.settings.styles.find(s => s.id === state.settings.activeStyleId) || null;
    if (style) {
      const { colors } = resolveStyleForAppearance(style, state.settings.appearance);
      const overrides = colors || style.colorOverrides || {};
      cursorOverride = overrides.cursor || null;
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
  }
  const mode = resolveCursorMode(state, style);
  container.classList.toggle("block-cursor", mode === "block");
  container.classList.toggle("underline-cursor", mode === "underline");
  if (cursorOverride) {
    container.style.setProperty("--block-cursor-color", cursorOverride);
  } else {
    const theme = getActiveTheme(state.settings);
    if (theme && theme.headingColor) {
      container.style.setProperty("--block-cursor-color", theme.headingColor);
    } else {
      container.style.removeProperty("--block-cursor-color");
    }
  }
}
