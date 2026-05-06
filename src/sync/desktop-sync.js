/**
 * Desktop sync via `.hush/desktop.json`.
 *
 * The "desktop" is a single-slot pointer at the bottom of the files
 * panel — a thumbnail of one chosen doc or notebook, click-to-open.
 * Across devices the local fileId differs (each install mints its own
 * UUIDs), so the wire format carries Dropbox's `remote_id` (cross-
 * device stable) plus the file type. The applier translates remote_id
 * back to a local fileId via the existing sync map.
 *
 * Files that aren't tracked in `synced_files` (no Dropbox identity —
 * Local Sync, never-synced) can't be the desktop on the receiving
 * device, so an unresolvable remote_id clears the desktop slot. The
 * local device keeps its own desktopFileId regardless of whether it's
 * syncable; we only skip the upload step when there's nothing to
 * translate.
 *
 * Legacy: previous versions stored this as `desk.json` with
 * `format: "hush-desk"`. The applier accepts both names so existing
 * Dropbox folders keep working; outbound writes always use the new
 * `desktop.json` filename.
 */

const DESKTOP_FILENAME = "desktop.json";
const FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ===== Outbound =====

async function desktopFileType(state, fileId) {
  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const node = findNodeByFileId(state.fileTree, fileId);
  return node?.type === "notebook" ? "notebook" : "document";
}

export async function serializeDesktop(state) {
  const fileId = state.settings?.desktopFileId || null;
  if (!fileId) {
    return JSON.stringify({ format: "hush-desktop", version: FORMAT_VERSION, remoteFileId: null }, null, 2);
  }
  let remoteFileId = null;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    remoteFileId = info?.remoteId || null;
  } catch (_) { /* ignore — fall through to null */ }

  const fileType = await desktopFileType(state, fileId);
  return JSON.stringify({
    format: "hush-desktop",
    version: FORMAT_VERSION,
    remoteFileId,
    fileType,
    updatedAt: Math.floor(Date.now() / 1000),
  }, null, 2);
}

export async function pushDesktopToDropbox(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  const payload = await serializeDesktop(state);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(DESKTOP_FILENAME, payload);
}

// ===== Inbound =====

export async function applyDesktopFile(state, payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { matched: 0, added: 0, applied: 0, error: "parse" }; }
  if (!parsed || (parsed.format !== "hush-desktop" && parsed.format !== "hush-desk")) {
    return { matched: 0, added: 0, applied: 0, error: "format" };
  }

  // Empty / cleared desktop — null the local slot.
  if (!parsed.remoteFileId) {
    if (state.settings?.desktopFileId) {
      await state.updateSettings({ desktopFileId: null }, { fromSync: true });
      state.emit("desktop-changed", null);
      return { applied: 1 };
    }
    return { applied: 0 };
  }

  // Resolve remoteFileId → local fileId.
  let info = null;
  try { info = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: parsed.remoteFileId }); }
  catch (_) { /* ignore */ }

  // No sync map entry — file isn't tracked locally yet (could land via a
  // later cursor pull). Leave the desktop slot alone rather than clearing
  // user state on an unresolvable id.
  if (!info?.internalId) return { applied: 0 };

  if ((state.settings?.desktopFileId || null) === info.internalId) return { applied: 0 };
  await state.updateSettings({ desktopFileId: info.internalId }, { fromSync: true });
  state.emit("desktop-changed", info.internalId);
  return { applied: 1 };
}

export const DESKTOP_RELATIVE_PATH = `.hush/${DESKTOP_FILENAME}`;
