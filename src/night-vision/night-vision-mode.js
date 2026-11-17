/**
 * Night Vision — the model. Pure readers, no app imports (beyond
 * midnight mode's own pure model), so the colour code and the Settings
 * window can consult it without an import cycle.
 *
 * Night Vision takes every bit of blue — and green — light off the
 * screen, for working in the dark without losing dark adaptation: the
 * rods that do night vision are nearly blind to deep red, so a screen
 * drawn only in red leaves them adapted. Everything is drawn in shades
 * of pure red: each pixel's brightness (its luminance, the weights CSS's
 * `grayscale()` uses) goes to the red channel, and green and blue are
 * zero. It is not an appearance and touches no colour setting: it lies
 * over whatever is on screen — Light, Dark, a style, Midnight mode — so
 * Midnight's black and grey come out black and red.
 *
 * It lives in `settings.nightVisionUntil` (`night_vision_until` on the
 * Rust `AppSettings`), the same shape as Midnight mode's field: the
 * epoch ms at which it switches itself off, the first 8am after it was
 * turned on. Settings are shared, so every window is in it at once, and
 * Rust clears the field at launch, so quitting the app ends it too.
 */
import { nextMidnightEnd } from "../midnight/midnight-mode.js";

/** Is Night Vision on for these settings at `now`? An end moment in the
 *  past reads as off, as Midnight mode's does. */
export function isNightVisionActive(settings, now = Date.now()) {
  const until = settings?.nightVisionUntil;
  return typeof until === "number" && Number.isFinite(until) && until > now;
}

/** When Night Vision turned on now ends: the next 8am, Midnight mode's
 *  end — the two are for the same night. */
export function nextNightVisionEnd(from = Date.now()) {
  return nextMidnightEnd(from);
}

/** A colour as Night Vision shows it: its luminance (Rec. 709 weights on
 *  the encoded values, as CSS `grayscale(1)` computes it) in the red
 *  channel, green and blue zero. For the colours painted natively under
 *  the page (iOS), which the layers over the page can't reach. `#rgb` or
 *  `#rrggbb`; anything else comes back unchanged. */
export function nightVisionHex(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const y = Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
  return `#${y.toString(16).padStart(2, "0")}0000`;
}
