/**
 * A to-do's status — four states the toggle at its left steps through:
 *
 *   inactive → primed → active → complete → archived → inactive …
 *
 * Archived to-dos leave the list for the panel's Archived section (shut
 * until asked for); a click there restores one to inactive.
 *
 * (⌘-click — or ⇧-click — steps back.) Primed and active to-dos are pulled out of their
 * desks to the top of the list; the active one is drawn inverted. Only
 * one to-do is active at a time: making another active sends the one
 * that was back to primed.
 *
 * A title that ends in a length — `30m`, `1h`, `1h33m`, `1h 30m`,
 * `1.5h` — gives the to-do a "Start timer" button while it is active,
 * which starts the focus timer (timer/timer-store.js) for that long,
 * named after the rest of the title. Nothing starts by itself. The
 * to-do remembers the timer it started (`timerStartedAt`); when it stops
 * being active, that timer is cancelled if it is still the one running,
 * and left alone if the user has started another since.
 */

export const STATES = ["inactive", "primed", "active", "complete", "archived"];

/** Finished: complete or archived. `done` mirrors it for older readers. */
export const isFinished = (s) => s === "complete" || s === "archived";

/** A stored to-do's status. Older items carried only `done`. */
export function statusOf(todo) {
  if (STATES.includes(todo?.status)) return todo.status;
  return todo?.done ? "complete" : "inactive";
}

/** The status after one click (`dir` 1) or ⌘-click (`dir` -1). */
export function nextStatus(status, dir = 1) {
  const i = STATES.indexOf(status);
  return STATES[(i + (dir < 0 ? STATES.length - 1 : 1)) % STATES.length];
}

const LABEL = {
  inactive: "Not started — click to prime",
  primed: "Primed — click to start",
  active: "Active — click to complete",
  complete: "Complete — click to archive",
  archived: "Archived — click to restore",
};
export const statusLabel = (s) => LABEL[s];

/** One icon per state, all on the same rounded square. Complete fills
 *  the square; its tick is punched out in the paper's colour (CSS).
 *  Archived is the square as a box with its lid on. */
const BOX = `<rect x="2.5" y="2.5" width="11" height="11" rx="3"/>`;
const ICONS = {
  inactive: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}</svg>`,
  primed: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}<circle class="todo-status-fill" cx="8" cy="8" r="1.9"/></svg>`,
  active: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}<path class="todo-status-fill" d="M6.6 5.4v5.2L10.9 8z"/></svg>`,
  complete: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="todo-status-fill" x="2.5" y="2.5" width="11" height="11" rx="3"/><path class="todo-status-tick" d="M5.3 8.2l1.8 1.8 3.6-3.9"/></svg>`,
  archived: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="3.5" rx="1"/><path d="M3.25 6.5v5.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5V6.5M6.5 9h3"/></svg>`,
};
export const statusIcon = (s) => ICONS[s] || ICONS.inactive;

/** The longest a title can ask for — the Start timer sheet's own cap. */
const MAX_MS = (23 * 60 + 59) * 60 * 1000;

/**
 * A length at the end of a title, as `{ ms, task }` — `task` the title
 * without it — or null. Hours may be decimal; minutes are whole; either
 * part may be left out, not both. The length has to stand apart from the
 * words before it, so "Room 4m" asks for four minutes but "item4m"
 * asks for nothing.
 */
export function parseDuration(title) {
  const m = /(^|\s)(?:(\d+(?:\.\d+)?)h)?\s?(?:(\d+)m)?\s*$/i.exec(title || "");
  if (!m || (!m[2] && !m[3])) return null;
  const ms = Math.round((Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 60 * 1000);
  if (!(ms > 0) || ms > MAX_MS) return null;
  return { ms, task: (title.slice(0, m.index) + m[1]).trim() };
}

/**
 * What a status change does to the timer: leaving active takes the timer
 * the to-do started with it, if it is still the one running. Returns the
 * patch for the to-do's `timerStartedAt`.
 */
export async function applyTimer(state, todo, from, to) {
  if (!(from === "active" && to !== "active")) return {};
  const timer = await import("../timer/timer-store.js");
  const t = timer.getTimer(state);
  if (t && todo.timerStartedAt && t.startedAt === todo.timerStartedAt) await timer.deleteTimer(state);
  return { timerStartedAt: null };
}

/** The "Start timer" button: a timer for the title's length, no breaks,
 *  leaving the Start timer sheet's remembered values as they were.
 *  Resolves to its `startedAt`, or null when the title has no length. */
export async function startTodoTimer(state, todo) {
  const d = parseDuration(todo.title);
  if (!d) return null;
  const timer = await import("../timer/timer-store.js");
  const now = Date.now();
  await timer.startTimer(state, { task: d.task || "To-do", durationMs: d.ms, breakEvery: 0, last: {} }, now);
  return now;
}

/** The to-do's own timer is the one running now. */
export function todoTimerRunning(state, todo) {
  const t = state.settings?.timer?.active;
  return !!t && !!todo.timerStartedAt && t.startedAt === todo.timerStartedAt
    && Date.now() < t.startedAt + t.durationMs;
}
