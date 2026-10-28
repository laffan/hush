/**
 * Campfire Cursor — its options, as stored, and whether it can be on.
 *
 * The options are app-wide (`settings.campfire`, opaque to the backend);
 * whether the campfire is lit is per window and never stored, as with
 * Edge Lights.
 *
 *   baseOpacity   how much of the text shows away from the light (2%)
 *   followCursor  the light goes out and comes back with the caret's
 *                 blink or pulse
 *   brightness    how strongly the light shows the text near it: at 1
 *                 the text at its centre is fully lit; above 1 the fully
 *                 lit middle widens, below 1 even the middle stays dim
 *   range         how far the light reaches, in lines
 *   currentLine   only the caret's line is lit
 */
import { resolveCursorPaint } from "../editor/block-cursor.js";

export const LIMITS = {
  baseOpacity: [0, 0.5],
  brightness: [0.2, 2],
  range: [1, 12],
};

export const DEFAULTS = Object.freeze({
  baseOpacity: 0.02,
  followCursor: true,
  brightness: 1,
  range: 4,
  currentLine: false,
});

const clamp = (v, [lo, hi], d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** The stored options, every field checked and filled in. */
export function readCampfireOptions(settings) {
  const raw = settings?.campfire && typeof settings.campfire === "object" ? settings.campfire : {};
  return {
    baseOpacity: clamp(raw.baseOpacity, LIMITS.baseOpacity, DEFAULTS.baseOpacity),
    followCursor: typeof raw.followCursor === "boolean" ? raw.followCursor : DEFAULTS.followCursor,
    brightness: clamp(raw.brightness, LIMITS.brightness, DEFAULTS.brightness),
    range: clamp(raw.range, LIMITS.range, DEFAULTS.range),
    currentLine: typeof raw.currentLine === "boolean" ? raw.currentLine : DEFAULTS.currentLine,
  };
}

export function saveCampfireOptions(state, options) {
  return state.updateSettings({ campfire: readCampfireOptions({ campfire: options }) });
}

export function isCampfireOn(state) {
  return !!state.runtime?.campfire;
}

/** The campfire needs a caret Hush draws itself — Block, Underline or
 *  Thick Line — since the light is that caret's glow. */
export function campfireAvailable(settings) {
  return resolveCursorPaint(settings).mode !== "system";
}
