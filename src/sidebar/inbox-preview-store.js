/**
 * What the Inbox's preview cards (inbox-preview.js) remember between
 * sessions, per device: where the caret last was in each document, and
 * small snapshots of each notebook (light and dark) as it was last saved.
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

function dropThumb(fileId) {
  for (const k of ["", ".light", ".dark"]) {
    try { localStorage.removeItem(THUMB_PREFIX + fileId + k); } catch {}
  }
}

/** Keep the notebook's snapshots, light and dark (inbox-notebook-
 *  thumb.js draws them from `canvasInstance`'s shapes); an empty
 *  notebook keeps none. */
export async function recordNotebookThumb(fileId, canvasInstance) {
  if (!fileId || !canvasInstance) return;
  const { renderNotebookThumbs } = await import("./inbox-notebook-thumb.js");
  let thumbs = null;
  try { thumbs = renderNotebookThumbs(canvasInstance); } catch { thumbs = null; }
  const index = read(THUMB_INDEX_KEY, []).filter((id) => id !== fileId);
  dropThumb(fileId);
  if (thumbs) {
    index.push(fileId);
    while (index.length > MAX_THUMBS) dropThumb(index.shift());
    try {
      localStorage.setItem(THUMB_PREFIX + fileId + ".light", thumbs.light);
      localStorage.setItem(THUMB_PREFIX + fileId + ".dark", thumbs.dark);
    } catch { dropThumb(fileId); index.pop(); }
  }
  write(THUMB_INDEX_KEY, index);
}

const lastThumbAt = new Map();
const pendingThumb = new Map();
const THUMB_EVERY_MS = 8000;

/** `recordNotebookThumb` after each save of the notebook, at most once
 *  every `THUMB_EVERY_MS` and at an idle moment — the last save in a
 *  burst is always drawn, so the snapshot follows every change. */
export function noteNotebookSaved(fileId, canvasInstance) {
  if (!fileId || pendingThumb.has(fileId)) return;
  const wait = Math.max(0, THUMB_EVERY_MS - (Date.now() - (lastThumbAt.get(fileId) || 0)));
  pendingThumb.set(fileId, setTimeout(() => {
    pendingThumb.delete(fileId);
    lastThumbAt.set(fileId, Date.now());
    const run = () => void recordNotebookThumb(fileId, canvasInstance);
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
    else run();
  }, wait));
}

/** `{ light, dark }` snapshots of a notebook, or null. */
export function notebookThumb(fileId) {
  try {
    const light = localStorage.getItem(THUMB_PREFIX + fileId + ".light");
    const dark = localStorage.getItem(THUMB_PREFIX + fileId + ".dark");
    return light && dark ? { light, dark } : null;
  } catch { return null; }
}

/** Keep the open document's caret current: after a pause in its edits,
 *  and when the window is hidden or closed (switching documents records
 *  it too — state/editor-cache-key.js). */
export function installCaretTracking(state) {
  let timer = null;
  /** `only`: the file the pause was in — a pause that ends after the
   *  editor moved to another file records nothing (the switch did). */
  const note = (only = state.currentFileId) => {
    if (!state.currentFileId || state.currentFileId !== only || state.currentProjectId || state.currentLocalSync) return;
    const head = state.editor?.view?.state.selection.main.head;
    if (Number.isFinite(head)) recordDocCaret(state.currentFileId, head);
  };
  state.on("doc-content-changed", () => {
    clearTimeout(timer);
    const id = state.currentFileId;
    timer = setTimeout(() => note(id), 1500);
  });
  const flush = () => { note(); if (carets) write(CARETS_KEY, carets); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
}
