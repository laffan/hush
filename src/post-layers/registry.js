/**
 * Registry of post-processing effects — the layer types a style can
 * stack over the whole window.
 *
 * Post processing used to be a single picked "shader layer" with one
 * bundled look per entry (vignette+scanlines, phosphor glow+scanlines).
 * Those bundles are split here into one effect per concern so a style
 * can mix and match, in whatever order, exactly like Background layers.
 *
 * Kept in its own module (no runtime imports) so the style modal can
 * render the knobs from `settings` without pulling in the effect code.
 *
 * Each effect: `{ id, name, blend, blendable, hint?, settings[] }`.
 * `blend` is the default mix-blend-mode for a fresh layer of that type;
 * `blendable` is false for the effects that paint nothing of their own
 * (they filter their backdrop, or reach out to the text), where a blend
 * mode would be an inert control. Setting shape:
 * `{ id, label, type: "range" | "color", min?, max?, step?, unit?, default }`.
 */

export const POST_EFFECTS = [
  {
    id: "vignette",
    name: "Vignette",
    blend: "multiply",
    blendable: true,
    settings: [
      { id: "strength", label: "Darkness", type: "range", min: 0, max: 1, step: 0.01, default: 0.5 },
      { id: "spread", label: "Spread", type: "range", min: 0, max: 1, step: 0.01, default: 0.45 },
      { id: "color", label: "Color", type: "color", default: "#000000" },
    ],
  },
  {
    id: "glow",
    name: "Glow",
    blend: "normal",
    blendable: false,
    hint: "Puts a phosphor halo on the text itself, not on an overlay.",
    settings: [
      { id: "glow", label: "Text glow (sharp)", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { id: "halo", label: "Text halo (soft)", type: "range", min: 0, max: 1, step: 0.01, default: 0.6 },
    ],
  },
  {
    id: "scanlines",
    name: "Scan Lines",
    blend: "multiply",
    blendable: true,
    settings: [
      { id: "opacity", label: "Line opacity", type: "range", min: 0, max: 1, step: 0.01, default: 0.15 },
      { id: "spacing", label: "Line spacing", type: "range", min: 2, max: 10, step: 1, unit: "px", default: 2 },
      { id: "color", label: "Line color", type: "color", default: "#000000" },
    ],
  },
  {
    id: "opacity",
    name: "Window Opacity",
    blend: "normal",
    blendable: false,
    hint: "Fades the whole window, so whatever is behind Hush shows through.",
    settings: [
      { id: "amount", label: "Amount", type: "range", min: 0.1, max: 1, step: 0.01, default: 0.9 },
    ],
  },
  {
    id: "tint",
    name: "Tint",
    blend: "color",
    blendable: true,
    settings: [
      { id: "color", label: "Tint color", type: "color", default: "#f0a860" },
      { id: "amount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, default: 0.35 },
    ],
  },
  {
    id: "grayscale",
    name: "Grayscale",
    blend: "normal",
    blendable: false,
    settings: [
      { id: "amount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, default: 1 },
    ],
  },
  {
    id: "sepia",
    name: "Sepia",
    blend: "normal",
    blendable: false,
    settings: [
      { id: "amount", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, default: 1 },
    ],
  },
];

export function findPostEffect(type) {
  return POST_EFFECTS.find(e => e.id === type) || null;
}

/** Defaults from the registry overlaid by the layer's own values. Every
 *  knob lives flat on the layer object (not in a nested `options` bag) so
 *  a post layer reads like a background layer. */
export function resolvePostOptions(layer) {
  const reg = findPostEffect(layer && layer.type);
  const out = {};
  if (!reg) return out;
  for (const s of reg.settings) {
    out[s.id] = (layer && layer[s.id] != null) ? layer[s.id] : s.default;
  }
  return out;
}

/** A fresh layer of `type`, seeded with the registry defaults. */
export function defaultPostLayer(type, id) {
  const reg = findPostEffect(type);
  if (!reg) return null;
  const layer = { id, type, enabled: true, blend: reg.blend };
  for (const s of reg.settings) layer[s.id] = s.default;
  return layer;
}
