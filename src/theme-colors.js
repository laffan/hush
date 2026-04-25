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

// Known theme background colors — must match thememirror's actual settings.background
export const themeBackgrounds = {
  dracula: "#2d2f3f", ayuLight: "#fcfcfc", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fef7e5",
  smoothy: "#ffffff", amy: "#200020", barf: "#15191e", bespin: "#2e241d",
  birdsOfParadise: "#3b2627", boysAndGirls: "#000205", cobalt: "#00254b",
  coolGlow: "#060521", espresso: "#ffffff", tomorrow: "#ffffff",
};

export function hexLuminance(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function updatePrivateBoxColor(state, overrideBg) {
  let bg = overrideBg || null;

  if (!bg) {
    if (state.settings.activeStyleId && state.settings.styles) {
      const style = state.settings.styles.find(s => s.id === state.settings.activeStyleId);
      if (style) {
        const { themeId, colors } = resolveStyleForAppearance(style, state.settings.appearance);
        bg = (colors && colors.bg) || themeBackgrounds[themeId] || (style.colorOverrides && style.colorOverrides.bg) || themeBackgrounds[style.themeId];
      }
    }

    if (!bg) {
      let appearance = state.settings.appearance || "dark";
      if (appearance === "auto") {
        appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      const themeId = appearance === "dark" ? state.settings.darkTheme : state.settings.lightTheme;
      bg = themeBackgrounds[themeId];
    }
  }

  if (!bg) {
    bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  }

  if (bg && bg.startsWith("#")) {
    const luminance = hexLuminance(bg);
    const isDark = luminance <= 0.5;
    const root = document.documentElement.style;

    root.setProperty("--private-box", isDark ? "#ffffff" : "#000000");
    root.setProperty("--theme-bg", bg);
    root.setProperty("--fg", isDark ? "#e0e0e0" : "#1a1a1a");
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
      const fg = isDark ? "#e0e0e0" : "#1a1a1a";
      const sidebar = document.getElementById("sidebar");
      if (sidebar) {
        sidebar.style.backgroundColor = bg;
        sidebar.style.color = fg;
      }
      const panel = document.getElementById("panel-overlay");
      if (panel) {
        panel.style.backgroundColor = bg;
        panel.style.color = fg;
      }
    }
  }
}

export function applyFontFamily(family) {
  const value = fontFallbacks[family] || `'${family}', system-ui, sans-serif`;
  document.documentElement.style.setProperty("--font-family", value);
}
