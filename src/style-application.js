/**
 * Apply the active style + focus-mode opacity to the document. Both
 * functions write CSS custom properties on `<html>` so the editor, panels,
 * and floating panes pick up consistent values without per-component
 * setters. Pulled out of main.js to keep that file as orchestration only.
 */
import { applyAppearance } from "./settings/settings-ui.js";
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";
import { themeBackgrounds, updatePrivateBoxColor, applyFontFamily } from "./theme-colors.js";

// Tracks whether the shader-layer module has ever been loaded this session.
// We only `import()` it when a style with shaderLayer.enabled === true is
// applied, so users who never opt in don't pay for the chunk.
let _shaderModulePromise = null;
function loadShaderModule() {
  if (!_shaderModulePromise) _shaderModulePromise = import("./shader-layer/index.js");
  return _shaderModulePromise;
}

function syncShaderLayerForStyle(style) {
  const cfg = style && style.shaderLayer;
  if (!cfg || !cfg.enabled || !cfg.layerId) {
    // Only touch the shader subsystem if it's already been loaded this
    // session — otherwise importing it just to call unmount would defeat
    // the whole "free when off" premise.
    if (_shaderModulePromise) {
      loadShaderModule().then(m => m.unmountShaderLayer()).catch(() => {});
    }
    return;
  }
  loadShaderModule().then(m => m.applyShaderLayer({
    layerId: cfg.layerId,
    intensity: typeof cfg.intensity === "number" ? cfg.intensity : 0.5,
    options: cfg.options || {},
  })).catch(e => console.warn("shader layer mount failed", e));
}

/** Publish the editor opacity CSS variables — `--focus-mode-opacity`
 *  for the focus-mode sentence dim (and pane background dim), plus
 *  `--comment-opacity` for the body of `%%…%%` comments. Called once
 *  at startup and on every `settings-changed` so the matching sliders
 *  drive both values without any direct DOM coupling. */
export function applyFocusModeOpacity(state) {
  const fv = state.settings.focusModeOpacity;
  const fo = (typeof fv === "number" && fv >= 0 && fv <= 1) ? fv : 0.5;
  document.documentElement.style.setProperty("--focus-mode-opacity", String(fo));
  const cv = state.settings.commentOpacity;
  const co = (typeof cv === "number" && cv >= 0 && cv <= 1) ? cv : 0.5;
  document.documentElement.style.setProperty("--comment-opacity", String(co));
  document.documentElement.style.setProperty("--comment-mark-opacity", String(co * 2 / 3));
}

/** Pull the active desk's saved global style id and pin it as the
 *  runtime `activeStyleId` if it isn't already. Emits `style-changed`
 *  so the editor / panes / shader runtime repaint. Used by the
 *  file-open and desk-switch handlers in main.js. */
export function applyDeskGlobalStyle(state) {
  const next = state.getDeskGlobalStyleId();
  if (state.settings.activeStyleId === next) return;
  state.updateSettings({ activeStyleId: next });
  state.emit("style-changed");
}

/** Publish (or clear) the decorative background-image CSS variables read
 *  by the `.cm-editor::before` layer. `cfg` is a style's `backgroundImage`
 *  object or null. */
function applyStyleBackgroundImage(cfg) {
  const root = document.documentElement.style;
  if (cfg && cfg.enabled && cfg.src) {
    root.setProperty("--style-bg-image", `url("${cfg.src}")`);
    root.setProperty("--style-bg-size", cfg.fit || "cover");
    root.setProperty("--style-bg-repeat", cfg.repeat || "no-repeat");
    root.setProperty("--style-bg-blend", cfg.blend || "normal");
    root.setProperty("--style-bg-opacity", String(cfg.opacity != null ? cfg.opacity : 1));
    document.body.classList.add("style-bg-image-active");
  } else {
    root.removeProperty("--style-bg-image");
    root.setProperty("--style-bg-opacity", "0");
    document.body.classList.remove("style-bg-image-active");
  }
}

export function applyActiveStyle(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) {
    // Default style — use standard editor settings, then layer the
    // user's per-appearance Default-style colour overrides on top.
    // Resolve which palette to read first so we know whether each
    // override (bg/fg/cursor/selection) has a value or should fall
    // back to the resolved theme's stock colour.
    let appearance = state.settings.appearance || "dark";
    if (appearance === "auto") {
      appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    const defaultColors = appearance === "dark"
      ? (state.settings.defaultDarkColors || {})
      : (state.settings.defaultLightColors || {});

    document.body.classList.remove("style-active");
    const cmEditor = document.querySelector('.cm-editor');
    // Re-apply standard settings (theme + font + size live here)
    applyAppearance(state.settings.appearance || "dark");
    applyFontFamily(state.settings.fontFamily);
    document.documentElement.style.setProperty("--font-size", state.settings.fontSize + "px");
    document.documentElement.style.setProperty("--line-height", state.settings.lineHeight);
    state.emit("theme-changed");

    // Background override — fall back to the resolved theme's bg.
    if (defaultColors.bg) {
      document.documentElement.style.setProperty("--bg", defaultColors.bg);
      document.documentElement.style.setProperty("--style-bg", defaultColors.bg);
      if (cmEditor) cmEditor.style.backgroundColor = defaultColors.bg;
    } else {
      const themeId = appearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme;
      const themeBg = themeBackgrounds[themeId];
      if (themeBg) document.documentElement.style.setProperty("--bg", themeBg);
      document.documentElement.style.removeProperty("--style-bg");
      if (cmEditor) cmEditor.style.backgroundColor = '';
    }
    // Foreground override — scoped to the editor (sidebar / panels
    // keep the global --fg) so it matches the user-style branch.
    if (defaultColors.fg) {
      document.documentElement.style.setProperty("--style-fg", defaultColors.fg);
      if (cmEditor) cmEditor.style.color = defaultColors.fg;
      if (!defaultColors.cursor) {
        document.documentElement.style.setProperty("--cursor", defaultColors.fg);
      }
    } else {
      document.documentElement.style.removeProperty("--style-fg");
      if (cmEditor) cmEditor.style.color = '';
    }
    if (defaultColors.cursor) {
      document.documentElement.style.setProperty("--cursor", defaultColors.cursor);
      document.documentElement.style.setProperty("--style-cursor", defaultColors.cursor);
    } else {
      document.documentElement.style.removeProperty("--style-cursor");
    }
    if (defaultColors.selection) {
      document.documentElement.style.setProperty("--selection", defaultColors.selection);
    } else {
      document.documentElement.style.removeProperty("--selection");
    }
    // Link colour override — CSS falls back to currentColor (the text
    // colour) when unset, so links default to the text colour.
    if (defaultColors.links) {
      document.documentElement.style.setProperty("--link", defaultColors.links);
    } else {
      document.documentElement.style.removeProperty("--link");
    }

    // Pass the resolved bg (override or theme) through so the sidebar
    // and other --theme-bg consumers track the default style's bg
    // override. Without this, updatePrivateBoxColor falls back to the
    // raw theme bg when no activeStyleId is set, leaving the sidebar
    // mismatched with the editor.
    {
      const themeId = appearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme;
      const resolvedBg = defaultColors.bg || themeBackgrounds[themeId];
      updatePrivateBoxColor(state, resolvedBg, defaultColors.fg || null);
    }
    // Default style has no line-indicator colour override of its own —
    // strip any leftover from a previously-active user style so the
    // fallback (`var(--cursor)`) takes over.
    document.documentElement.style.removeProperty("--line-indicator-color");
    // Default style's shader lives at the top level of AppSettings.
    syncShaderLayerForStyle({ shaderLayer: state.settings.shaderLayer });
    applyStyleBackgroundImage(null);
    return;
  }

  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return;
  syncShaderLayerForStyle(style);
  applyStyleBackgroundImage(style.backgroundImage);

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
  // Link colour override — CSS falls back to currentColor (the text
  // colour) when unset, so links default to the text colour.
  if (overrides.links) {
    document.documentElement.style.setProperty("--link", overrides.links);
  } else {
    document.documentElement.style.removeProperty("--link");
  }
  // Line indicator colour override — CSS falls back to `--cursor` when
  // unset, so the indicator defaults to the cursor colour.
  if (style.lineIndicatorColor) {
    document.documentElement.style.setProperty("--line-indicator-color", style.lineIndicatorColor);
  } else {
    document.documentElement.style.removeProperty("--line-indicator-color");
  }
}

/** Handle an OAuth authorization code from a deep-link callback.
 *  `provider` is "dropbox" or "google"; defaults to dropbox for old call sites. */
export async function handleOAuthCode(state, invoke, code, provider = "dropbox") {
  try {
    const verifier = sessionStorage.getItem("hush_oauth_verifier");
    if (!verifier) return;
    const mod = provider === "google"
      ? await import("./google-docs/auth.js")
      : await import("./sync/dropbox.js");
    const redirectUri = sessionStorage.getItem("hush_oauth_redirect") || mod.getRedirectUri();
    await mod.completeOAuthFlow(code, verifier, redirectUri);
    sessionStorage.removeItem("hush_oauth_verifier");
    sessionStorage.removeItem("hush_oauth_redirect");
    sessionStorage.removeItem("hush_oauth_provider");
    state.settings = await invoke("get_settings");
    state.emit("settings-changed");
  } catch (e) {
    console.error(`OAuth callback failed (${provider}):`, e);
  }
}
