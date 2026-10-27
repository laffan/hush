/**
 * Desk backups, JS side — hourly zips of a desk written to a folder the
 * user chose (Rust: desk_backup.rs, desk_backup_restore.rs). The
 * scheduler runs entirely in Rust; this module sets each desk's folder,
 * runs "Backup Desk Now", and re-opens iOS backup folders at boot.
 *
 * The folder is per device (`{data_dir}/desk-backups.json`), so it isn't
 * a setting and doesn't ride the desk: a path on this machine means
 * nothing on another one. On iOS a folder outside the app container is
 * reachable only through the picker's security-scoped bookmark, which
 * is stored beside the path and resolved at boot like a local desk's.
 */

import { isIOSTauri } from "../command-palette-helpers.js";
import { logActivity } from "../activity-log.js";
import { showImportToast } from "../editor/import-toast.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

export function backupsAvailable() {
  return IS_TAURI;
}

/** `{ path, bookmark? }` for the desk, or null when backups are off. */
export async function getBackupTarget(deskId) {
  if (!IS_TAURI || !deskId) return null;
  try {
    const targets = await invoke("desk_backup_targets");
    return targets?.[deskId] || null;
  } catch (e) {
    console.warn("desk_backup_targets failed:", e);
    return null;
  }
}

/** The folder to offer by default: the last one chosen, else
 *  Documents/Hush Backups. */
export async function defaultBackupFolder() {
  if (!IS_TAURI) return "";
  try { return await invoke("desk_backup_default_folder"); }
  catch { return ""; }
}

/** The platform folder picker. `{ path, bookmark|null }`, or null. */
export async function chooseBackupFolder() {
  const { pickFolder } = await import("./desk-roots.js");
  return pickFolder("Choose a folder for desk backups");
}

/** Turn a desk's backups on into `target` (`{ path, bookmark? }`), or
 *  off with null. Throws Rust's refusal (a folder inside the desk or
 *  inside app data) for the caller to show. */
export async function setDeskBackupTarget(deskId, target) {
  await invoke("desk_backup_set_target", {
    deskId,
    path: target?.path || null,
    bookmark: target?.bookmark || null,
  });
  logActivity("desks", "info", target ? "Desk backups on" : "Desk backups off", { deskId, path: target?.path || null });
}

/** Save whatever is unsaved on screen so the zip carries the last
 *  keystroke rather than the last autosave tick. */
async function flushOpenSurfaces(state) {
  try {
    if (state.dirty) await state.saveCurrentFile();
    if (state.currentNotebookFileId) {
      const { saveNotebook } = await import("../notebook/notebook-bridge.js");
      await saveNotebook();
    }
  } catch (e) {
    logActivity("desks", "warn", "Flush before backup failed", { error: String(e) });
  }
}

/** Back the desk up now. Resolves to the backup's info, or null when it
 *  failed (which it says in a toast). */
export async function backupDeskNow(state, deskId) {
  await flushOpenSurfaces(state);
  showImportToast("Backing up desk…", "info", { sticky: true });
  try {
    const info = await invoke("desk_backup_now", { deskId });
    // A new toast replaces the sticky one.
    showImportToast(`Backed up "${info.name}" — ${info.files} file${info.files === 1 ? "" : "s"}`, "success");
    logActivity("desks", "info", "Backed up desk", info);
    return info;
  } catch (e) {
    showImportToast(`Backup failed: ${e?.message || e}`, "error");
    logActivity("desks", "error", "Desk backup failed", { deskId, error: String(e) });
    return null;
  }
}

/** iOS boot: re-acquire access to every bookmarked backup folder, so the
 *  Rust scheduler can write into it for the rest of the run. Desktop
 *  folders need nothing. Best-effort — a folder that won't open costs
 *  backups until it does, which the scheduler's log line says. */
export async function acquireBackupFolderAccess() {
  if (!IS_TAURI || !isIOSTauri()) return;
  let targets = {};
  try { targets = await invoke("desk_backup_targets") || {}; }
  catch { return; }
  for (const [deskId, target] of Object.entries(targets)) {
    if (!target?.bookmark) continue;
    try {
      const res = await invoke("plugin:icloud-folder|resolve_bookmark", { bookmark: target.bookmark });
      if (res?.path && res.path !== target.path) {
        await invoke("desk_backup_set_target", { deskId, path: res.path, bookmark: target.bookmark });
      }
    } catch (e) {
      logActivity("desks", "warn", "Couldn't re-open a desk backup folder", { deskId, error: String(e) });
    }
  }
}
