/**
 * Focus timer — the model. One timer at a time, shared by every desk
 * (and every window: it lives in `settings.timer`, opaque to Rust — see
 * `timer` on `AppSettings`):
 *
 *   { active: { task, mode, startedAt, durationMs, breakEveryMs, chimes } | null,
 *     last:   { mode, hours, minutes, alarmHour, alarmMinute, breakEvery, chimes } }
 *
 * `active` holds absolute times, so a timer keeps running while the app
 * is closed and every window reads the same clock. `last` is what the
 * Start timer sheet opens on next time.
 *
 * `mode` is "timer" (a length: hours and minutes from now) or "alarm" (a
 * time of day). Both are stored the same way — an alarm is a timer whose
 * length is whatever is left until that time — and the mode only
 * changes how the sheet asks and how the last ten minutes look.
 *
 * Breaks start every `breakEveryMs` from the start, stopping short of
 * the finish, and last `BREAK_MS` (cut short by the finish). The session
 * countdown never pauses for them — a break is counted inside the
 * session, with a countdown of its own while it runs.
 *
 * `chimes` plays a tone as a break ends and another as the session does
 * (timer-chimes.js).
 */

const MINUTE = 60 * 1000;

/** Break frequencies the sheet offers, in minutes (0 = no breaks). */
export const BREAK_CHOICES = [0, 25, 30, 45, 60, 90];

export const DEFAULT_LAST = {
  mode: "timer", hours: 1, minutes: 0, alarmHour: null, alarmMinute: 0, breakEvery: 25, chimes: false,
};

/** Every break is this long. */
export const BREAK_MS = 2 * MINUTE;

/** The final stretch of an alarm, which the sidebar paints red. */
export const ALARM_WARNING_MS = 10 * MINUTE;

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
export function startTimer(state, { task, mode = "timer", durationMs, breakEvery, chimes = false, last }, now = Date.now()) {
  return write(state, {
    active: { task: task.trim(), mode, startedAt: now, durationMs, breakEveryMs: breakEvery * MINUTE, chimes: !!chimes },
    last: { ...lastValues(state), ...last, mode, breakEvery, chimes: !!chimes },
  });
}

/** The next time the clock reads `hour24:minute` — later today, or
 *  tomorrow if that has already passed (or is this very minute). */
export function nextOccurrence(hour24, minute, now = Date.now()) {
  const d = new Date(now);
  d.setHours(hour24, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Whether this locale writes times on a 12-hour clock (with AM / PM). */
export function uses12HourClock() {
  const fmt = new Intl.DateTimeFormat([], { hour: "numeric" });
  const hc = fmt.resolvedOptions().hourCycle;
  if (hc) return hc === "h11" || hc === "h12";
  return fmt.formatToParts(new Date()).some((p) => p.type === "dayPeriod");
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
  const breakEnd = (b) => Math.min(b + BREAK_MS, end);
  const current = breaks.find((b) => b <= now && now < breakEnd(b)) ?? null;
  return {
    end,
    remaining: Math.max(0, end - now),
    untilBreak: nextBreak == null ? null : nextBreak - now,
    breaksPassed: breaks.filter((b) => b <= now).length,
    /** Breaks that have run their course — what the break chime counts. */
    breaksDone: breaks.filter((b) => breakEnd(b) <= now && breakEnd(b) < end).length,
    /** The break under way: its time left and how far through it is. */
    onBreak: current == null ? null : {
      remaining: breakEnd(current) - now,
      progress: (now - current) / (breakEnd(current) - current),
    },
    /** Where each break sits along the session, 0-1 — the hash marks. */
    breakMarks: breaks.map((b) => (b - timer.startedAt) / timer.durationMs),
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

/** Where the ring was dragged to — `{ left, bottom }`, px from the
 *  window's left and bottom edges — or null for its default spot. Kept
 *  beside the timer rather than on it, so it outlives Delete / Start. */
export function ringPosition(state) {
  const r = read(state).ring;
  return r && Number.isFinite(r.left) && Number.isFinite(r.bottom) ? r : null;
}

export function setRingPosition(state, pos) {
  return write(state, { ring: pos });
}
