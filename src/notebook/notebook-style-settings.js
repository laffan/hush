/**
 * Hush style → NotesCanvas settings derivation — extracted from
 * notebook-bridge.js (700-line cap). Pure functions over AppState:
 * theme mapping, appearance resolution, style colour/background/image
 * overrides. Consumed by the bridge's applyNotebookSettings and by
 * notebook panes adopting the same style.
 */

import { resolveBackgroundLayersList } from "../sidebar/styles-panel-shared.js";

// Map Hush camelCase theme IDs to notebook kebab-case IDs.
// Keys that are identical (amy, barf, bespin, cobalt, dracula, clouds) are
// still listed for clarity.
const HUSH_TO_NOTEBOOK_THEME = {
  ayuLight: "ayu-light",
  clouds: "clouds",
  noctisLilac: "noctis-lilac",
  rosePineDawn: "rose-pine-dawn",
  solarizedLight: "solarized-light",
  smoothy: "default",          // no Smoothy in notebook — fall back
  amy: "amy",
  barf: "barf",
  bespin: "bespin",
  birdsOfParadise: "birds-of-paradise",
  boysAndGirls: "boys-and-girls",
  cobalt: "cobalt",
  coolGlow: "cool-glow",
  dracula: "dracula",
  espresso: "espresso",
  tomorrow: "tomorrow",
};

/**
 * Resolve the notebook theme ID from the current Hush style settings.
 * Uses the active Hush theme (respecting appearance + styles) and maps
 * it to the corresponding notebook canvas theme.
 */
export function resolveNotebookTheme(state) {
  const s = state.settings;

  // Determine effective appearance
  let appearance = s.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // Check if an active style overrides the theme
  let hushThemeId = appearance === "dark" ? s.darkTheme : s.lightTheme;
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find(st => st.id === s.activeStyleId);
    if (style) {
      if (style.lightThemeId || style.darkThemeId) {
        const resolved = appearance === "dark" ? style.darkThemeId : style.lightThemeId;
        if (resolved) hushThemeId = resolved;
      } else if (style.themeId) {
        hushThemeId = style.themeId;
      }
    }
  }

  return HUSH_TO_NOTEBOOK_THEME[hushThemeId] || "default";
}

/**
 * Compute the NotesCanvas settings bundle derived from the current Hush
 * editor style. Exported so notebook panes can adopt the same style.
 * When `lockedStyleId` is provided, the pane's notebook uses that style
 * instead of whichever style is currently session-active.
 */
export function computeNotebookSettings(state, lockedStyleId) {
  let s = state.settings;
  if (lockedStyleId) {
    if (lockedStyleId === "__default__") {
      s = { ...s, activeStyleId: null };
    } else if ((s.styles || []).some(st => st.id === lockedStyleId)) {
      s = { ...s, activeStyleId: lockedStyleId };
    }
  }

  // Derive appearance from Hush settings
  let appearance = s.appearance || "dark";
  if (appearance === "auto") {
    appearance = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // Font: use active style font if set, otherwise editor default
  let fontFamily = s.fontFamily || "Inter";
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find(st => st.id === s.activeStyleId);
    if (style?.fontFamily) fontFamily = style.fontFamily;
  }

  const overrideState = s === state.settings ? state : { ...state, settings: s };

  // Style background override — when the active style has a `bg` set,
  // pipe it through so the canvas paints the user-chosen background
  // instead of the resolved notebook theme's stock canvasBackground.
  // Empty string = no override. The Default style's `bg` lives on
  // AppSettings.defaultLight/DarkColors instead of a style entry, so
  // handle that branch explicitly.
  let canvasBackgroundOverride = "";
  let bgColors = null;
  let styleBackgroundImage = null;
  if (s.activeStyleId && s.styles) {
    const style = s.styles.find((st) => st.id === s.activeStyleId);
    if (style) {
      bgColors = appearance === "dark" ? style.darkColors : style.lightColors;
      // Styles carry background *layers* now; the canvas paints the
      // first enabled image layer (gradient / webgl layers are
      // editor-surface-only). Legacy styles' single backgroundImage
      // resolves through the same helper.
      const layers = resolveBackgroundLayersList(style);
      styleBackgroundImage = layers.find((l) => l.type === "image" && l.enabled !== false && l.src) || null;
    }
  } else {
    bgColors = appearance === "dark" ? s.defaultDarkColors : s.defaultLightColors;
  }
  // Resolve the background image's per-appearance opacity + invert so the
  // canvas matches the editor. Light/dark each carry their own opacity and
  // invert flag; the legacy single `opacity` is the fallback for both.
  let resolvedBackgroundImage = null;
  if (styleBackgroundImage && styleBackgroundImage.src) {
    const isDark = appearance === "dark";
    const legacy = styleBackgroundImage.opacity != null ? styleBackgroundImage.opacity : 1;
    const opacity = isDark
      ? (styleBackgroundImage.darkOpacity != null ? styleBackgroundImage.darkOpacity : legacy)
      : (styleBackgroundImage.lightOpacity != null ? styleBackgroundImage.lightOpacity : legacy);
    const invert = isDark ? !!styleBackgroundImage.darkInvert : !!styleBackgroundImage.lightInvert;
    resolvedBackgroundImage = { ...styleBackgroundImage, opacity, invert };
  }
  if (bgColors?.bg) canvasBackgroundOverride = bgColors.bg;
  // Foreground override — same source as the bg override. Lets default /
  // auto-coloured text shapes and the toolbar icons follow the style's
  // text colour instead of the notebook theme's stock foreground.
  const foregroundOverride = bgColors?.fg || "";
  // Header override — markdown headings inside text shapes track it.
  const headingColorOverride = bgColors?.header || "";
  // Link override — text-shape links track it; defaults to the text colour.
  const linkColorOverride = bgColors?.links || "";

  return {
    appearanceMode: appearance,
    themeId: resolveNotebookTheme(overrideState),
    backgroundPattern: s.notebookBackgroundPattern || "dot-grid",
    gridSpacing: s.notebookGridSpacing || 25,
    gridOpacity: s.notebookGridOpacity != null ? s.notebookGridOpacity : 0.20,
    fontFamily,
    fontSize: s.notebookFontSize || 16,
    canvasBackgroundOverride,
    backgroundImage: resolvedBackgroundImage,
    foregroundOverride,
    headingColorOverride,
    linkColorOverride,
    maxTextWidth: s.notebookTextMaxWidth || 350,
    flowConnectMode: s.flowConnectMode === "horizontal" ? "horizontal" : "closest",
  };
}

