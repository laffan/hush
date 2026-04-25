/**
 * Shared helpers for the styles panel and the style-edit modal. Lives in
 * its own file so style-modal.js can import these without creating a
 * circular import with styles-panel.js.
 */
import { getThemeById } from "../themes.js";

export function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Migrate old single-mode styles to dual light/dark format. */
export function migrateStyle(st) {
  if (!st._migrated && st.themeId && !st.lightThemeId && !st.darkThemeId) {
    const theme = getThemeById(st.themeId);
    if (theme) {
      if (theme.type === "dark") { st.darkThemeId = st.themeId; st.darkColors = st.colorOverrides || {}; }
      else { st.lightThemeId = st.themeId; st.lightColors = st.colorOverrides || {}; }
    }
    delete st.themeId;
    delete st.colorOverrides;
    st._migrated = true;
  }
  if (!st.lightThemeId) st.lightThemeId = "";
  if (!st.darkThemeId) st.darkThemeId = "";
  if (!st.lightColors) st.lightColors = {};
  if (!st.darkColors) st.darkColors = {};
  return st;
}

// ── theme color maps ───────────────────────────────────────────────────────────
export const themeBackgrounds = {
  dracula: "#2d2f3f", ayuLight: "#fcfcfc", clouds: "#ffffff",
  noctisLilac: "#f2f1f8", rosePineDawn: "#faf4ed", solarizedLight: "#fef7e5",
  smoothy: "#ffffff", amy: "#200020", barf: "#15191e", bespin: "#2e241d",
  birdsOfParadise: "#3b2627", boysAndGirls: "#000205", cobalt: "#00254b",
  coolGlow: "#060521", espresso: "#ffffff", tomorrow: "#ffffff",
};

export const themeForegrounds = {
  dracula: "#f8f8f2", ayuLight: "#5c6166", clouds: "#000000",
  noctisLilac: "#4a4a6a", rosePineDawn: "#575279", solarizedLight: "#657b83",
  smoothy: "#333333", amy: "#d0d0ff", barf: "#d4d4d4", bespin: "#baae9e",
  birdsOfParadise: "#e6e1c4", boysAndGirls: "#e0e0e0", cobalt: "#e1efff",
  coolGlow: "#aebbc5", espresso: "#535353", tomorrow: "#4d4d4c",
};
