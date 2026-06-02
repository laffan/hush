/**
 * Dropbox sync for doc images.
 *
 * Image binaries live under `{data_dir}/files/images/{filename}` locally
 * and round-trip through Dropbox at `{basePath}/Images/{filename}` —
 * mirroring the pinned `__images__` folder so the Dropbox layout reads
 * exactly the same as Hush's tree. Filenames *are* the stable id, so the
 * sync map keys image entries by filename rather than UUID.
 *
 * The image surface intentionally bypasses the per-file content-poll loop
 * in `checkDropboxChanges` because filenames auto-suffix on collision —
 * which means an image is immutable once written. Creates and deletes
 * are the only state changes worth tracking, and those flow through
 * `syncCreateImage` / `syncDeleteImage` (called from `state-images.js`
 * and `state-tree.js`) plus `diffDropboxSync` (in `sync-state.js`).
 */

import { appendSyncError } from "./sync-feedback.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export const IMAGES_NODE_ID = "__images__";
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "bmp", "heic", "heif", "avif", "tif", "tiff",
];

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export function isImageFilename(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/** Convert an ArrayBuffer (Dropbox download) into a plain number array
 *  for Tauri IPC. Tauri 2 serializes Vec<u8> command args as JSON arrays. */
export function bufferToBytes(buffer) {
  return Array.from(new Uint8Array(buffer));
}

/** Upload an image binary to Dropbox by reading bytes from local storage. */
export async function uploadImage(dbx, fullPath, filename) {
  const bytes = await tauriInvoke("load_image_bytes", { filename });
  const buffer = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return dbx.uploadBinary(fullPath, buffer);
}

/** Download an image binary from Dropbox and persist locally. Returns
 *  the final filename (auto-suffixed on collision). */
export async function downloadImage(dbx, dropboxPath, requestedFilename) {
  const buffer = await dbx.downloadBinary(dropboxPath);
  const saved = await tauriInvoke("save_image_bytes", {
    filename: requestedFilename,
    bytes: bufferToBytes(buffer),
  });
  return saved.filename;
}

/**
 * Drop a downloaded image into an Images folder. With desks on, walks
 * the tree for any `__images__:<deskId>` node (preferring `preferDeskId`
 * if supplied, falling back to the first match). With desks off, falls
 * back to the bare `__images__` legacy id. Skips when no folder is
 * found or when an entry with the same fileId is already there.
 */
export function insertImageIntoTree(fileTree, filename, preferDeskId = null) {
  const images = findImagesFolder(fileTree, preferDeskId);
  if (!images) return;
  if (!Array.isArray(images.children)) images.children = [];
  if (images.children.some((c) => c.type === "image" && c.fileId === filename)) return;
  images.children.push({
    id: crypto.randomUUID(),
    type: "image",
    name: filename,
    fileId: filename,
    children: [],
    flagged: false,
  });
}

/** Locate the Images folder for `preferDeskId` (when set), else the
 *  first `__images__:<deskId>` we see, else the legacy bare-id node. */
function findImagesFolder(fileTree, preferDeskId) {
  function walk(nodes, predicate) {
    for (const n of nodes || []) {
      if (predicate(n)) return n;
      const hit = walk(n.children, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (preferDeskId) {
    const wanted = `__images__:${preferDeskId}`;
    const hit = walk(fileTree, (n) => n.id === wanted);
    if (hit) return hit;
  }
  const anyPerDesk = walk(fileTree, (n) => typeof n.id === "string" && n.id.startsWith("__images__:"));
  if (anyPerDesk) return anyPerDesk;
  return walk(fileTree, (n) => n.id === IMAGES_NODE_ID);
}

/** Return the name of the desk that owns `preferDeskId`, or the active
 *  desk if `preferDeskId` is null. Returns "" when desks are off. */
function deskFolderNameForState(state, preferDeskId) {
  const tree = state?.fileTree || [];
  const id = preferDeskId || state?.settings?.activeDeskId || null;
  if (!id) {
    const anyDesk = tree.find((n) => n.type === "desk");
    return anyDesk?.name || "";
  }
  const match = tree.find((n) => n.type === "desk" && n.id === id);
  return match?.name || "";
}

/**
 * Push a newly-created local image to Dropbox. Called from
 * `state-images.js::createImageFromFile` after the image binary lands
 * on disk and the tree node is added.
 *
 * With desks on, the image lands under `<DeskName>/Images/<filename>`
 * so the Dropbox layout mirrors the per-desk `__images__:<deskId>`
 * tree node. With desks off (or before the first desk is created), it
 * falls back to top-level `Images/<filename>`.
 */
export async function syncCreateImage(state, filename, ownerDeskId = null) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath || !filename) return;

  const dbx = await import("./dropbox.js");
  const { SYNC_FOLDER_ID } = await import("./sync-state.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const deskName = deskFolderNameForState(state, ownerDeskId);
  const relPath = deskName ? `${deskName}/Images/${filename}` : `Images/${filename}`;
  const fullPath = basePath ? `${basePath}/${relPath}` : `/${relPath}`;

  try {
    const imagesDirRel = deskName ? `${deskName}/Images` : `Images`;
    const imagesDirFull = basePath ? `${basePath}/${imagesDirRel}` : `/${imagesDirRel}`;
    await dbx.createFolder(imagesDirFull).catch(() => {});
    await uploadImage(dbx, fullPath, filename);
    await tauriInvoke("register_synced_image", {
      filename, syncFolderId: SYNC_FOLDER_ID, relativePath: relPath,
    });
  } catch (e) {
    appendSyncError(`Image sync upload failed for ${filename}: ${e?.message || e}`);
  }
}

/**
 * Propagate a local image deletion to Dropbox. The on-disk binary should
 * already be gone by the time this runs (callers handle that via
 * `delete_image`); this just removes the Dropbox copy + sync mapping.
 */
export async function syncDeleteImage(state, filename) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath || !filename) return;

  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const info = await tauriInvoke("get_sync_file_info", { internalId: filename }).catch(() => null);
  const relPath = info?.relativePath || `Images/${filename}`;
  const fullPath = basePath ? `${basePath}/${relPath}` : `/${relPath}`;

  try { await dbx.deleteEntry(fullPath); } catch (_) {}
  await tauriInvoke("unregister_synced_image", { filename }).catch(() => {});
}
