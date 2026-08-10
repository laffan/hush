/**
 * Registry of WebGL2 background effects. These are the WebGL2 entries
 * that used to live in the Post Processing overlay's SHADER_LAYERS
 * registry — moved here when WebGL effects became background *layers*
 * (Post Processing keeps the CSS-family overlays). The module files
 * themselves still live under shader-layer/layers/ and are loaded
 * lazily, exactly as before; only the registry entry moved.
 *
 * Kept separate from index.js so the modal (which renders the knobs
 * from `settings`) and the per-layer mount code can both import it
 * without pulling in the whole runtime.
 */

export const WEBGL_BG_EFFECTS = [
  {
    id: "webgl-neon-bloom",
    name: "Neon Bloom",
    load: () => import("../shader-layer/layers/webgl-neon-bloom.js"),
    settings: [
      { id: "brightness", label: "Bloom brightness", type: "range", min: 0, max: 1, step: 0.01, default: 0.55 },
      { id: "blobSize", label: "Blob size", type: "range", min: 0.5, max: 3, step: 0.05, default: 1 },
      { id: "speed", label: "Drift speed", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: "color1", label: "Bloom color 1", type: "color", default: "#f334a6" },
      { id: "color2", label: "Bloom color 2", type: "color", default: "#34c4f4" },
      { id: "color3", label: "Bloom color 3", type: "color", default: "#8c4ce8" },
    ],
  },
];

// Presets for the caret layer — effects that follow the text cursor.
// The shader implementations live in caret-effects.js (lazily loaded
// with the runtime); this list is here so the modal can render the
// preset picker without pulling that code in.
export const CARET_PRESETS = [
  { id: "sparks", name: "Sparks" },
  { id: "bubbles", name: "Bubbles" },
  { id: "ripples", name: "Ripples" },
];

// Seed nodes for a fresh gradient layer — three dark-friendly colours
// spread into a triangle so the mesh reads immediately.
export function defaultGradientNodes() {
  return [
    { x: 0.2, y: 0.25, color: "#3a2f68" },
    { x: 0.8, y: 0.3, color: "#1c4b57" },
    { x: 0.5, y: 0.85, color: "#5c2a4a" },
  ];
}

export function findEffect(effectId) {
  return WEBGL_BG_EFFECTS.find(e => e.id === effectId) || null;
}

/** Defaults from the registry overlaid by user-supplied values. */
export function resolveEffectOptions(effectId, userOptions) {
  const reg = findEffect(effectId);
  if (!reg) return {};
  const out = {};
  for (const s of (reg.settings || [])) {
    out[s.id] = (userOptions && s.id in userOptions) ? userOptions[s.id] : s.default;
  }
  return out;
}
