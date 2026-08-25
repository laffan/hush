/**
 * Theme color helpers — extracted from main.js.
 * Manages --private-box, --theme-bg, --fg, and other CSS vars
 * derived from the active theme or style.
 */
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";

// Chrome surfaces painted from the JS-only `--theme-bg` custom property.
// On iOS WKWebView these do not repaint reliably when the app regains
// focus, so `updatePrivateBoxColor` force-refreshes each with an inline
// background. The left files sidebar's main panel and its grip strip,
// plus the right-side outline / comments / PDF-shelf panels.
const THEME_BG_SURFACES = "#panel-overlay, .sidebar-grip, #right-panel-overlay, #comments-panel, .pdf-shelf-view";

export const fontFallbacks = {
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

// Known theme background colors — must match each theme's `settings.background`
// in src/themes/<theme>.js.
export const themeBackgrounds = {
  dracula: "#2d2f3f", ayuLight: "#fcfcfc", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fef7e5",
  smoothy: "#ffffff", amy: "#200020", barf: "#15191e", bespin: "#2e241d",
  birdsOfParadise: "#3b2627", boysAndGirls: "#000205", cobalt: "#00254b",
  coolGlow: "#060521", espresso: "#ffffff", tomorrow: "#ffffff",
  // VSCode-Ultimate-Themes-Pack imports
  akariNight: "#171b22", auroraBorealis: "#eceff4", aurumDusk: "#1a1614",
  calmDark: "#191f22", darkGreenJungle: "#18211e", eyeComfortDarkPro: "#1e1e1e",
  ghibliForestDark: "#1e2a24", mapleLight: "#fffffe", midnightFrost: "#011627",
  midnightGlow: "#27273a", nuttyLight: "#fffef9", pokemonColor: "#2b2b2b",
  softContrast: "#f5f3ee", solsticeEstival: "#f0eee7",
};

// Known theme foreground (editor text) colors — must match each theme's
// `settings.foreground` in src/themes/<theme>.js. Used so the app's UI
// chrome (buttons, sidebar text, command palette) can track the active
// style/theme's text colour instead of a generic luminance-derived grey.
export const themeForegrounds = {
  dracula: "#f8f8f2", ayuLight: "#5c6166", clouds: "#000000",
  noctisLilac: "#0c006b", rosePineDawn: "#575279", solarizedLight: "#586E75",
  smoothy: "#000000", amy: "#D0D0FF", barf: "#EEF2F7", bespin: "#BAAE9E",
  birdsOfParadise: "#E6E1C4", boysAndGirls: "#FFFFFF", cobalt: "#FFFFFF",
  coolGlow: "#E0E0E0", espresso: "#000000", tomorrow: "#4D4D4C",
  akariNight: "#E6DED3", auroraBorealis: "#2e3440", aurumDusk: "#f2e8dc",
  calmDark: "#e6e2d9", darkGreenJungle: "#d4d4d4", eyeComfortDarkPro: "#d4d4d4",
  ghibliForestDark: "#E8DFD0", mapleLight: "#475569", midnightFrost: "#a7dbf7",
  midnightGlow: "#fcf6ff", nuttyLight: "#2A1F16", pokemonColor: "#eeffff",
  softContrast: "#2B2B2B", solsticeEstival: "#1B3C3C",
};

export function hexLuminance(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Resolve the effective editor colours for the current settings — the
 *  ONE implementation of the chain every surface must agree on:
 *  style override → style's resolved theme → global appearance theme.
 *  The Default style's per-appearance colour maps (defaultLightColors /
 *  defaultDarkColors) stand in for a named style's overrides when no
 *  style is active — that branch is what the sidebar was historically
 *  missing, which let it fall back to the raw theme bg while the editor
 *  honoured the Default style's override. Never reads computed styles:
 *  a getComputedStyle("--bg") read here resolves to the OUTGOING
 *  style's value mid-switch, which is how the sidebar used to lag one
 *  style behind the editor. */
export function resolveEffectiveColors(settings) {
  let appearance = settings.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  const globalThemeId = appearance === "dark" ? settings.darkTheme : settings.lightTheme;

  const style = settings.activeStyleId
    ? (settings.styles || []).find(s => s.id === settings.activeStyleId)
    : null;

  let themeId, overrides;
  if (style) {
    const { themeId: styleThemeId, colors } = resolveStyleForAppearance(style, settings.appearance);
    themeId = styleThemeId || style.themeId;
    overrides = colors || style.colorOverrides || {};
  } else {
    themeId = globalThemeId;
    overrides = (appearance === "dark"
      ? settings.defaultDarkColors
      : settings.defaultLightColors) || {};
  }

  return {
    appearance,
    themeId,
    overrides,
    bg: overrides.bg || themeBackgrounds[themeId] || themeBackgrounds[globalThemeId] || null,
    fg: overrides.fg || themeForegrounds[themeId] || themeForegrounds[globalThemeId] || null,
  };
}

export function updatePrivateBoxColor(state, overrideBg, overrideFg) {
  // `overrideBg` / `overrideFg` exist for the style hover-preview,
  // which paints a style that isn't active yet. Every other caller
  // passes nothing and gets the shared resolver — the same chain
  // applyActiveStyle paints the editor with, so the sidebar cannot
  // resolve a different colour than the editor did.
  const resolved = (overrideBg && overrideFg) ? null : resolveEffectiveColors(state.settings);
  let bg = overrideBg || (resolved && resolved.bg);
  let fg = overrideFg || (resolved && resolved.fg);

  if (!bg) {
    // Unknown theme id (theme tables out of date) — true last resort.
    bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  }

  if (bg && bg.startsWith("#")) {
    const luminance = hexLuminance(bg);
    const isDark = luminance <= 0.5;
    const root = document.documentElement.style;

    // The UI chrome foreground matches the resolved text colour when we
    // have one; otherwise fall back to the legacy luminance-based grey.
    const uiFg = (fg && fg.startsWith("#")) ? fg : (isDark ? "#e0e0e0" : "#1a1a1a");

    // Privacy-mode blocks track the resolved text colour (so a style's fg
    // override paints the boxes too); fall back to the luminance-based
    // black/white when no usable foreground is available.
    root.setProperty("--private-box", (fg && fg.startsWith("#")) ? fg : (isDark ? "#ffffff" : "#000000"));
    root.setProperty("--theme-bg", bg);
    root.setProperty("--fg", uiFg);
    // Cursor mirrors applyActiveStyle's precedence (explicit cursor
    // override → fg override → luminance grey). This function runs
    // AFTER the style writes now, so it must agree with them rather
    // than blanket-writing the grey over a style's cursor.
    const styleCursor = resolved
      ? (resolved.overrides.cursor || resolved.overrides.fg || null)
      : null;
    root.setProperty("--cursor", styleCursor || (isDark ? "#e0e0e0" : "#1a1a1a"));
    root.setProperty("--sidebar-icon-color", isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.45)");
    root.setProperty("--sidebar-icon-hover", isDark ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.85)");
    root.setProperty("--sidebar-fg", isDark ? "#888" : "#888");

    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    root.setProperty("--panel-bg", `rgba(${r}, ${g}, ${b}, 0.98)`);
    root.setProperty("--panel-border", isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)");

    // iOS: set background color directly on html/body to avoid safe-area
    // black bars caused by CSS variable resolution lag during transitions.
    // We also nudge the themed chrome surfaces directly because in
    // production iOS WebView builds their `background: var(--theme-bg)`
    // reads stale after a focus / visibility transition and never
    // repaints on its own — the explicit inline style forces each surface
    // back in sync with the active theme, so the text colour tracks the
    // light/dark switch too.
    if (document.documentElement.classList.contains("ios")) {
      document.documentElement.style.backgroundColor = bg;
      document.body.style.backgroundColor = bg;
      // The left files sidebar (panel + its separate grip strip) and the
      // right-side panels / shelves each need the explicit nudge; without
      // it they revert to the fallback neutral grey on restore.
      for (const el of document.querySelectorAll(THEME_BG_SURFACES)) {
        el.style.backgroundColor = bg;
      }
      const panel = document.getElementById("panel-overlay");
      if (panel) panel.style.color = uiFg;
      pushNativeBackground(bg);
      pushNativeSelectionTint();
    }
  }
}

/** Last colour pushed to the native layers, so the repaint paths above —
 *  which run on every theme touch, every foreground, and every window
 *  resize — cost one IPC per actual colour change rather than one per
 *  call. */
let _lastNativeBg = null;

/** Paint the `UIWindow` / `WKWebView` under the page in the theme colour.
 *  Everything above is CSS, and CSS only helps once the page is painting:
 *  the black the user sees when a second display is plugged in is the
 *  native surface showing through a webview that is still re-compositing.
 *  Fire-and-forget — a no-op on every platform but iOS, and a diagnostic
 *  nicety at that, so it must never break a theme apply. */
function pushNativeBackground(bg) {
  if (bg === _lastNativeBg) return;
  _lastNativeBg = bg;
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  void (async () => {
    try {
      const [{ invoke }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/window"),
      ]);
      await invoke("set_native_background_color", {
        label: getCurrentWindow().label,
        color: bg,
      });
    } catch (_) { /* older binary, or a window mid-teardown */ }
  })();
}

/** Last selection tint pushed to the native layer — same dedupe as the
 *  background above. */
let _lastNativeTint = null;

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` -> `#rrggbb`, or
 *  null for anything this can't read. The native side only takes six hex
 *  digits, and a selection colour arrives in any of these forms
 *  depending on whether it came from a style override or a stylesheet
 *  fallback. */
function toHex6(value) {
  const v = (value || "").trim();
  if (!v) return null;
  const pair = (n) => n.toString(16).padStart(2, "0");
  const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) {
    const c = m.slice(1, 4).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
    return `#${pair(c[0])}${pair(c[1])}${pair(c[2])}`;
  }
  if (v[0] !== "#") return null;
  const h = v.slice(1);
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
  return null;
}

/** Point the native text-selection tint at the colour CodeMirror paints
 *  its own selection with.
 *
 *  iPadOS draws a ranged selection twice — CodeMirror's `drawSelection()`
 *  layer and UIKit's native selection view — and the native one is a
 *  system-drawn overlay that `::selection` can't reach, so it shows
 *  through as a grey rectangle slightly out of register with the styled
 *  one. `tintColor` is the only lever the platform gives us; setting it
 *  to the same colour makes the pair read as one selection.
 *
 *  Reads the live `--selection` custom property rather than re-deriving
 *  it, so it always matches what the CSS actually resolved. When no style
 *  sets one, `editor.css` falls back to a neutral grey and so do we — the
 *  point is that the two layers agree, not which colour wins. */
function pushNativeSelectionTint() {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--selection").trim();
  const color = toHex6(raw) || "#808080";
  if (color === _lastNativeTint) return;
  _lastNativeTint = color;
  void (async () => {
    try {
      const [{ invoke }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/window"),
      ]);
      await invoke("set_native_selection_tint", {
        label: getCurrentWindow().label,
        color,
      });
    } catch (_) { /* older binary, or a window mid-teardown */ }
  })();
}

/**
 * Re-assert the iOS chrome colours whenever the window's box changes.
 *
 * The existing mitigation for WKWebView's stale `var(--theme-bg)` chrome
 * runs on foreground transitions. A display change is the other trigger
 * and had no handler: plug a monitor into the iPad and the app comes back
 * black or transparent until something forces a re-layout — which is why
 * resizing the window "fixes" it. These are the events that fire when the
 * window's screen changes underneath it.
 *
 * Two writes per event, matching the visibility path: one now, one on the
 * next frame, because WKWebView's own layer restore can land after (and
 * clobber) a synchronous write. Coalesced so a Stage Manager resize drag
 * costs one pair at the end rather than one per frame.
 */
export function installIOSChromeRepaint(state) {
  if (typeof window === "undefined") return;
  let pending = null;
  const repaint = () => {
    // Checked per-event rather than once: `html.ios` is added during
    // boot, and this can be installed before that.
    if (!document.documentElement.classList.contains("ios")) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      updatePrivateBoxColor(state);
      requestAnimationFrame(() => updatePrivateBoxColor(state));
    }, 120);
  };
  window.addEventListener("resize", repaint);
  window.addEventListener("orientationchange", repaint);
  window.visualViewport?.addEventListener("resize", repaint);
  window.addEventListener("pageshow", repaint);
  // A pixel-ratio change has no event of its own, but a media query on
  // the *current* ratio stops matching the moment it moves — re-armed
  // after each fire, that tracks it indefinitely. This is the one signal
  // that fires when the window is handed to a display of the same size
  // and a different scale.
  const watchRatio = () => {
    let mql;
    try { mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); }
    catch (_) { return; }
    const onChange = () => {
      mql.removeEventListener?.("change", onChange);
      repaint();
      watchRatio();
    };
    mql.addEventListener?.("change", onChange);
  };
  watchRatio();
}

export function applyFontFamily(family) {
  const value = fontFallbacks[family] || `'${family}', system-ui, sans-serif`;
  document.documentElement.style.setProperty("--font-family", value);
}
