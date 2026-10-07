/**
 * Use Temporary Style — a style for one editing context of one document,
 * for this session only.
 *
 * A context is the surface showing the document: the main editor
 * (`doc:<fileId>`, or `pj:<projectId>` for a project's joined editor) or
 * one floating Doc pane (`pane:<paneId>`). The same document open in
 * another pane, every other document, and the desk's style are left as
 * they were. Nothing is written anywhere: the map lives in this window's
 * memory, is emptied on a desk switch, and is gone when the app closes.
 *
 * **The main editor** has no style of its own — its look is the window's
 * active style (`settings.activeStyleId`, which a locked document already
 * swaps on open). So the temporary style goes into that field *in memory
 * only*: settings writes are key-scoped (state.js#updateSettings), so a
 * value never handed to `updateSettings` never reaches disk. `applied`
 * remembers the style it stands in for (`base`), which goes back the
 * moment the main editor leaves that document for a notebook, PDF, stack
 * or project — a document open is main.js's file-opened handler's, which
 * sets the next document's style itself. Unlocked panes keep rendering
 * with `base` (`paneBaseSettings`), since the temporary style is the main
 * editor's alone.
 *
 * **A pane** is simpler: its temporary style is treated like a locked
 * style for that pane only (`paneTemporaryStyle`, ahead of the file's
 * lock in pane-theme-sync.js and pane-content.js).
 *
 * Choosing a style any other way while a temporary one shows in the main
 * editor (Use Style, the style editor) is an explicit choice: the
 * temporary style for that context is dropped rather than fought.
 */

/** The value a context maps to when its temporary style is Default. */
export const DEFAULT_STYLE = "__default__";

const temporary = new Map(); // context key → style id | DEFAULT_STYLE
let applied = null; // { key, styleId, base } while the main editor shows one
let installed = false;
let ownEmit = false;

const styleIdOf = (v) => (v === DEFAULT_STYLE ? null : v);

/** The main editor's context key, or null when it isn't showing a
 *  document (a notebook, PDF, stack, or nothing is open). */
export function mainContextKey(s) {
  if (s.currentNotebookFileId || s.currentPdfFileId || s.currentStackFileId) return null;
  if (s.currentProjectId) return "pj:" + s.currentProjectId;
  if (s.currentFileId) return "doc:" + s.currentFileId;
  return null;
}

export const paneContextKey = (paneId) => "pane:" + paneId;

/** The temporary style set for `key` (a style id or DEFAULT_STYLE), or
 *  undefined when there is none. */
export function temporaryStyleFor(key) {
  return key && temporary.has(key) ? temporary.get(key) : undefined;
}

/** A pane's temporary style in the locked-style form `reconfigureTheme`
 *  takes (`"__default__"` for Default), or null. */
export function paneTemporaryStyle(paneId) {
  return temporaryStyleFor(paneContextKey(paneId)) ?? null;
}

/** The settings an unlocked pane renders with: the session's, less any
 *  temporary style the main editor is wearing. */
export function paneBaseSettings(settings) {
  if (!applied || (settings.activeStyleId || null) !== applied.styleId) return settings;
  return { ...settings, activeStyleId: applied.base };
}

function emitStyleChanged(state) {
  ownEmit = true;
  try { state.emit("style-changed"); } finally { ownEmit = false; }
}

async function repaintPanes() {
  try { (await import("../pane/pane-theme-sync.js")).syncPaneThemes(); } catch (_) {}
}

/** Put the main editor's underlying style back, if a temporary one is
 *  still showing there. */
function restoreMain(state) {
  if (!applied) return;
  const a = applied;
  applied = null;
  if ((state.settings.activeStyleId || null) !== a.styleId) return;
  state.settings.activeStyleId = a.base;
  emitStyleChanged(state);
}

/** Show the main editor's temporary style, if its current context has one. */
function applyMain(state) {
  const key = mainContextKey(state);
  const want = temporaryStyleFor(key);
  if (want === undefined) { restoreMain(state); return; }
  const id = styleIdOf(want);
  const current = state.settings.activeStyleId || null;
  if (!applied || applied.key !== key) applied = { key, styleId: id, base: current };
  else applied.styleId = id;
  if (current !== id) state.settings.activeStyleId = id;
  emitStyleChanged(state);
}

function install(state) {
  if (installed) return;
  installed = true;
  // main.js's own file-opened handler runs first (registered at boot): a
  // document's style is already its own by the time this runs.
  state.on("file-opened", () => {
    if (applied && applied.key !== mainContextKey(state)) {
      if (state.currentFileId) applied = null; // the new document's style is set
      else restoreMain(state); // a project: nothing set its style
    }
    applyMain(state);
  });
  for (const ev of ["notebook-open", "pdf-open", "stack-open", "no-file-state"]) {
    state.on(ev, () => restoreMain(state));
  }
  state.on("active-desk-changed", () => {
    restoreMain(state);
    temporary.clear();
    void repaintPanes();
  });
  // An explicit style choice while the temporary one shows wins.
  state.on("style-changed", () => {
    if (ownEmit || !applied || applied.key !== mainContextKey(state)) return;
    if ((state.settings.activeStyleId || null) === applied.styleId) return;
    temporary.delete(applied.key);
    applied = null;
  });
  // A sibling window's settings write lands the stored activeStyleId over
  // the in-memory one; keep the temporary style on top of the new base.
  state.on("remote-settings-merged", () => {
    if (!applied || applied.key !== mainContextKey(state)) return;
    const merged = state.settings.activeStyleId || null;
    if (merged === applied.styleId) return;
    applied.base = merged;
    state.settings.activeStyleId = applied.styleId;
    emitStyleChanged(state);
  });
}

/**
 * Set (`styleId`: a style id, or DEFAULT_STYLE) or clear (`undefined`)
 * the temporary style of context `key` and show it.
 */
export function setTemporaryStyle(state, key, styleId) {
  if (!key) return;
  install(state);
  if (styleId === undefined) temporary.delete(key);
  else temporary.set(key, styleId);
  if (key.startsWith("pane:")) void repaintPanes();
  else if (key === mainContextKey(state)) applyMain(state);
}
