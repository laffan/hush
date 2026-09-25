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

/** `1:05:09` / `5:09` — a countdown, rounded up so it reads 0:00 only
 *  at the finish. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A wall-clock time in the user's locale: `4:35 PM` / `16:35`. */
export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
