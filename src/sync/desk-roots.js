/**
 * Local desk roots — the JS face of Phases 3–4 of LOCAL-DESKS-PLANNING.md.
 *
 * A desk can operate from a folder the user picked instead of app data;
 * the Rust side redirects all storage through `roots.json`, arms a
 * filesystem watcher on each root, and reconciles the tree disk-wins
 * when the folder changes underneath us. This module wraps the commands,
 * keeps `state.deskRoots` (deskId → path) cached for UI badges, and owns
 * the `desk-changed` watcher listener.
 *
 * iOS differs in exactly two ways, both handled here: folders are picked
 * through the icloud-folder plugin (which mints a security-scoped
 * bookmark that boot must re-resolve before Rust can touch the folder),
 * and there is no filesystem watcher — every local desk is reconciled
 * when the app comes to the foreground instead.
 */

import { applyExternalDocContent } from "./apply-external.js";
import { isIOSTauri } from "../command-palette-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function plugin(cmd, args) {
  return invoke(`plugin:icloud-folder|${cmd}`, args);
}

/** Present the platform folder picker. Returns
 *  `{ path, bookmark|null }` or null when cancelled. */
async function pickFolder(title) {
  if (isIOSTauri()) {
    try {
      const picked = await plugin("pick_folder");
      return picked ? { path: picked.path, bookmark: picked.bookmark } : null;
    } catch (e) {
      if (String(e).includes("cancelled")) return null;
      throw e;
    }
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return picked ? { path: picked, bookmark: null } : null;
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
  const picked = await pickFolder("Choose a folder for this desk");
  if (!picked) return false;
  try {
    await invoke("desk_make_local", { deskId, targetPath: picked.path, bookmark: picked.bookmark });
  } catch (e) {
    window.alert(`Couldn't make the desk local:\n${e}`);
    return false;
  }
  await refreshDeskRoots(state);
  if (isIOSTauri()) {
    try { await plugin("start_watch", { path: picked.path }); } catch (_) {}
  }
  return true;
}

/** Move a local desk's folder back into app data. */
export async function makeDeskInternal(state, deskId) {
  if (!IS_TAURI) return false;
  const oldPath = state.deskRoots?.[deskId];
  if (oldPath && isIOSTauri()) {
    try { await plugin("stop_watch", { path: oldPath }); } catch (_) {}
  }
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
  const picked = await pickFolder("Open an existing desk folder");
  if (!picked) return null;
  let deskId = null;
  try {
    deskId = await invoke("desk_adopt_folder", { path: picked.path, bookmark: picked.bookmark });
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
  // The adopted .hushdesk carries the desk's portable meta (style
  // choice, last file, stickies) — fold it in over the null seed.
  try {
    const { pullDeskMeta } = await import("./desk-meta.js");
    await pullDeskMeta(state, deskId);
  } catch (_) {}
  if (isIOSTauri()) {
    try { await plugin("start_watch", { path: picked.path }); } catch (_) {}
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
  if (report && (report.added > 0 || report.removed > 0 || report.renamed > 0)) {
    await reloadTree(state);
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      const bits = [];
      if (report.added) bits.push(`${report.added} added`);
      if (report.removed) bits.push(`${report.removed} removed`);
      if (report.renamed) bits.push(`${report.renamed} renamed`);
      appendSyncLog(`Desk folder reconciled: ${bits.join(", ")}`);
    } catch (_) {}
  }
  if (report && report.conflicts > 0) {
    // A sync provider forked the file; Rust kept the newer side and
    // snapshotted both. Tell the user where the other side went.
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      appendSyncLog(`Resolved ${report.conflicts} conflicted cop${report.conflicts === 1 ? "y" : "ies"} — both versions saved to Versions`);
    } catch (_) {}
    try {
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast(
        report.conflicts === 1
          ? "A conflicted copy was resolved — both versions are in the Versions panel"
          : `${report.conflicts} conflicted copies were resolved — all versions are in the Versions panel`,
        "info",
      );
    } catch (_) {}
  }
  // An external change may include the desk's portable meta (style,
  // last file, stickies riding in .hushdesk) — pull it, disk wins.
  try {
    const { pullDeskMeta } = await import("./desk-meta.js");
    await pullDeskMeta(state, deskId);
  } catch (_) {}
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

/** iOS boot: resolve every bookmarked root, which re-acquires
 *  security-scoped access (so plain Rust std::fs works on the folder for
 *  the rest of the run) and can surface a different container path than
 *  the one stored — repoint roots.json when it does. */
async function resolveBookmarkedRoots() {
  let entries = {};
  try {
    entries = await invoke("desk_list_root_entries") || {};
  } catch (e) {
    console.warn("desk_list_root_entries failed:", e);
    return;
  }
  for (const [deskId, entry] of Object.entries(entries)) {
    if (!entry?.bookmark) continue;
    try {
      const res = await plugin("resolve_bookmark", { bookmark: entry.bookmark });
      if (res?.stale) console.warn("desk root bookmark is stale:", deskId);
      if (res?.path && res.path !== entry.path) {
        await invoke("desk_update_root_path", { deskId, path: res.path });
      }
    } catch (e) {
      console.warn(`couldn't re-open local desk folder for ${deskId}:`, e);
    }
  }
}

/** Reconcile every local desk — the iOS baseline in place of the
 *  desktop filesystem watcher, run at boot and on each return to
 *  foreground. */
async function reconcileAllLocalDesks(state) {
  for (const deskId of Object.keys(state.deskRoots || {})) {
    await reconcileDesk(state, deskId).catch((e) => console.warn("desk reconcile failed:", e));
  }
}

/** iOS live updates: an NSMetadataQuery per local desk root makes
 *  iCloud-synced changes land while the app is frontmost, instead of
 *  waiting for the next foreground reconcile. Non-iCloud provider
 *  folders emit nothing — the foreground reconcile stays the fallback
 *  for those. Errors are quietly ignored for the same reason. */
async function armIOSLiveUpdates(state) {
  const timers = new Map();
  try {
    const { addPluginListener } = await import("@tauri-apps/api/core");
    await addPluginListener("icloud-folder", "watch-changed", (payload) => {
      const path = payload?.path;
      if (!path) return;
      const deskId = Object.keys(state.deskRoots || {})
        .find((id) => state.deskRoots[id] === path);
      if (!deskId) return;
      clearTimeout(timers.get(deskId));
      timers.set(deskId, setTimeout(() => {
        timers.delete(deskId);
        reconcileDesk(state, deskId).catch(() => {});
      }, 400));
    });
  } catch (e) {
    console.warn("desk live-update listener failed:", e);
    return;
  }
  for (const path of Object.values(state.deskRoots || {})) {
    try {
      await plugin("start_watch", { path });
    } catch (_) { /* non-iCloud folder or older plugin — fallback covers it */ }
  }
}

/** Boot wiring: load the roots cache and subscribe to change signals —
 *  the per-root filesystem watcher on desktop (bursts coalesce behind a
 *  short debounce per desk), foreground reconcile on iOS. */
export async function installDeskRootsLifecycle(state) {
  if (!IS_TAURI) return;
  const { pullAllDeskMeta } = await import("./desk-meta.js");
  if (isIOSTauri()) {
    await resolveBookmarkedRoots();
    await refreshDeskRoots(state);
    await pullAllDeskMeta(state);
    await reconcileAllLocalDesks(state);
    await armIOSLiveUpdates(state);
    let last = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 2000) return; // fold rapid app-switch bounces
      last = now;
      reconcileAllLocalDesks(state).catch(() => {});
    });
    return;
  }
  await refreshDeskRoots(state);
  await pullAllDeskMeta(state);
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
