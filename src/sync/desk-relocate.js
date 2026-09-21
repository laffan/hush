/**
 * Renaming and moving a local desk's folder.
 *
 * A local desk *is* its folder — the folder's name is the desk's name
 * (`desk-roots.js#adoptFolderName`) and the folder's path is where every
 * byte lives. So until these two existed there was no way back from a
 * typo in that name, or from saving the folder somewhere you didn't
 * mean: the only route was to delete the desk from Hush, fix the folder
 * in Finder, and adopt it again as a new desk.
 *
 * Both operations flush every unsaved surface first. An autosave landing
 * in the old folder while its contents are on their way to a new one is
 * the one write nothing downstream can recover, and it costs a few
 * hundred milliseconds to make impossible.
 *
 * Rust owns the risky half — it takes a census of the folder, performs
 * the move, censuses the destination, and rolls back rather than report
 * a relocation that lost a file (`desk_relocate.rs`). This module owns
 * the picker, the watch handoff, the desk's name, and telling the user.
 *
 * **Rename is desktop-only.** Renaming a folder writes to its *parent*
 * directory, and iOS grants a security scope for the picked folder, not
 * for what contains it. Move works on both, because the picker hands
 * back a scope for the folder it returns.
 */

import { isIOSTauri } from "../command-palette-helpers.js";
import { logActivity } from "../activity-log.js";
import {
  pickFolder, folderName, refreshDeskRoots, setIosFolderWatch,
} from "./desk-roots.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Write out everything unsaved before the folder moves under it. */
async function settle(state, reason) {
  try {
    const { flushEverythingNow } = await import("../state/background-flush.js");
    await flushEverythingNow(state, reason);
  } catch (e) {
    logActivity("desks", "warn", "Couldn't flush before relocating a desk folder", { error: String(e) });
  }
}

/**
 * Rename a local desk's folder in place, then take the desk's name from
 * what actually landed on disk. Throws with a message fit to show the
 * user; the caller decides how to surface it (the rename paths all run
 * through `state.renameDesk`, which reports through their own UI).
 */
export async function renameLocalDeskFolder(state, deskId, newName) {
  if (!IS_TAURI) return null;
  const root = state.deskRoots?.[deskId];
  if (!root) throw new Error("This desk doesn't live in a folder on disk.");
  if (isIOSTauri()) {
    throw new Error(
      "On iPad the folder can't be renamed from inside Hush — use Move Local Folder to put the desk somewhere new, or rename it in the Files app.",
    );
  }
  await settle(state, "desk-folder-rename");
  let newPath;
  try {
    newPath = await invoke("desk_rename_local_root", { deskId, newName });
  } catch (e) {
    logActivity("desks", "error", "Renaming a local desk folder failed",
      { deskId, from: root, to: newName, error: String(e) });
    throw new Error(String(e?.message || e));
  }
  await refreshDeskRoots(state);
  // The folder names the desk, and the folder is what just changed —
  // read the name back off the path Rust reports rather than the one we
  // asked for, so a name it had to clean up doesn't leave the two
  // disagreeing.
  await state.renameDesk(deskId, folderName(newPath), { force: true });
  logActivity("desks", "info", `Renamed the desk folder to "${folderName(newPath)}"`,
    { deskId, from: root, to: newPath });
  return newPath;
}

/**
 * Move a local desk's folder to somewhere the user picks. The picked
 * folder becomes the desk's folder (and so its name), matching
 * **Make Desk Local…**: it has to be empty, or not exist yet.
 *
 * Returns the new path, or null when the user backed out. Failures are
 * reported here — every caller is a menu entry with nowhere better to
 * put the message.
 */
export async function moveLocalDeskFolder(state, deskId) {
  if (!IS_TAURI) return null;
  const oldPath = state.deskRoots?.[deskId];
  if (!oldPath) {
    window.alert("This desk doesn't live in a folder on disk, so there's nothing to move.");
    return null;
  }
  const picked = await pickFolder("Choose an empty folder to move this desk into");
  if (!picked) return null;

  await settle(state, "desk-folder-move");
  await setIosFolderWatch(oldPath, false);
  let newPath;
  try {
    newPath = await invoke("desk_move_local_root", {
      deskId, targetPath: picked.path, bookmark: picked.bookmark,
    });
  } catch (e) {
    // Rust rolled the move back, so the desk is still where it was —
    // put its watch back with it before anything else runs.
    await setIosFolderWatch(oldPath, true);
    logActivity("desks", "error", "Moving a local desk folder failed",
      { deskId, from: oldPath, to: picked.path, error: String(e) });
    window.alert(`Couldn't move the desk's folder:\n${e}\n\nThe desk is still in its old folder.`);
    return null;
  }
  await refreshDeskRoots(state);
  await setIosFolderWatch(newPath, true);
  // The desk is named by the folder it lives in, and it lives somewhere
  // else now.
  await state.renameDesk(deskId, folderName(newPath), { force: true });
  logActivity("desks", "info", `Moved the desk to "${folderName(newPath)}"`,
    { deskId, from: oldPath, to: newPath });
  return newPath;
}
