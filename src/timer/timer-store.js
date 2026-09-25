/**
 * Focus timer — the model. One timer at a time, shared by every desk
 * (and every window: it lives in `settings.timer`, opaque to Rust — see
 * `timer` on `AppSettings`):
 *
 *   { active: { task, startedAt, durationMs, breakEveryMs } | null,
 *     last:   { hours, minutes, breakEvery } }
 *
 * `active` holds absolute times, so a timer keeps running while the app
 * is closed and every window reads the same clock. `last` is what the
 * Start timer sheet opens on next time.
 *
 * Breaks are moments, not intervals: every `breakEveryMs` from the start,
 * stopping short of the finish. The countdown never pauses for them.
 */

const MINUTE = 60 * 1000;

/** Break frequencies the sheet offers, in minutes (0 = no breaks). */
export const BREAK_CHOICES = [0, 25, 30, 45, 60, 90];

export const DEFAULT_LAST = { hours: 1, minutes: 0, breakEvery: 25 };

function read(state) {
  const t = state.settings?.timer;
  return t && typeof t === "object" ? t : {};
}

function isValidTimer(t) {
  return !!t && typeof t === "object"
    && Number.isFinite(t.startedAt) && Number.isFinite(t.durationMs) && t.durationMs > 0;
}

/** The timer, running or finished, or null when there is none. */
export function getTimer(state) {
  const t = read(state).active;
  return isValidTimer(t) ? t : null;
}

export function lastValues(state) {
  const l = read(state).last;
  return { ...DEFAULT_LAST, ...(l && typeof l === "object" ? l : {}) };
}

export function isTimerRunning(state, now = Date.now()) {
  const t = getTimer(state);
  return !!t && now < t.startedAt + t.durationMs;
}

function write(state, patch) {
  const next = { ...read(state), ...patch };
  // Key-scoped patch (README-TECHNICAL: every settings write is).
  return state.updateSettings({ timer: next });
}

/** Start a timer, replacing any other (there is only ever one). */
export function startTimer(state, { task, hours, minutes, breakEvery }, now = Date.now()) {
  const durationMs = (hours * 60 + minutes) * MINUTE;
  return write(state, {
    active: { task: task.trim(), startedAt: now, durationMs, breakEveryMs: breakEvery * MINUTE },
    last: { hours, minutes, breakEvery },
  });
}

/** Change the task's wording; the clock is left exactly as it was. */
export function renameTimer(state, task) {
  const t = getTimer(state);
  if (!t) return Promise.resolve();
  return write(state, { active: { ...t, task: task.trim() } });
}

export function deleteTimer(state) {
  return write(state, { active: null });
}

/** Break moments (absolute ms) strictly between the start and the finish. */
export function breakTimes(startedAt, durationMs, breakEveryMs) {
  const out = [];
  if (!(breakEveryMs > 0)) return out;
  const end = startedAt + durationMs;
  for (let t = startedAt + breakEveryMs; t < end; t += breakEveryMs) out.push(t);
  return out;
}

/** Everything the sidebar box shows, at `now`. */
export function timerStatus(timer, now = Date.now()) {
  const end = timer.startedAt + timer.durationMs;
  const breaks = breakTimes(timer.startedAt, timer.durationMs, timer.breakEveryMs);
  const nextBreak = breaks.find((b) => b > now) ?? null;
  return {
    end,
    remaining: Math.max(0, end - now),
    untilBreak: nextBreak == null ? null : nextBreak - now,
    breaksPassed: breaks.filter((b) => b <= now).length,
    finished: now >= end,
    progress: Math.min(1, Math.max(0, (now - timer.startedAt) / timer.durationMs)),
  };
}

/** `1h 5m` / `5m` — time left, in whole minutes rounded up, so it reads
 *  `0m` only at the finish. */
export function formatMinutes(ms) {
  const total = Math.max(0, Math.ceil(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Whole minutes left, rounded up — the ring's hover figure. */
export function minutesLeft(ms) {
  return Math.max(0, Math.ceil(ms / MINUTE));
}

/** A wall-clock time in the user's locale: `4:35 PM` / `16:35`. With
 *  `period: false` a 12-hour clock drops its AM / PM (`4:35`) — for the
 *  timeline, where the labels are packed tight and all fall within a
 *  day of now. */
export function formatClock(ms, { period = true } = {}) {
  const fmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  if (period) return fmt.format(new Date(ms));
  return fmt.formatToParts(new Date(ms))
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value).join("").trim();
}
