/**
 * Re-reading the surfaces that hold a file open.
 *
 * The disk-wins reconcile reports *structure* — files added, removed,
 * renamed. A file whose bytes changed underneath it produces no event at
 * all, so every surface currently showing one has to re-read on each
 * reconcile pass or it stays stale until closed and re-opened. That's
 * this module: one call from `reconcileDesk`, four surfaces, one shared
 * policy.
 *
 * The policy, in every case: our own content coming back is a no-op, an
 * unsaved buffer is strictly newer than disk and keeps what it has, and
 * nothing per-device — caret, scroll, camera, zoom — is taken from the
 * far side.
 *
 * Reads are gated on a batched `stat` (`file-freshness.js`) because on
 * iOS these passes are a poll, not an event, and re-reading a
 * multi-megabyte notebook every tick to learn nothing changed is work an
 * iPad can feel.
 *
 * The notebook and stack hops go through AppState events rather than
 * imports, so `sync/` never pulls in the lazily-loaded notebook bundle
 * or the stack component.
 */

import { applyExternalDocContent } from "./apply-external.js";
import { movedSince } from "./file-freshness.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Re-read whatever is on screen (and in panes) for `deskId`. */
export async function reloadOpenSurfaces(state, deskId) {
  // One batched stat for the three main surfaces, so a pass that changed
  // nothing costs a stat rather than three reads.
  const moved = await movedSince([
    state.currentFileId, state.currentNotebookFileId, state.currentStackFileId,
  ]);
  if (moved.has(state.currentFileId)) await maybeReloadOpenDoc(state, deskId);
  if (moved.has(state.currentNotebookFileId)) await maybeReloadOpenNotebook(state, deskId);
  if (moved.has(state.currentStackFileId)) await maybeReloadOpenStack(state, deskId);
  await maybeReloadOpenPanes();
}

/** If the open doc lives in `deskId`, re-read it from disk and apply the
 *  external content under the standard guards. */
async function maybeReloadOpenDoc(state, deskId) {
  const fileId = state.currentFileId;
  if (!fileId || !state.editor || state.currentProjectId) return;
  if (!fileInDesk(state, deskId, fileId)) return;
  try {
    const file = await invoke("load_file", { id: fileId });
    if (!file || state.currentFileId !== fileId) return;
    applyExternalDocContent(state, {
      content: file.content,
      lockKey: fileId,
      skipWhenDirty: true,
    });
  } catch (_) { /* file may have just been removed by the reconcile */ }
}

/** The same thing for an open notebook — which the reconcile never did,
 *  so a canvas open on this device simply never saw the far device's
 *  strokes. The reconciler reports *structure* (added / removed /
 *  renamed); a `.hushnote` whose bytes changed under it is no event at
 *  all, exactly as with a doc, so the open surface has to re-read on
 *  every pass or it goes stale until it's closed and re-opened.
 *
 *  Routed through the `notebook-external-reload` event rather than an
 *  import, so this module stays clear of the lazily-loaded notebook
 *  bundle. The handler skips an unsaved canvas (the doc path's
 *  `skipWhenDirty` policy) and then `mirror`s the incoming content:
 *  local undo history survives, the remote edit lands as one
 *  checkpoint, content byte-identical to our own last write is a no-op,
 *  and the incoming camera is deliberately ignored — viewports are
 *  per-device. The pull lock keeps the mirror from looping back out
 *  through autosave. */
async function maybeReloadOpenNotebook(state, deskId) {
  const fileId = state.currentNotebookFileId;
  if (!fileId || !fileInDesk(state, deskId, fileId)) return;
  state.acquirePullLock(fileId);
  try {
    const file = await invoke("load_file", { id: fileId });
    if (!file || state.currentNotebookFileId !== fileId) return;
    state.emit("notebook-external-reload", file.content);
  } catch (_) { /* file may have just been removed by the reconcile */ }
  finally { state.releasePullLock(); }
}

/** And for the open stack. A `.hushstack` is structure — which files are
 *  columns, in what order, at what width — so a far-side edit means the
 *  component has to be rebuilt rather than mirrored; the guards for that
 *  (own echo, unsaved local changes, viewport-only drift) live in
 *  `stack-bridge.js#reloadStackContent`, which is the only thing that can
 *  see the live component. The columns *inside* a stack are separate
 *  files that sync on their own. */
async function maybeReloadOpenStack(state, deskId) {
  const fileId = state.currentStackFileId;
  if (!fileId || !fileInDesk(state, deskId, fileId)) return;
  state.acquirePullLock(fileId);
  try {
    const file = await invoke("load_file", { id: fileId });
    if (!file || state.currentStackFileId !== fileId) return;
    state.emit("stack-external-reload", file.content);
  } catch (_) { /* file may have just been removed by the reconcile */ }
  finally { state.releasePullLock(); }
}

/** And every open floating pane — the Gutter included, since a gutter is
 *  a docked notebook pane. Not scoped to `deskId`: a pane can show a
 *  file from any desk (that is rather the point of one), and the read is
 *  keyed by fileId, so scoping it would just make panes onto other desks
 *  the one surface that stayed stale. Guards live in
 *  `pane/pane-external.js`, which is the only module that can see a
 *  pane's dirty flag and its editor. */
async function maybeReloadOpenPanes() {
  try {
    const { refreshPanesFromDisk } = await import("../pane/pane-external.js");
    await refreshPanesFromDisk();
  } catch (e) { console.warn("pane reload failed:", e); }
}

function fileInDesk(state, deskId, fileId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return false;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.fileId === fileId) return true;
      if (n.children && walk(n.children)) return true;
    }
    return false;
  };
  return walk(desk.children);
}

