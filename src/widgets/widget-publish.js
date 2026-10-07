/**
 * Keeps the home screen widgets' snapshot current. Every window builds
 * the snapshot (widget-snapshot.js) from what it knows and hands it to
 * Rust (`publish_widget_snapshot`), which writes it into the App Group
 * container and asks WidgetKit to reload — or does nothing at all on a
 * platform or build without widgets.
 *
 * Republished, debounced, whenever something the widgets show could have
 * changed: a file opened (activity stamped), the tree edited (a rename, a
 * delete, a move to Trash), the desk list changed, a sibling window's
 * settings merged in. A snapshot identical to the last one sent is not
 * sent again, and Rust skips a write whose bytes match the file's.
 */
import { buildWidgetSnapshot } from "./widget-snapshot.js";
import { noteRecentActivity, WIDGET_ACTIVITY_EVENT } from "./widget-activity.js";
import { logActivity } from "../activity-log.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const PUBLISH_DELAY_MS = 1200;

let timer = null;
let lastSent = null;
/** What the Activity Log last heard from the hand-off, so a failure that
 *  repeats on every publish is logged once, not once a second. */
let lastLogged = null;

/** Log the hand-off's outcome when it changes — the only way to see,
 *  from an iPad with no console, why a widget is sitting on its empty
 *  state (a missing App Group, most likely). */
function logOutcome(key, level, message, detail) {
  if (key === lastLogged) return;
  lastLogged = key;
  logActivity("widgets", level, message, detail);
}

async function publishNow(state) {
  timer = null;
  let json;
  try { json = JSON.stringify(buildWidgetSnapshot(state)); }
  catch (e) { console.warn("widget snapshot failed:", e); return; }
  if (json === lastSent) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const written = await invoke("publish_widget_snapshot", { snapshot: json });
    lastSent = json;
    if (written) {
      const snap = JSON.parse(json);
      logOutcome("ok", "info", "Widget snapshot published", {
        desks: snap.desks.length, recentFiles: snap.recentFiles.length,
      });
    }
  } catch (e) {
    // No App Group container, an older binary without the command, a
    // write that failed. Logged, not retried until something changes.
    const message = String(e?.message || e);
    console.warn("publish_widget_snapshot failed:", message);
    logOutcome(`err:${message}`, "error", "Widget snapshot not published", { error: message });
  }
}

function schedule(state) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void publishNow(state); }, PUBLISH_DELAY_MS);
}

/** Wire the publisher up for this window. Called once from main.js. */
export function installWidgetPublisher(state) {
  if (!IS_TAURI) return;
  // Switching desks is a visit even before a file opens there.
  state.on("active-desk-changed", (deskId) => noteRecentActivity(state, deskId));
  const onChange = () => schedule(state);
  for (const ev of [
    WIDGET_ACTIVITY_EVENT, "files-changed", "desks-changed",
    "active-desk-changed", "remote-settings-merged",
  ]) state.on(ev, onChange);
  // The desk this window opened on counts as visited, and the first
  // snapshot of the session goes out once the tree has loaded.
  const deskId = state.settings?.activeDeskId;
  if (deskId) noteRecentActivity(state, deskId);
  schedule(state);
}
