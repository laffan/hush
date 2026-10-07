/**
 * When each desk and file was last opened on this device — the clock the
 * home screen widgets sort by.
 *
 * The per-desk MRU (`state/recent-files.js`) holds an order but no times,
 * which is all a desk-scoped list needs. The widgets need more: "recent
 * desks" is an order over desks, and "recent files" across desks has to
 * interleave several desks' lists. Both want when, not just which.
 *
 * Kept in `settings.recentActivity` (opaque `recent_activity` on the Rust
 * `AppSettings`) as `{ desks: { [deskId]: ms }, files: { [fileId]: ms } }`,
 * per device like the MRU. Stamped in memory at once and written in one
 * key-scoped patch a moment later, so opening a file costs no extra IPC
 * on the open path.
 */

/** Entries kept per map. More than any widget shows; enough that a desk
 *  visited rarely still has its files' times. */
const CAP = 200;
const WRITE_DELAY_MS = 1500;

let writeTimer = null;

export const WIDGET_ACTIVITY_EVENT = "recent-activity-changed";

/** The activity maps, always well-formed. */
export function getRecentActivity(state) {
  const a = state.settings?.recentActivity;
  const obj = a && typeof a === "object" ? a : {};
  const clean = (m) => (m && typeof m === "object" && !Array.isArray(m) ? m : {});
  return { desks: clean(obj.desks), files: clean(obj.files) };
}

/** Keep the `CAP` most recent entries of one map. */
function trim(map) {
  const entries = Object.entries(map).filter(([, t]) => Number.isFinite(t));
  if (entries.length <= CAP) return Object.fromEntries(entries);
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, CAP));
}

/** Stamp a desk (and, when given, a file in it) as opened now. */
export function noteRecentActivity(state, deskId, fileId = null, now = Date.now()) {
  if (!state?.settings || (!deskId && !fileId)) return;
  const cur = getRecentActivity(state);
  const desks = deskId ? trim({ ...cur.desks, [deskId]: now }) : cur.desks;
  const files = fileId ? trim({ ...cur.files, [fileId]: now }) : cur.files;
  state.settings.recentActivity = { desks, files };
  state.emit?.(WIDGET_ACTIVITY_EVENT);
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void state.updateSettings({ recentActivity: state.settings.recentActivity });
  }, WRITE_DELAY_MS);
}
