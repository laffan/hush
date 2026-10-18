/**
 * Northern Lights — the options and the palettes. Kept apart from the
 * renderer so the command palette and the modal can read them without
 * pulling the WebGL code in.
 *
 * The options are app-wide and remembered (`settings.northernLights`,
 * opaque `serde_json::Value` on `AppSettings`): `{ palette, custom,
 * saturation, opacity, depth }`. Whether the lights are *on* is not: it
 * is this window's, for this session (`state.runtime.northernLights`),
 * the way a mode is — something begun, not a preference.
 */

/** Three colours a palette is drawn from: the glow nearest the edge, the
 *  one it shifts to along the edge, and the one its far reach fades
 *  into. `custom` is built from the user's colour instead. */
export const PALETTES = [
  { id: "aurora", name: "Aurora", colors: ["#3dffa8", "#22d3c5", "#b48cff"] },
  { id: "polar", name: "Polar", colors: ["#7fe7ff", "#3b82f6", "#6d4aff"] },
  { id: "dawn", name: "Dawn", colors: ["#ffb36b", "#ff5fa2", "#a35cff"] },
  { id: "ember", name: "Ember", colors: ["#ffd166", "#ff6b35", "#e0245e"] },
  { id: "rose", name: "Rose", colors: ["#ff9ad5", "#ff6fb1", "#b388ff"] },
  { id: "custom", name: "Custom", colors: null },
];

export const DEFAULT_OPTIONS = {
  palette: "aurora",
  custom: "#3dffa8",
  // 0 is grey, 1 the palette as drawn, up to 1.5 for more vivid.
  saturation: 1,
  opacity: 0.5,
  // How far in from the edge the lights reach, as a share of the
  // window's shorter side.
  depth: 0.2,
};

export const LIMITS = {
  saturation: [0, 1.5],
  opacity: [0.05, 1],
  depth: [0.05, 0.5],
};

function clampNum(v, [lo, hi], fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** The stored options, every key present and in range. */
export function readOptions(settings) {
  const raw = settings?.northernLights;
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    palette: PALETTES.some((p) => p.id === o.palette) ? o.palette : DEFAULT_OPTIONS.palette,
    custom: /^#[0-9a-f]{6}$/i.test(o.custom || "") ? o.custom : DEFAULT_OPTIONS.custom,
    saturation: clampNum(o.saturation, LIMITS.saturation, DEFAULT_OPTIONS.saturation),
    opacity: clampNum(o.opacity, LIMITS.opacity, DEFAULT_OPTIONS.opacity),
    depth: clampNum(o.depth, LIMITS.depth, DEFAULT_OPTIONS.depth),
  };
}

export function saveOptions(state, options) {
  return state.updateSettings({ northernLights: { ...readOptions({ northernLights: options }) } });
}

/** The three colours `options` draws with. A custom colour is spread
 *  into a palette of its own: itself at the edge, a neighbour on one
 *  side of the hue wheel along it and one on the other side at its reach,
 *  so it still shifts the way the stock palettes do. */
export function paletteColors(options) {
  const p = PALETTES.find((x) => x.id === options.palette);
  if (p?.colors) return p.colors;
  const hsl = hexToHsl(options.custom || DEFAULT_OPTIONS.custom);
  return [
    hslToHex(hsl),
    hslToHex({ ...hsl, h: (hsl.h + 35) % 360 }),
    hslToHex({ ...hsl, h: (hsl.h + 300) % 360, l: Math.max(0.35, hsl.l * 0.85) }),
  ];
}

/** Whether the lights are on in this window. */
export function isNorthernLightsOn(state) {
  return !!state.runtime?.northernLights;
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
