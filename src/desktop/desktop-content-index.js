/**
 * Which Desktops hold something the user put there — what decides
 * whether a project's row carries its Desktop icon all the time, beside
 * the name, rather than only in the hover actions.
 *
 * A Desktop's arrangement lives in IndexedDB (desktop-store.js), which a
 * synchronous sidebar render can't read. So every save of one records
 * here whether it holds anything beyond its file thumbnails — a note, a
 * drawing, a drag box, a pasted image — kept per device in localStorage
 * like the card index (cards/card-index.js), which matches the Desktops
 * themselves: they are per device too. Stickies pinned to a Desktop count
 * as well, but they live in settings and are read there directly.
 */

export const DESKTOP_CONTENT_EVENT = "hush-desktop-content-changed";
const STORE_KEY = "hush-desktop-content";

let ids = load();

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}

/** Anything on the canvas that isn't a file's own thumbnail. */
export function hasUserContent(shapes) {
  return (shapes || []).some((s) => !(s?.type === "image" && s.fileRef));
}

/** Called with the shapes of every Desktop envelope as it is saved. */
export function recordDesktopContent(containerId, shapes) {
  if (!containerId) return;
  const has = hasUserContent(shapes);
  if (has === ids.has(containerId)) return;
  if (has) ids.add(containerId);
  else ids.delete(containerId);
  save();
  window.dispatchEvent(new Event(DESKTOP_CONTENT_EVENT));
}

export function desktopHasContent(state, containerId) {
  if (ids.has(containerId)) return true;
  const notes = state?.settings?.stickyNotes;
  return Array.isArray(notes) && notes.some((n) => n?.kind === "desktop" && n.target === containerId);
}

/** Desktops laid out before this index existed have never recorded
 *  themselves; read their saved envelopes once per device. */
const BACKFILLED_KEY = "hush-desktop-content-backfilled";
export async function backfillDesktopContentIndex() {
  try { if (localStorage.getItem(BACKFILLED_KEY)) return; } catch { return; }
  const { forEachDesktopEnvelope } = await import("./desktop-store.js");
  const done = await forEachDesktopEnvelope((id, env) => recordDesktopContent(id, env?.shapes));
  if (done) { try { localStorage.setItem(BACKFILLED_KEY, "1"); } catch { /* storage unavailable */ } }
}
