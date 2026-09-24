/**
 * Cursor options a style carries beside its mode: blinking, and the glow
 * split per appearance with a size ("intensity") of its own.
 *
 * Pure readers, shared by the editor painter (`block-cursor.js`), the
 * style modal and its preview, so the fallbacks can't drift between
 * what the modal shows and what the editor draws.
 *
 * `obj` is anything that carries the fields: a style, a style-modal
 * draft, or `AppSettings` (the Default style keeps them top-level).
 */

export const GLOW_INTENSITY_MIN = 0.25;
export const GLOW_INTENSITY_MAX = 4;
export const GLOW_INTENSITY_DEFAULT = 1;

/** Whether the glow is on for one appearance. `cursorGlowLight` /
 *  `cursorGlowDark` win; a style saved before the split carries only the
 *  single `cursorGlow`, which then stands for both — so an existing
 *  style keeps glowing exactly where it did. */
export function glowForAppearance(obj, appearance) {
  if (!obj) return false;
  const own = appearance === "light" ? obj.cursorGlowLight : obj.cursorGlowDark;
  if (own != null) return !!own;
  return !!obj.cursorGlow;
}

/** True when either appearance glows — the modal shows the glow's
 *  colour row and intensity slider only then. */
export function hasAnyGlow(obj) {
  return glowForAppearance(obj, "light") || glowForAppearance(obj, "dark");
}

/** Whether this object says anything about the glow at all. A style
 *  that says nothing inherits the Default style's settings. */
export function definesGlow(obj) {
  return !!obj && (obj.cursorGlow != null || obj.cursorGlowLight != null || obj.cursorGlowDark != null);
}

/** Shadow scale, clamped to the slider's range. 1 is the original
 *  3px core + 10px bloom. */
export function glowIntensity(obj) {
  const v = Number(obj?.cursorGlowIntensity);
  if (!Number.isFinite(v) || v <= 0) return GLOW_INTENSITY_DEFAULT;
  return Math.min(GLOW_INTENSITY_MAX, Math.max(GLOW_INTENSITY_MIN, v));
}

/** Absent means blinking — CodeMirror's default, and what every style
 *  saved before the switch existed did. */
export function cursorBlinks(obj) {
  return obj?.cursorBlink !== false;
}

/** The two box-shadows the glow is drawn with, at a given scale. Same
 *  pair as `.cursor-glow` in styles/editor.css (which scales them by
 *  `--cursor-glow-scale`): a tight bright core and a wide soft bloom. */
export function glowShadow(color, scale = GLOW_INTENSITY_DEFAULT) {
  const core = +(3 * scale).toFixed(2);
  const bloom = +(10 * scale).toFixed(2);
  return `0 0 ${core}px ${color}, 0 0 ${bloom}px ${color}`;
}
