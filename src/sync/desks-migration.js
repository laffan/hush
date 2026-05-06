/**
 * Dropbox layout migrations for the Desks feature.
 *
 * When the user toggles desks on, every existing top-level synced
 * file has to be moved under `<DeskName>/...` on Dropbox so the remote
 * layout matches the new local tree shape. Toggling off reverses it
 * (with the Inbox / Images / Trash subfolders folded into the global
 * specials).
 *
 * Each move is enqueued through the existing op-log so the drain
 * worker handles retries, idempotency, and ordering. Local sync map
 * paths update through `rename_sync_file` as the moves succeed (the
 * cursor delta will see the rev unchanged for our own writes and skip).
 *
 * The migration is local-first: callers run it after `enableDesks` /
 * `disableDesks` have already mutated the local tree. Cross-device
 * sync of the `useDesks` flag itself rides `.hush/desks.json`; the
 * receiving device performs the local tree wrap (no Dropbox writes,
 * since the source device already pushed the moves).
 */

const SPECIAL_FOLDER_NAMES = new Set(["Inbox", "Images", "Trash"]);

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Move every top-level synced path under `<deskName>/`. Skips paths
 *  that already start with the prefix (idempotent). */
export async function migrateSyncToDesk(state, deskName) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return { moved: 0 };
  if (!deskName) return { moved: 0 };
  const prefix = deskName + "/";
  const files = await getSyncedFiles();
  if (files.length === 0) return { moved: 0 };

  const { enqueueRename } = await import("./op-log.js");
  let moved = 0;
  for (const f of files) {
    const oldPath = f.relativePath || "";
    if (!oldPath || oldPath.startsWith(prefix)) continue;
    const newPath = prefix + oldPath;
    try {
      await enqueueRename({ internalId: f.internalId, fromPath: oldPath, toPath: newPath });
      await renameSyncFile(state, f.internalId, oldPath, newPath);
      moved += 1;
    } catch (e) {
      console.warn("desk migration: rename enqueue failed for", oldPath, e);
    }
  }
  triggerDrain(state);
  return { moved };
}

/** Reverse of `migrateSyncToDesk`. For every desk represented in the
 *  current sync map (paths that start with `<deskName>/`), strip the
 *  prefix on Inbox / Images / Trash subfolders so the contents merge
 *  into the global specials, and leave the rest under a top-level
 *  folder named after the desk.
 *
 *  When there's exactly one desk, the desk prefix is stripped entirely
 *  so all content unwraps to the root.
 */
export async function migrateSyncFromDesks(state, deskList) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return { moved: 0 };
  if (!Array.isArray(deskList) || deskList.length === 0) return { moved: 0 };

  const { enqueueRename } = await import("./op-log.js");
  const files = await getSyncedFiles();
  let moved = 0;
  const isSingleDesk = deskList.length === 1;

  for (const desk of deskList) {
    const prefix = (desk.name || "Untitled desk") + "/";
    for (const f of files) {
      const oldPath = f.relativePath || "";
      if (!oldPath.startsWith(prefix)) continue;
      const rest = oldPath.slice(prefix.length);
      // Path under one of the desk's special folders → land in the
      // matching global special. Anything else: hoist to root if this
      // is the only desk, otherwise keep the desk prefix as a folder.
      const firstSegment = rest.split("/")[0];
      let newPath;
      if (SPECIAL_FOLDER_NAMES.has(firstSegment)) {
        newPath = rest;
      } else if (isSingleDesk) {
        newPath = rest;
      } else {
        newPath = prefix + rest; // unchanged: stays in the (now) folder
      }
      if (newPath === oldPath) continue;
      try {
        await enqueueRename({ internalId: f.internalId, fromPath: oldPath, toPath: newPath });
        await renameSyncFile(state, f.internalId, oldPath, newPath);
        moved += 1;
      } catch (e) {
        console.warn("desk migration (off): rename enqueue failed for", oldPath, e);
      }
    }
  }
  triggerDrain(state);
  return { moved };
}

async function getSyncedFiles() {
  try { return await tauriInvoke("get_synced_files", { syncFolderId: "__dropbox_sync__" }) || []; }
  catch (e) { console.warn("get_synced_files failed:", e); return []; }
}

async function renameSyncFile(state, internalId, oldPath, newPath) {
  try {
    await tauriInvoke("rename_sync_file", {
      folderPath: state.settings.dropboxSyncPath || "",
      oldRelative: oldPath,
      newRelative: newPath,
      internalId,
    });
  } catch (e) {
    console.warn("rename_sync_file failed:", e);
  }
}

async function triggerDrain(state) {
  try {
    const m = await import("./op-log.js");
    if (typeof m.triggerDrain === "function") m.triggerDrain(state);
  } catch (_) { /* ignore */ }
}
