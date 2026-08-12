/**
 * Shared helpers for the styles panel and the style-edit modal. Lives in
 * its own file so style-modal.js can import these without creating a
 * circular import with styles-panel.js.
 */
import { getThemeById } from "../themes/index.js";
import { resolveCaretPreset } from "../background-layers/effects-registry.js";

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
  if (mode === "block") Object.assign(el.style, { background: accent, opacity: "0.85", width: "0.6em" });
  else if (mode === "underline") Object.assign(el.style, { borderBottom: `3px solid ${accent}`, background: "transparent", opacity: "0.7", width: "0.6em" });
  else Object.assign(el.style, { borderLeft: `2px solid ${cursor}`, width: "0" });
}

/**
 * Resolve a style's background-layer list, deriving one from the legacy
 * shapes when the style hasn't been re-saved since the Background
 * Layers editor shipped: the old single `backgroundImage` becomes an
 * image layer, and a WebGL2 `shaderLayer` (the one Post Processing
 * entry that moved into Background Layers) becomes a webgl layer.
 * Application code always reads through this, so un-migrated styles
 * keep rendering without being rewritten on disk.
 */
export function resolveBackgroundLayersList(style) {
  if (!style) return [];
  // The section-level Enable switch. Absent = on, so styles saved
  // before the switch existed keep their layers.
  if (style.backgroundLayersEnabled === false) return [];
  if (Array.isArray(style.backgroundLayers)) return normalizeLayers(style.backgroundLayers);
  const out = [];
  const bi = style.backgroundImage;
  if (bi && bi.src) {
    out.push({ ...bi, id: "legacy-image", type: "image", enabled: !!bi.enabled, blend: bi.blend || "normal" });
  }
  const sl = style.shaderLayer;
  if (sl && sl.layerId === "webgl-neon-bloom") {
    out.push({
      id: "legacy-webgl", type: "webgl", enabled: !!sl.enabled, blend: "screen",
      effectId: "webgl-neon-bloom",
      intensity: typeof sl.intensity === "number" ? sl.intensity : 0.5,
      options: sl.options || {},
    });
  }
  return out;
}

/**
 * Bring a saved layer list up to the current shape. Two conversions,
 * both applied on read so un-migrated styles render correctly without
 * being rewritten on disk:
 *
 *  - a WebGL layer still carrying the first-cut `caretEffect` knobs emits
 *    a caret layer directly above it;
 *  - every caret layer is normalized (see normalizeCaretLayer).
 */
function normalizeLayers(layers) {
  const out = [];
  for (const l of layers) {
    if (l && l.type === "webgl" && l.caretEffect && l.caretEffect !== "none") {
      const { caretEffect, caretColor, caretIntensity, ...webgl } = l;
      out.push(webgl);
      out.push(normalizeCaretLayer({
        id: l.id + "_caret", type: "caret", enabled: l.enabled !== false,
        blend: "screen", preset: caretEffect,
        color: caretColor || "#9ecbff",
        intensity: typeof caretIntensity === "number" ? caretIntensity : 0.6,
      }));
    } else if (l && l.type === "caret") {
      out.push(normalizeCaretLayer(l));
    } else {
      out.push(l);
    }
  }
  return out;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A caret layer in its current shape. Three things changed under it:
 *
 *  - Retired presets (HUD, Phosphor Blob, Ripples, Bubbles) resolve to a
 *    surviving one instead of failing to link a shader.
 *  - `intensity` — the effect's own brightness, which only ever
 *    multiplied the layer's opacity — folds into the per-appearance
 *    opacity pair, so the two controls that did the same job become one
 *    and an existing style renders at exactly the brightness it did.
 *  - The single `blend` splits per appearance. It seeds the dark side
 *    only: the stored value is almost always `screen`, which returns
 *    white when composited onto a light page, so light starts from
 *    `multiply` instead.
 */
export function normalizeCaretLayer(l) {
  const out = { ...l };
  out.preset = resolveCaretPreset(l.preset);
  if (typeof l.intensity === "number") {
    const legacy = l.opacity != null ? l.opacity : 1;
    out.lightOpacity = clamp01((l.lightOpacity != null ? l.lightOpacity : legacy) * l.intensity);
    out.darkOpacity = clamp01((l.darkOpacity != null ? l.darkOpacity : legacy) * l.intensity);
    delete out.intensity;
  }
  if (!out.darkBlend) out.darkBlend = l.blend || "screen";
  if (!out.lightBlend) out.lightBlend = "multiply";
  delete out.blend;
  return out;
}

/**
 * The style's Post Processing stack. Post processing used to be a single
 * picked overlay (`shaderLayer`) bundling two or three looks together;
 * it's a layer stack now, so a style that predates the change derives
 * one layer per look on the fly.
 */
export function resolvePostLayersList(style) {
  if (!style) return [];
  if (Array.isArray(style.postLayers)) {
    return style.postProcessingEnabled === false ? [] : style.postLayers;
  }
  const sl = style.shaderLayer;
  if (!sl || !sl.enabled) return [];
  return derivePostLayersFromShader(sl);
}

/** The per-look split of a legacy `shaderLayer`, ignoring its enabled
 *  flag — the caller owns that (see resolvePostLayersList / migrateStyle),
 *  or turning the section back on would find an empty stack. The old
 *  master intensity is baked into each knob it scaled, since the stack
 *  has no master. The WebGL2 entry isn't here: it became a *background*
 *  layer (see resolveBackgroundLayersList). */
export function derivePostLayersFromShader(sl) {
  if (!sl || !sl.layerId || sl.layerId === "webgl-neon-bloom") return [];
  const i = typeof sl.intensity === "number" ? sl.intensity : 0.5;
  const o = sl.options || {};
  const n = (v, d) => (typeof v === "number" && !Number.isNaN(v)) ? v : d;
  const scanlines = (opacity, spacing) => ({
    id: "post_legacy_scanlines", type: "scanlines", enabled: true, blend: "multiply",
    opacity: clamp01(opacity * i), spacing, color: o.scanlineColor || "#000000",
  });
  if (sl.layerId === "css-vignette-scanlines") {
    return [
      {
        id: "post_legacy_vignette", type: "vignette", enabled: true, blend: "multiply",
        strength: clamp01(n(o.vignetteStrength, 0.5) * i), spread: 0.45, color: "#000000",
      },
      scanlines(n(o.scanlineOpacity, 0.15), 2),
    ];
  }
  if (sl.layerId === "css-phosphor-scanlines") {
    return [
      {
        id: "post_legacy_glow", type: "glow", enabled: true, blend: "normal",
        glow: clamp01(n(o.glow, 0.4) * i), halo: clamp01(n(o.halo, 0.6) * i),
      },
      scanlines(n(o.scanlineOpacity, 0.2), 3),
    ];
  }
  return [];
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
  // Legacy single `lineIndicatorColor` is now stored per-appearance
  // alongside the other colour overrides. Promote it into both halves
  // so the existing pick lights up in either light or dark mode, then
  // drop the orphan field so it doesn't keep resurfacing in exports.
  if (st.lineIndicatorColor) {
    if (!st.lightColors.lineIndicator) st.lightColors.lineIndicator = st.lineIndicatorColor;
    if (!st.darkColors.lineIndicator) st.darkColors.lineIndicator = st.lineIndicatorColor;
    delete st.lineIndicatorColor;
  }
  // Legacy background image / WebGL2 post-processing → background layers.
  // Same derivation the application-side resolver performs, but baked
  // onto the style once it's opened for editing so the modal edits real
  // layer objects.
  if (!Array.isArray(st.backgroundLayers)) {
    // Read through the enable switch being off — the derivation must
    // see the legacy fields either way, or turning the section back on
    // would find an empty stack.
    const { backgroundLayersEnabled, ...forDerivation } = st;
    const derived = resolveBackgroundLayersList(forDerivation).map((l, i) => ({
      ...l,
      id: "layer_migrated_" + i,
    }));
    st.backgroundLayers = derived;
    delete st.backgroundImage;
    if (st.shaderLayer && st.shaderLayer.layerId === "webgl-neon-bloom") st.shaderLayer = null;
  } else {
    // Caret knobs on a WebGL layer become their own caret layer, and
    // caret layers pick up their current shape.
    st.backgroundLayers = normalizeLayers(st.backgroundLayers);
  }
  // Legacy single-overlay post processing → a post-processing layer
  // stack. Same derivation the application-side resolver performs,
  // baked on once the style is opened for editing.
  if (!Array.isArray(st.postLayers)) {
    st.postLayers = derivePostLayersFromShader(st.shaderLayer);
    if (st.postProcessingEnabled == null) {
      // Nothing to carry over → leave the section switched on with an
      // empty stack, so its add buttons are reachable. Something to
      // carry over → honour whether the old overlay was actually on.
      st.postProcessingEnabled = st.postLayers.length
        ? !!(st.shaderLayer && st.shaderLayer.enabled)
        : true;
    }
    // The WebGL2 entry is the one `shaderLayer` value that doesn't
    // describe post processing at all — it's a background layer, and
    // the block above owns retiring it.
    if (st.shaderLayer && st.shaderLayer.layerId !== "webgl-neon-bloom") st.shaderLayer = null;
  }
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
