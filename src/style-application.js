/**
 * Apply the active style + focus-mode opacity to the document. Both
 * functions write CSS custom properties on `<html>` so the editor, panels,
 * and floating panes pick up consistent values without per-component
 * setters. Pulled out of main.js to keep that file as orchestration only.
 */
import { applyAppearance } from "./settings/settings-ui.js";
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";
import { themeBackgrounds, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";

/** Surface the user's "Focus mode opacity" setting as a CSS variable so
 *  every dim target (the sentence-mask in the editor, every floating
 *  pane that isn't the active one) reads the same value. */
export function applyFocusModeOpacity(state) {
  const v = state.settings.focusModeOpacity;
  const opacity = (typeof v === "number" && v >= 0 && v <= 1) ? v : 0.5;
  document.documentElement.style.setProperty("--focus-mode-opacity", String(opacity));
}

export function applyActiveStyle(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) {
    // Default style — use standard editor settings, remove style overrides
    document.documentElement.style.removeProperty("--style-bg");
    document.documentElement.style.removeProperty("--style-fg");
    document.documentElement.style.removeProperty("--style-cursor");
    document.documentElement.style.removeProperty("--selection");
    document.body.classList.remove("style-active");
    // Clear editor overrides
    const cmEditor = document.querySelector('.cm-editor');
    if (cmEditor) {
      cmEditor.style.backgroundColor = '';
      cmEditor.style.color = '';
    }
    // Re-apply standard settings
    applyAppearance(state.settings.appearance || "dark");
    applyFontFamily(state.settings.fontFamily);
    document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
    document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
    state.emit("theme-changed");
    updatePrivateBoxColor(state);
    return;
  }

  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return;

  // Apply style overrides
  document.body.classList.add("style-active");

  // Style fields fall back to the global default whenever the style
  // doesn't override them — the style is "use my font / size / line
  // height", not "leave the previous style's values in place". Without
  // the fallback, switching from a style with `fontFamily: "Lora"` to
  // one with `fontFamily: null` left Lora active because the unset
  // case was silently skipped.
  applyFontFamily(style.fontFamily || state.settings.fontFamily);
  document.documentElement.style.setProperty(
    "--font-size",
    (style.fontSize || state.settings.fontSize) + "px",
  );
  document.documentElement.style.setProperty(
    "--line-height",
    style.lineHeight || state.settings.lineHeight,
  );

  // Apply the style's theme first, then color overrides on top
  state.emit("theme-changed");

  // Resolve the correct color set for current appearance (light vs dark)
  const { colors: resolvedColors } = resolveStyleForAppearance(style, state.settings.appearance);
  // Also support legacy single-mode colorOverrides
  const overrides = resolvedColors || style.colorOverrides || {};
  updatePrivateBoxColor(state);

  const cmEditorEl = document.querySelector('.cm-editor');
  // Always update --bg to match the actual background (override or theme)
  const { themeId: resolvedThemeId } = resolveStyleForAppearance(style, state.settings.appearance);
  // Resolve appearance for the global-theme fallback (handles "auto").
  let effAppearance = state.settings.appearance || "dark";
  if (effAppearance === "auto") {
    effAppearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  // Robust fallback chain: style override → style's resolved theme →
  // global appearance theme. The third arm matters for legacy styles
  // that only set one of light/darkThemeId — without it, switching to
  // such a style in the opposite appearance would leave --bg pointed
  // at the prior style's override colour.
  const fallbackTheme = themeBackgrounds[
    effAppearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme
  ] || null;
  const effectiveBg = overrides.bg || themeBackgrounds[resolvedThemeId] || fallbackTheme;
  if (overrides.bg) {
    document.documentElement.style.setProperty("--bg", overrides.bg);
    document.documentElement.style.setProperty("--style-bg", overrides.bg);
    if (cmEditorEl) cmEditorEl.style.backgroundColor = overrides.bg;
  } else {
    if (effectiveBg) {
      document.documentElement.style.setProperty("--bg", effectiveBg);
    }
    // Clear the override-only --style-bg so consumers that key off it
    // don't carry the previous style's override into a no-override style.
    document.documentElement.style.removeProperty("--style-bg");
    if (cmEditorEl) cmEditorEl.style.backgroundColor = '';
  }
  if (overrides.fg) {
    // Apply text color to editor only, not sidebar/panels (--fg is global)
    document.documentElement.style.setProperty("--style-fg", overrides.fg);
    if (cmEditorEl) cmEditorEl.style.color = overrides.fg;
    if (!overrides.cursor) {
      document.documentElement.style.setProperty("--cursor", overrides.fg);
    }
  } else {
    document.documentElement.style.removeProperty("--style-fg");
    if (cmEditorEl) cmEditorEl.style.color = '';
  }
  if (overrides.cursor) {
    document.documentElement.style.setProperty("--cursor", overrides.cursor);
    document.documentElement.style.setProperty("--style-cursor", overrides.cursor);
  }
  if (overrides.selection) {
    document.documentElement.style.setProperty("--selection", overrides.selection);
  } else {
    document.documentElement.style.removeProperty("--selection");
  }
}

/** Handle an OAuth authorization code from a deep-link callback. */
export async function handleOAuthCode(state, invoke, code) {
  try {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    const { getRedirectUri } = await import("./sync/dropbox.js");
    const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || getRedirectUri();
    if (verifier) {
      const dbx = await import("./sync/dropbox.js");
      await dbx.completeOAuthFlow(code, verifier, redirectUri);
      sessionStorage.removeItem("hush_oauth_verifier");
      sessionStorage.removeItem("hush_oauth_redirect");
      state.settings = await invoke("get_settings");
      state.emit("settings-changed");
    }
  } catch (e) {
    console.error("OAuth callback failed:", e);
  }
}
