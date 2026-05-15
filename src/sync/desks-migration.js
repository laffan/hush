/**
 * Dropbox layout migration for the Desks feature.
 *
 * When the boot-time always-on migration runs on a device that
 * previously synced under the flat layout, every top-level synced
 * file has to be moved under `<DeskName>/...` on Dropbox so the remote
 * layout matches the new local tree shape.
 *
 * Each move is enqueued through the existing op-log so the drain
 * worker handles retries, idempotency, and ordering. Local sync map
 * paths update through `rename_sync_file` as the moves succeed (the
 * cursor delta will see the rev unchanged for our own writes and skip).
 *
 * The migration is local-first: callers run it after `enableDesks`
 * has already mutated the local tree. Cross-device sync of the desk
 * list itself rides `.hush/desks.json`; the receiving device performs
 * the local tree wrap (no Dropbox writes, since the source device
 * already pushed the moves).
 */

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Move every top-level synced path under `<deskName>/`. Skips paths
 *  that already start with the prefix (idempotent). */
export async function migrateSyncToDesk(state, deskName) {
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return { moved: 0 };
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
