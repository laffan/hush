import { getActiveTheme } from "../themes/index.js";
import { resolveStyleForAppearance } from "../sidebar/styles-panel.js";

/** Toggle block cursor class and pick its colour. A style's explicit
 *  cursor-colour override wins (so the override keeps working in block
 *  mode, matching the caret mode); otherwise the block cursor falls back
 *  to the active theme's heading colour for visibility. */
export function applyBlockCursor(state) {
  const container = document.getElementById("editor-container");
  if (!container) return;
  let block = !!state.settings.blockCursor;
  // Resolve any explicit cursor-colour override from the active style
  // (or, for the default style, the per-appearance default colours).
  let cursorOverride = null;
  if (state.settings.activeStyleId && state.settings.styles) {
    const style = state.settings.styles.find(s => s.id === state.settings.activeStyleId);
    if (style) {
      if (style.blockCursor != null) block = style.blockCursor;
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
  container.classList.toggle("block-cursor", block);
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
