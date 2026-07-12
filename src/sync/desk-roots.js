/**
 * Local desk roots — the JS face of Phase 3 of LOCAL-DESKS-PLANNING.md.
 *
 * A desk can operate from a folder the user picked instead of app data;
 * the Rust side redirects all storage through `roots.json`, arms a
 * filesystem watcher on each root, and reconciles the tree disk-wins
 * when the folder changes underneath us. This module wraps the commands,
 * keeps `state.deskRoots` (deskId → path) cached for UI badges, and owns
 * the `desk-changed` watcher listener.
 *
 * Desktop-only for now — the iPad path needs security-scoped bookmarks
 * (Phase 4).
 */

import { applyExternalDocContent } from "./apply-external.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Refresh `state.deskRoots` from Rust and notify listeners. */
export async function refreshDeskRoots(state) {
  if (!IS_TAURI) { state.deskRoots = {}; return {}; }
  try {
    state.deskRoots = await invoke("desk_list_roots") || {};
  } catch (e) {
    console.warn("desk_list_roots failed:", e);
    state.deskRoots = state.deskRoots || {};
  }
  state.emit("desk-roots-changed");
  return state.deskRoots;
}

export function isLocalDesk(state, deskId) {
  return !!(deskId && state.deskRoots && state.deskRoots[deskId]);
}

/** Reload the tree from disk after Rust mutated it (reconcile/adopt). */
async function reloadTree(state) {
  try {
    state.fileTree = await invoke("get_file_tree");
    state.emit("files-changed");
  } catch (e) { console.warn("tree reload failed:", e); }
}

/** Pick a folder and move the desk there. */
export async function makeDeskLocal(state, deskId) {
  if (!IS_TAURI) return false;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a folder for this desk" });
  if (!picked) return false;
  try {
    await invoke("desk_make_local", { deskId, targetPath: picked });
  } catch (e) {
    window.alert(`Couldn't make the desk local:\n${e}`);
    return false;
  }
  await refreshDeskRoots(state);
  return true;
}

/** Move a local desk's folder back into app data. */
export async function makeDeskInternal(state, deskId) {
  if (!IS_TAURI) return false;
  try {
    await invoke("desk_make_internal", { deskId });
  } catch (e) {
    window.alert(`Couldn't make the desk internal:\n${e}`);
    return false;
  }
  await refreshDeskRoots(state);
  return true;
}

/** Pick an existing desk folder (from another install / a synced copy)
 *  and register it as a desk. Returns the adopted desk id or null. */
export async function adoptDeskFolder(state) {
  if (!IS_TAURI) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Open an existing desk folder" });
  if (!picked) return null;
  let deskId = null;
  try {
    deskId = await invoke("desk_adopt_folder", { path: picked });
  } catch (e) {
    window.alert(`Couldn't open that folder as a desk:\n${e}`);
    return null;
  }
  await refreshDeskRoots(state);
  await reloadTree(state);
  // Mirror the desk into the settings registry so the switcher, pickers,
  // and per-desk meta all see it.
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (desk && !(state.settings.desks || []).some((d) => d.id === deskId)) {
    const desks = [...(state.settings.desks || []), { id: deskId, name: desk.name, createdAt: desk.createdAt }];
    const meta = { ...(state.settings.desksMeta || {}), [deskId]: { globalStyleId: null } };
    await state.updateSettings({ desks, desksMeta: meta });
  }
  state.emit("desks-changed");
  if (deskId) await state.setActiveDesk(deskId);
  return deskId;
}

/** Reveal a local desk's folder in the OS file manager. */
export async function revealDeskRoot(state, deskId) {
  const path = state.deskRoots?.[deskId];
  if (!path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(path);
  } catch (e) { console.error("reveal desk folder failed:", e); }
}

/** Run the disk-wins reconcile for one desk and refresh the UI when it
 *  changed anything. Also reloads the open doc's buffer when its on-disk
 *  content moved (identical-content and dirty-buffer cases are both
 *  no-ops inside applyExternalDocContent). */
export async function reconcileDesk(state, deskId) {
  if (!IS_TAURI) return;
  let report = null;
  try {
    report = await invoke("desk_reconcile", { deskId });
  } catch (e) {
    console.warn("desk_reconcile failed:", e);
    return;
  }
  if (report && (report.added > 0 || report.removed > 0)) {
    await reloadTree(state);
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      const bits = [];
      if (report.added) bits.push(`${report.added} added`);
      if (report.removed) bits.push(`${report.removed} removed`);
      appendSyncLog(`Desk folder reconciled: ${bits.join(", ")}`);
    } catch (_) {}
  }
  await maybeReloadOpenDoc(state, deskId);
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

/** Boot wiring: load the roots cache and subscribe to watcher events.
 *  Watcher bursts (a provider syncing many files) coalesce behind a
 *  short debounce per desk. */
export async function installDeskRootsLifecycle(state) {
  if (!IS_TAURI) return;
  await refreshDeskRoots(state);
  const { listen } = await import("@tauri-apps/api/event");
  const timers = new Map();
  await listen("desk-changed", (event) => {
    const deskId = event.payload?.id;
    if (!deskId) return;
    clearTimeout(timers.get(deskId));
    timers.set(deskId, setTimeout(() => {
      timers.delete(deskId);
      reconcileDesk(state, deskId).catch((e) => console.warn("desk reconcile failed:", e));
    }, 400));
  });
}
