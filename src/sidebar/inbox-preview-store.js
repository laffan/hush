/**
 * What the Inbox's preview cards (inbox-preview.js) remember between
 * sessions, per device: where the caret last was in each document, and
 * small snapshots of each notebook (light and dark) as it was last saved.
 *
 * A per-device cache rather than a setting — a caret on this machine
 * says nothing about another. Carets are kept in `localStorage`, which
 * survives restarts and is shared by this app's windows; snapshots, much
 * larger, in IndexedDB (inbox-thumb-db.js). Every access is guarded:
 * storage can be full, blocked or missing, and a preview that can't be
 * remembered just isn't shown.
 */

import { captureScene } from "./inbox-notebook-scene.js";
import { getThumb, putThumb, deleteThumb, loadThumbs } from "./inbox-thumb-db.js";

const CARETS_KEY = "hush.inbox.carets";
const MAX_CARETS = 400;

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

/** Snapshot the notebook in `canvasInstance` — see
 *  inbox-notebook-scene.js / inbox-notebook-thumb.js: the scene is taken
 *  now, the drawing done at an idle moment. */
export async function recordNotebookThumb(fileId, canvasInstance) {
  const scene = captureScene(canvasInstance);
  await drawThumb(fileId, scene);
}

async function drawThumb(fileId, scene) {
  if (!fileId || !scene) return; // not on screen: keep what there is
  if (scene.empty) { deleteThumb(fileId); return; }
  const { renderScene } = await import("./inbox-notebook-thumb.js");
  let thumbs = null;
  try { thumbs = renderScene(scene); } catch (e) { console.warn("Inbox snapshot failed:", e); return; }
  if (!thumbs) return;
  putThumb(fileId, thumbs.light, thumbs.dark);
  // A preview already in the sidebar takes the new snapshot in place.
  for (const img of document.querySelectorAll(`.inbox-preview-notebook[data-file-id="${CSS.escape(fileId)}"] img`)) {
    img.src = img.classList.contains("inbox-thumb-dark") ? thumbs.dark : thumbs.light;
  }
}

const lastThumbAt = new Map();
/** fileId → { timer, scene }: the latest scene waiting to be drawn. */
const pendingThumb = new Map();
const THUMB_EVERY_MS = 8000;

/** After each save of a notebook, with the scene the save path took as it
 *  began (inbox-notebook-scene.js#captureScene — so the snapshot is of
 *  the notebook that was saved, even if the canvas has moved on to
 *  another file since): draw the latest at most once every
 *  `THUMB_EVERY_MS`, at an idle moment. A null scene (the canvas wasn't
 *  on screen) keeps the snapshot there is. */
export function noteNotebookSaved(fileId, scene) {
  if (!fileId || !scene) return;
  const pending = pendingThumb.get(fileId);
  if (pending) { pending.scene = scene; return; }
  const wait = Math.max(0, THUMB_EVERY_MS - (Date.now() - (lastThumbAt.get(fileId) || 0)));
  const entry = { scene, timer: 0 };
  entry.timer = setTimeout(() => {
    pendingThumb.delete(fileId);
    lastThumbAt.set(fileId, Date.now());
    const run = () => void drawThumb(fileId, entry.scene);
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
    else run();
  }, wait);
  pendingThumb.set(fileId, entry);
}

/** `{ light, dark }` snapshots of a notebook, or null. */
export function notebookThumb(fileId) {
  return getThumb(fileId);
}

/** Keep the open document's caret current: after a pause in its edits,
 *  and when the window is hidden or closed (switching documents records
 *  it too — state/editor-cache-key.js). */
export function installCaretTracking(state) {
  // The kept notebook snapshots, read once; the sidebar redraws with them.
  void loadThumbs().then((ok) => { if (ok) state.emit("files-changed"); });
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
