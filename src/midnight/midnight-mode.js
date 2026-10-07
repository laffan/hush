/**
 * Midnight mode — the model. Pure readers, no app imports, so every
 * colour resolver (themes, the style pipeline, panes, the cursor, the
 * notebook canvas) can consult it without an import cycle.
 *
 * It lives in `settings.midnightUntil` (`midnight_until` on the Rust
 * `AppSettings`): the epoch ms at which it switches itself off, which is
 * the first 8am after it was turned on. Settings are shared by every
 * window, so one toggle covers them all; Rust clears the field at launch,
 * so quitting the app ends it too. Holding the end moment rather than a
 * flag is what lets a window that wakes after 8am — a laptop opened in
 * the morning — see that it has already ended without anyone having to
 * have been awake to switch it off.
 *
 * While it is on, the appearance is dark whatever the setting says, and
 * every surface paints the same two colours over whatever the style or
 * desk would have chosen: pure black behind, and a grey 70% of the way
 * from black to white in front. Fonts, sizes and layout stay the style's.
 */

export const MIDNIGHT_BG = "#000000";
/** 70% of the way from black to white (0.7 × 255 ≈ 179). */
export const MIDNIGHT_FG = "#b3b3b3";
/** The selection wash — the text grey, faint enough to read through. */
export const MIDNIGHT_SELECTION = "rgba(179, 179, 179, 0.24)";

/** The hour (local time) at which midnight mode switches itself off. */
export const MIDNIGHT_END_HOUR = 8;

/** A style colour map (the shape of a style's `darkColors`) with every
 *  colour a surface paints from set to the midnight pair. Headings,
 *  links, the caret and the line indicator all take the text grey, so
 *  nothing on the page is brighter or more saturated than the words. */
export const MIDNIGHT_COLORS = Object.freeze({
  bg: MIDNIGHT_BG,
  fg: MIDNIGHT_FG,
  cursor: MIDNIGHT_FG,
  header: MIDNIGHT_FG,
  links: MIDNIGHT_FG,
  selection: MIDNIGHT_SELECTION,
  lineIndicator: MIDNIGHT_FG,
});

/** Is midnight mode on for these settings at `now`? An end moment in the
 *  past reads as off, so an expired value left in settings (a window that
 *  slept through 8am) is never mistaken for an active one. */
export function isMidnightActive(settings, now = Date.now()) {
  const until = settings?.midnightUntil;
  return typeof until === "number" && Number.isFinite(until) && until > now;
}

/** The appearance *setting* the colour chain should read: "dark" while
 *  midnight mode is on, else the user's own (`light` / `dark` / `auto`,
 *  or undefined — callers keep their own fallback). Stands in for every
 *  read of `settings.appearance` that decides what gets painted; the
 *  places that show the user's choice back to them (the palette's ✓, the
 *  style editor's toggle) keep reading the setting itself. */
export function effectiveAppearanceSetting(settings) {
  return isMidnightActive(settings) ? "dark" : settings?.appearance;
}

/** The first `MIDNIGHT_END_HOUR`:00 strictly after `from`, local time —
 *  later today when turned on before 8am, else tomorrow morning. */
export function nextMidnightEnd(from = Date.now()) {
  const d = new Date(from);
  d.setHours(MIDNIGHT_END_HOUR, 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
