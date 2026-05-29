/**
 * Theme color helpers — extracted from main.js.
 * Manages --private-box, --theme-bg, --fg, and other CSS vars
 * derived from the active theme or style.
 */
import { resolveStyleForAppearance } from "./sidebar/styles-panel.js";

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

export function updatePrivateBoxColor(state, overrideBg, overrideFg) {
  let bg = overrideBg || null;
  // Resolve the active style/theme's foreground in parallel with the bg
  // so the UI chrome can match the editor text colour. `overrideFg` lets
  // a caller (e.g. a style hover-preview) force a specific value.
  let fg = overrideFg || null;

  if (!bg || !fg) {
    if (state.settings.activeStyleId && state.settings.styles) {
      const style = state.settings.styles.find(s => s.id === state.settings.activeStyleId);
      if (style) {
        const { themeId, colors } = resolveStyleForAppearance(style, state.settings.appearance);
        if (!bg) bg = (colors && colors.bg) || themeBackgrounds[themeId] || (style.colorOverrides && style.colorOverrides.bg) || themeBackgrounds[style.themeId];
        if (!fg) fg = (colors && colors.fg) || themeForegrounds[themeId] || (style.colorOverrides && style.colorOverrides.fg) || themeForegrounds[style.themeId];
      }
    }

    if (!bg || !fg) {
      let appearance = state.settings.appearance || "dark";
      if (appearance === "auto") {
        appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      const themeId = appearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme;
      if (!bg) bg = themeBackgrounds[themeId];
      if (!fg) fg = themeForegrounds[themeId];
    }
  }

  if (!bg) {
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
    root.setProperty("--cursor", isDark ? "#e0e0e0" : "#1a1a1a");
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
    // We also nudge the sidebar + panel-overlay directly because in
    // production iOS WebView builds the sidebar's
    // `background: var(--theme-bg)` reads stale on first paint and never
    // refreshes — the explicit inline style brings it back into sync
    // with the active theme. The text colour gets the same treatment
    // so the icon column's foreground tracks light/dark switches.
    if (document.documentElement.classList.contains("ios")) {
      document.documentElement.style.backgroundColor = bg;
      document.body.style.backgroundColor = bg;
      const panel = document.getElementById("panel-overlay");
      if (panel) {
        panel.style.backgroundColor = bg;
        panel.style.color = uiFg;
      }
    }
  }
}

export function applyFontFamily(family) {
  const value = fontFallbacks[family] || `'${family}', system-ui, sans-serif`;
  document.documentElement.style.setProperty("--font-family", value);
}
