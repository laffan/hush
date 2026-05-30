/**
 * Shared helpers for the styles panel and the style-edit modal. Lives in
 * its own file so style-modal.js can import these without creating a
 * circular import with styles-panel.js.
 */
import { getThemeById } from "../themes/index.js";

export function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Cursor mode constants + resolver shared by the editor modal and the
 *  preview pane. New `cursorMode` field wins; otherwise translate the
 *  legacy `blockCursor` boolean. */
export const CURSOR_MODES = ["system", "block", "underline"];
export function resolveCursorMode(draft, settings) {
  if (draft && draft.cursorMode) return draft.cursorMode;
  if (draft && draft.blockCursor === true) return "block";
  if (draft && draft.blockCursor === false) return "system";
  if (settings && settings.cursorMode) return settings.cursorMode;
  return settings && settings.blockCursor ? "block" : "system";
}
export function renderCursorOptions(active) {
  return CURSOR_MODES.map(v => `<option value="${v}"${active === v ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("");
}
/** Apply a cursor mode to the preview pane caret element. Mirrors the
 *  editor's `.block-cursor` / `.underline-cursor` CSS — the underline
 *  variant draws as a border-bottom on a full-height inline-block so
 *  the strip sits below the descenders instead of overlapping them. */
export function applyPreviewCursorMode(el, mode, accent, cursor) {
  Object.assign(el.style, { borderLeft: "", borderBottom: "", background: "", opacity: "", width: "", height: "", verticalAlign: "" });
  if (mode === "block") Object.assign(el.style, { background: accent, opacity: "0.55", width: "0.6em" });
  else if (mode === "underline") Object.assign(el.style, { borderBottom: `3px solid ${accent}`, background: "transparent", opacity: "0.7", width: "0.6em" });
  else Object.assign(el.style, { borderLeft: `2px solid ${cursor}`, width: "0" });
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
  akariNight: "#171b22", auroraBorealis: "#eceff4", aurumDusk: "#1a1614",
  calmDark: "#191f22", darkGreenJungle: "#18211e", eyeComfortDarkPro: "#1e1e1e",
  ghibliForestDark: "#1e2a24", mapleLight: "#fffffe", midnightFrost: "#011627",
  midnightGlow: "#27273a", nuttyLight: "#fffef9", pokemonColor: "#2b2b2b",
  softContrast: "#f5f3ee", solsticeEstival: "#f0eee7",
};

export const themeForegrounds = {
  dracula: "#f8f8f2", ayuLight: "#5c6166", clouds: "#000000",
  noctisLilac: "#4a4a6a", rosePineDawn: "#575279", solarizedLight: "#657b83",
  smoothy: "#333333", amy: "#d0d0ff", barf: "#d4d4d4", bespin: "#baae9e",
  birdsOfParadise: "#e6e1c4", boysAndGirls: "#e0e0e0", cobalt: "#e1efff",
  coolGlow: "#aebbc5", espresso: "#535353", tomorrow: "#4d4d4c",
  akariNight: "#e6ded3", auroraBorealis: "#2e3440", aurumDusk: "#f2e8dc",
  calmDark: "#e6e2d9", darkGreenJungle: "#d4d4d4", eyeComfortDarkPro: "#d4d4d4",
  ghibliForestDark: "#e8dfd0", mapleLight: "#475569", midnightFrost: "#a7dbf7",
  midnightGlow: "#fcf6ff", nuttyLight: "#2a1f16", pokemonColor: "#eeffff",
  softContrast: "#2b2b2b", solsticeEstival: "#1b3c3c",
};
