/**
 * A to-do's status — four states the toggle at its left steps through:
 *
 *   inactive → primed → active → complete
 *
 * A click moves forward; ⌘-click (or ⇧-click) moves back, stopping at
 * inactive. Complete is where a finished to-do goes: it leaves the list
 * for the panel's Completed section. A click on a completed to-do's
 * toggle deletes it for good — its hover shows a red trash can to say
 * so. Hovering any toggle previews what a click will do, held modifier
 * included (`clickAction`, todo-panel.js).
 *
 * Primed and active to-dos are pulled out of their desks to the top of
 * the list; the active one is drawn inverted. Only one to-do is active
 * at a time: making another active sends the one that was back to
 * primed.
 *
 * A title that ends in a length — `30m`, `1h`, `1h33m`, `1h 30m`,
 * `1.5h` — gives the to-do a "Start timer" button while it is active,
 * which starts the focus timer (timer/timer-store.js) for that long,
 * named after the rest of the title. Nothing starts by itself. The
 * to-do remembers the timer it started (`timerStartedAt`); when it stops
 * being active, that timer is cancelled if it is still the one running,
 * and left alone if the user has started another since.
 */

export const STATES = ["inactive", "primed", "active", "complete"];

/** A stored to-do's status. Older items carried only `done`; for a while
 *  there was an "archived" state, which complete has taken over. */
export function statusOf(todo) {
  if (todo?.status === "archived") return "complete";
  if (STATES.includes(todo?.status)) return todo.status;
  return todo?.done ? "complete" : "inactive";
}

/**
 * What a click on the toggle does from `status`: a status to move to,
 * "delete" (a plain click on a completed to-do), or null (stepping back
 * from inactive — there is nothing before it).
 */
export function clickAction(status, back = false) {
  const i = STATES.indexOf(status);
  if (back) return i > 0 ? STATES[i - 1] : null;
  return i < STATES.length - 1 ? STATES[i + 1] : "delete";
}

const LABEL = {
  inactive: "Not started",
  primed: "Primed",
  active: "Active",
  complete: "Complete",
};
const ACTION = {
  inactive: "click to reset",
  primed: "click to prime",
  active: "click to start",
  complete: "click to complete",
  delete: "click to delete for good",
};
/** The toggle's tooltip: where it is, and what a click would do. */
export function statusLabel(status, back = false) {
  const action = clickAction(status, back);
  return action ? `${LABEL[status]} — ${ACTION[action]}` : LABEL[status];
}

/** One icon per state, all on the same rounded square. Complete fills
 *  the square; its tick is punched out in the paper's colour (CSS). The
 *  trash can is the delete a click on a completed to-do performs, shown
 *  (red) only as that hover's preview. */
const BOX = `<rect x="2.5" y="2.5" width="11" height="11" rx="3"/>`;
const ICONS = {
  inactive: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}</svg>`,
  primed: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}<circle class="todo-status-fill" cx="8" cy="8" r="1.9"/></svg>`,
  active: `<svg viewBox="0 0 16 16" aria-hidden="true">${BOX}<path class="todo-status-fill" d="M6.6 5.4v5.2L10.9 8z"/></svg>`,
  complete: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="todo-status-fill" x="2.5" y="2.5" width="11" height="11" rx="3"/><path class="todo-status-tick" d="M5.3 8.2l1.8 1.8 3.6-3.9"/></svg>`,
  delete: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M4 4.25l.6 8.4a1 1 0 0 0 1 .93h4.8a1 1 0 0 0 1-.93l.6-8.4M6.75 6.75v4.25M9.25 6.75v4.25"/></svg>`,
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
