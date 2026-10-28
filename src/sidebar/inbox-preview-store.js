/**
 * What the Inbox's preview cards (inbox-preview.js) remember between
 * sessions, per device: where the caret last was in each document, and a
 * small snapshot of each notebook as it was last saved.
 *
 * A per-device cache rather than a setting — a caret on this machine
 * says nothing about another — kept in `localStorage`, which survives
 * restarts and is shared by this app's windows. Every access is guarded:
 * storage can be full, blocked or missing, and a preview that can't be
 * remembered just isn't shown. Snapshots are bounded (`MAX_THUMBS`,
 * oldest dropped first) so the store can't grow without end.
 */

const CARETS_KEY = "hush.inbox.carets";
const THUMB_PREFIX = "hush.inbox.thumb.";
const THUMB_INDEX_KEY = "hush.inbox.thumbs";
const MAX_CARETS = 400;
const MAX_THUMBS = 40;
/** The snapshot's width in px — twice the card's, for sharp screens. */
const THUMB_WIDTH = 480;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

let carets = null;
let caretTimer = null;

/** Note where the caret is in a document. Written out lazily, so a burst
 *  of calls (autosaves, switches) costs one write. */
export function recordDocCaret(fileId, offset) {
  if (!fileId || !Number.isFinite(offset)) return;
  carets = carets || read(CARETS_KEY, {});
  delete carets[fileId];
  carets[fileId] = offset;
  const keys = Object.keys(carets);
  if (keys.length > MAX_CARETS) for (const k of keys.slice(0, keys.length - MAX_CARETS)) delete carets[k];
  clearTimeout(caretTimer);
  caretTimer = setTimeout(() => write(CARETS_KEY, carets), 400);
}

export function docCaret(fileId) {
  carets = carets || read(CARETS_KEY, {});
  const v = carets[fileId];
  return Number.isFinite(v) ? v : null;
}

/** Keep a small snapshot of a notebook as it is on screen: every canvas
 *  layer inside `container` (the shapes, and the ink in the drawing
 *  layer's stacked canvases) composited at their on-screen places, scaled
 *  down to `THUMB_WIDTH`. */
export function recordNotebookThumb(fileId, container) {
  if (!fileId || !container) return;
  const box = container.getBoundingClientRect();
  if (box.width < 40 || box.height < 40) return;
  const scale = THUMB_WIDTH / box.width;
  const out = document.createElement("canvas");
  out.width = THUMB_WIDTH;
  out.height = Math.round(box.height * scale);
  const ctx = out.getContext("2d");
  if (!ctx) return;
  for (const c of container.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(c).visibility === "hidden") continue;
    try {
      ctx.drawImage(c, (r.left - box.left) * scale, (r.top - box.top) * scale, r.width * scale, r.height * scale);
    } catch { /* a tainted or lost canvas — leave it out */ }
  }
  let url;
  try { url = out.toDataURL("image/webp", 0.7); } catch { return; }
  if (!url.startsWith("data:image/webp")) {
    try { url = out.toDataURL("image/jpeg", 0.7); } catch { return; }
  }
  const index = read(THUMB_INDEX_KEY, []).filter((id) => id !== fileId);
  index.push(fileId);
  while (index.length > MAX_THUMBS) {
    try { localStorage.removeItem(THUMB_PREFIX + index.shift()); } catch {}
  }
  try { localStorage.setItem(THUMB_PREFIX + fileId, url); } catch { return; }
  write(THUMB_INDEX_KEY, index);
}

const lastThumbAt = new Map();
const THUMB_EVERY_MS = 20000;

/** `recordNotebookThumb`, at most once every `THUMB_EVERY_MS` per
 *  notebook and at an idle moment — the notebook's autosave calls it
 *  after each save, which is how the snapshot follows "as last saved". */
export function noteNotebookSaved(fileId, container) {
  const now = Date.now();
  if (!fileId || now - (lastThumbAt.get(fileId) || 0) < THUMB_EVERY_MS) return;
  lastThumbAt.set(fileId, now);
  const run = () => recordNotebookThumb(fileId, container);
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

export function notebookThumb(fileId) {
  try { return localStorage.getItem(THUMB_PREFIX + fileId) || null; }
  catch { return null; }
}

/** Keep the open document's caret current: after a pause in its edits,
 *  and when the window is hidden or closed (switching documents records
 *  it too — state/editor-cache-key.js). */
export function installCaretTracking(state) {
  let timer = null;
  const note = () => {
    if (!state.currentFileId || state.currentProjectId || state.currentLocalSync) return;
    const head = state.editor?.view?.state.selection.main.head;
    if (Number.isFinite(head)) recordDocCaret(state.currentFileId, head);
  };
  state.on("doc-content-changed", () => { clearTimeout(timer); timer = setTimeout(note, 1500); });
  const flush = () => { note(); if (carets) write(CARETS_KEY, carets); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}
