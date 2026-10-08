/**
 * Wall clock — the model. It lives in `settings.clock` (opaque to Rust —
 * see `clock` on `AppSettings`):
 *
 *   { visible: boolean, x: number | null, y: number | null, vw?, vh?, alarmAt: number | null }
 *
 * Settings are app-wide rather than per desk, so the clock stays on — and
 * where it was dragged to — across a desk switch, and every window reads
 * the same one. `x` / `y` are its top-left in viewport px; null leaves it
 * in its default corner. `vw` / `vh` are the size of the window it was
 * put down in, which keeps it in its corner of a window of another size
 * (ui/keep-on-screen.js).
 *
 * `alarmAt` is an absolute time: the next moment the minute hand reaches
 * the marker that was clicked. Holding the moment rather than the marker
 * is what lets a window that boots late, or wakes from being throttled,
 * tell an alarm still to come from one that has already gone by.
 */

const MINUTE = 60 * 1000;

/** How long before the alarm the clock's lines turn red. */
export const ALARM_LEAD_MS = 5 * MINUTE;

/** An alarm that fell due longer ago than this went by unseen (the app
 *  was closed, the window asleep, the clock switched off); it is cleared
 *  without blinking. */
export const ALARM_STALE_MS = MINUTE;

export function getClock(state) {
  const c = state.settings?.clock;
  const o = c && typeof c === "object" ? c : {};
  return {
    visible: !!o.visible,
    x: Number.isFinite(o.x) ? o.x : null,
    y: Number.isFinite(o.y) ? o.y : null,
    vw: Number.isFinite(o.vw) ? o.vw : null,
    vh: Number.isFinite(o.vh) ? o.vh : null,
    alarmAt: Number.isFinite(o.alarmAt) ? o.alarmAt : null,
  };
}

function write(state, patch) {
  // Key-scoped patch (README-TECHNICAL: every settings write is).
  return state.updateSettings({ clock: { ...getClock(state), ...patch } });
}

export function toggleClock(state) {
  return write(state, { visible: !getClock(state).visible });
}

export function moveClock(state, x, y, size) {
  return write(state, { x, y, vw: size?.vw ?? null, vh: size?.vh ?? null });
}

/** One alarm at a time: setting one replaces any other; null clears it. */
export function setClockAlarm(state, alarmAt) {
  return write(state, { alarmAt });
}

/** The next moment the minute hand reaches `minute` (0–59) — strictly
 *  after `now`, so the marker it is passing this minute means the next
 *  hour's. */
export function nextMinuteMark(minute, now = Date.now()) {
  const d = new Date(now);
  d.setMinutes(minute, 0, 0);
  if (d.getTime() <= now) d.setTime(d.getTime() + 60 * MINUTE);
  return d.getTime();
}
