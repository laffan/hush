/**
 * Edge Lights — the options and the palettes. Kept apart from the
 * renderer so the command palette and the modal can read them without
 * pulling the WebGL code in.
 *
 * The options are app-wide and remembered (`settings.edgeLights`,
 * opaque `serde_json::Value` on `AppSettings`): `{ kind, palette,
 * customColors, saturation, opacity, depth, speed }`. Whether the lights
 * are *on* is not: it is this window's, for this session
 * (`state.runtime.edgeLights`), the way a mode is — something begun,
 * not a preference. Named sets of options are presets
 * (`settings.edgeLightsPresets`, below).
 */

/** The skies the overlay can draw (edge-lights-shader.js): curtains
 *  of light, the same light seen through rippling water, or slow
 *  irregular patches of gradient. */
export const KINDS = [
  { id: "polar", name: "Polar" },
  { id: "scuba", name: "Scuba" },
  { id: "thrum", name: "Thrum" },
];

/** A palette is two to six colours. All but the last are spread along
 *  the edge as the light drifts; the last is the colour its far reach
 *  fades into. `custom` is the user's own list (`customColors`). */
export const MIN_COLORS = 2;
export const MAX_COLORS = 6;
export const PALETTES = [
  { id: "aurora", name: "Aurora", colors: ["#3dffa8", "#22d3c5", "#b48cff"] },
  { id: "glacier", name: "Glacier", colors: ["#7fe7ff", "#3b82f6", "#6d4aff"] },
  { id: "dawn", name: "Dawn", colors: ["#ffb36b", "#ff5fa2", "#a35cff"] },
  { id: "ember", name: "Ember", colors: ["#ffd166", "#ff6b35", "#e0245e"] },
  { id: "rose", name: "Rose", colors: ["#ff9ad5", "#ff6fb1", "#b388ff"] },
  { id: "borealis", name: "Borealis", colors: ["#4dff9a", "#2ee6d6", "#ff7ad9", "#9d6bff"] },
  { id: "twilight", name: "Twilight", colors: ["#ff8fb8", "#c77dff", "#7b6cff", "#3a4bd8"] },
  { id: "lagoon", name: "Lagoon", colors: ["#7dffe1", "#2ad4ff", "#3fa7ff", "#2f6bff", "#5b3dff"] },
  { id: "spectrum", name: "Spectrum", colors: ["#ff5f6d", "#ffc371", "#7dff8a", "#4dd9ff", "#8c7bff", "#d06bff"] },
  { id: "custom", name: "Custom", colors: null },
];

export const DEFAULT_CUSTOM_COLORS = ["#3dffa8", "#3dd5ff", "#ff7ad9"];

export const DEFAULT_OPTIONS = {
  kind: "polar",
  palette: "aurora",
  customColors: DEFAULT_CUSTOM_COLORS,
  // 0 is grey, 1 the palette as drawn, up to 1.5 for more vivid.
  saturation: 1,
  opacity: 0.5,
  // How far in from the edge the lights reach, as a share of the
  // window's shorter side.
  depth: 0.2,
  // A multiple of the overlay's own pace; 1 is how fast it first ran,
  // which was quicker than the lights should be.
  speed: 0.4,
};

export const LIMITS = {
  saturation: [0, 1.5],
  opacity: [0.05, 1],
  depth: [0.05, 0.5],
  speed: [0.05, 1.5],
};

const HEX = /^#[0-9a-f]{6}$/i;

function clampNum(v, [lo, hi], fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** The custom colours as stored, or — for options saved when Custom was
 *  a single colour (`custom`) — that colour spread into a palette. */
function readCustomColors(o) {
  if (Array.isArray(o.customColors)) {
    const list = o.customColors.filter((c) => HEX.test(c || "")).slice(0, MAX_COLORS);
    if (list.length >= MIN_COLORS) return list;
  }
  if (HEX.test(o.custom || "")) return spreadColor(o.custom);
  return [...DEFAULT_CUSTOM_COLORS];
}

/** The stored options, every key present and in range. */
export function readOptions(settings) {
  const raw = settings?.edgeLights;
  const o = raw && typeof raw === "object" ? raw : {};
  // "polar" was the Glacier palette's id before Polar became a kind.
  const palette = o.palette === "polar" ? "glacier" : o.palette;
  return {
    kind: KINDS.some((k) => k.id === o.kind) ? o.kind : DEFAULT_OPTIONS.kind,
    palette: PALETTES.some((p) => p.id === palette) ? palette : DEFAULT_OPTIONS.palette,
    customColors: readCustomColors(o),
    saturation: clampNum(o.saturation, LIMITS.saturation, DEFAULT_OPTIONS.saturation),
    opacity: clampNum(o.opacity, LIMITS.opacity, DEFAULT_OPTIONS.opacity),
    depth: clampNum(o.depth, LIMITS.depth, DEFAULT_OPTIONS.depth),
    speed: clampNum(o.speed, LIMITS.speed, DEFAULT_OPTIONS.speed),
  };
}

export function saveOptions(state, options) {
  return state.updateSettings({ edgeLights: { ...readOptions({ edgeLights: options }) } });
}

/** The colours `options` draws with. */
export function paletteColors(options) {
  const p = PALETTES.find((x) => x.id === options.palette);
  return p?.colors || options.customColors || DEFAULT_CUSTOM_COLORS;
}

/** The colour Custom's + adds: the last one turned a little round the
 *  hue wheel, so a new well starts as a neighbour rather than a copy. */
export function nextCustomColor(colors) {
  const hsl = hexToHsl(colors[colors.length - 1] || DEFAULT_CUSTOM_COLORS[0]);
  return hslToHex({ ...hsl, h: (hsl.h + 45) % 360 });
}

/** One colour spread into three: itself at the edge, a neighbour on one
 *  side of the hue wheel along it and one on the other side at its
 *  reach — what Custom drew with when it held a single colour. */
function spreadColor(hex) {
  const hsl = hexToHsl(hex);
  return [
    hslToHex(hsl),
    hslToHex({ ...hsl, h: (hsl.h + 35) % 360 }),
    hslToHex({ ...hsl, h: (hsl.h + 300) % 360, l: Math.max(0.35, hsl.l * 0.85) }),
  ];
}

/** Saved presets — `settings.edgeLightsPresets`, `[{ id, name, options,
 *  appearance }]`, app-wide like styles. `appearance` is `"light"` or
 *  `"dark"`: how the page looked when the preset was saved, since the
 *  same lights read very differently on each (missing on none saved
 *  before it was recorded). Each preset's options go through
 *  `readOptions` on the way out, so one saved by an older build still
 *  reads whole. */
export function readPresets(settings) {
  const raw = Array.isArray(settings?.edgeLightsPresets) ? settings.edgeLightsPresets : [];
  return raw
    .filter((p) => p && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      name: String(p.name || "").trim() || "Untitled",
      options: readOptions({ edgeLights: p.options }),
      appearance: p.appearance === "light" || p.appearance === "dark" ? p.appearance : null,
    }));
}

export function savePresets(state, presets) {
  return state.updateSettings({
    edgeLightsPresets: presets.map(({ id, name, options, appearance }) => ({ id, name, options, appearance: appearance || null })),
  });
}

/** Whether two option sets would draw the same lights — what marks a
 *  preset as the one in use. */
export function sameOptions(a, b) {
  return JSON.stringify(readOptions({ edgeLights: a })) === JSON.stringify(readOptions({ edgeLights: b }));
}

/** A name for the settings as they stand: their type and palette. */
export function describeOptions(options) {
  const kind = KINDS.find((k) => k.id === options.kind)?.name || "";
  const palette = PALETTES.find((p) => p.id === options.palette)?.name || "";
  return [kind, palette].filter(Boolean).join(" · ");
}

/** Whether the lights are on in this window. */
export function isEdgeLightsOn(state) {
  return !!state.runtime?.edgeLights;
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hslToHex({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
