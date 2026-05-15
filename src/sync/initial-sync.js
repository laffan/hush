/**
 * Initial-sync flows — preview + bulk push/pull when the user first
 * connects Dropbox. Once `performInitialSync` has run, ongoing sync
 * goes through the cursor delta + op-log paths in sync-state.js /
 * sync-polling.js / op-log.js. Extracted from sync-state.js to keep
 * that file under the line-limit cap.
 */

import { uploadImage, downloadImage, insertImageIntoTree } from "./sync-images.js";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { buildSyncManifest } from "./sync-state.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function isNotebookPath(p) { return p.endsWith(".hushnote"); }

async function uploadContent(dbx, fullPath, content, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(content);
    return dbx.uploadBinary(fullPath, zipData);
  }
  return dbx.uploadFile(fullPath, content);
}

async function downloadContent(dbx, dropboxPath, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { unpackNotebook } = await import("./notebook-sync.js");
    const zipData = await dbx.downloadBinary(dropboxPath);
    return unpackNotebook(zipData);
  }
  return dbx.downloadFile(dropboxPath);
}

function serverModifiedSecs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * Generate a sync preview: what will be uploaded and what will be downloaded.
 */
export async function generateSyncPreview(state, dropboxPath) {
  if (!IS_TAURI) return { toUpload: [], toDownload: [], unchanged: 0 };

  const dbx = await import("./dropbox.js");
  const manifest = buildSyncManifest(state.fileTree);

  let remoteEntries = [];
  try {
    remoteEntries = await dbx.listFolderRecursive(dropboxPath === "/" ? "" : dropboxPath);
  } catch (e) {
    if (!String(e).includes("not_found")) throw e;
  }

  const remotePaths = new Set(remoteEntries.filter(e => !e.isDirectory).map(e => e.relativePath));
  const localPaths = new Set(manifest.files.map(f => f.relativePath));

  const toUpload = manifest.files
    .filter(f => !remotePaths.has(f.relativePath))
    .map(f => ({ relativePath: f.relativePath, type: f.type }));

  const toDownload = remoteEntries
    .filter(e => !e.isDirectory && !localPaths.has(e.relativePath) && e.tag !== "hushproject")
    .map(e => ({ relativePath: e.relativePath, tag: e.tag || "md" }));

  const unchanged = manifest.files.filter(f => remotePaths.has(f.relativePath)).length;

  return { toUpload, toDownload, unchanged };
}

/**
 * Perform initial full sync — push local to Dropbox, pull new Dropbox files.
 * Returns { uploaded: string[], downloaded: string[] } with filenames.
 *
 * The cursor seed runs immediately after this returns; for that to
 * recognize our just-uploaded / just-downloaded entries (and skip
 * them via echo suppression instead of re-creating duplicates), we
 * register every file with `register_synced_file_full` carrying the
 * Dropbox `id` + `rev`.
 */
export async function performInitialSync(state, dropboxPath) {
  if (!IS_TAURI) return { uploaded: [], downloaded: [] };
  const dbx = await import("./dropbox.js");

  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const manifest = buildSyncManifest(state.fileTree);
  const uploaded = [];
  const downloaded = [];

  if (basePath) await dbx.createFolder(basePath).catch(() => {});

  // List Dropbox first so the upload phase can detect collisions and
  // suffix the local name instead of clobbering a remote file with the
  // same path.
  let remoteEntries = [];
  try { remoteEntries = await dbx.listFolderRecursive(basePath || ""); } catch (_) {}
  const remoteByPath = new Map();
  for (const e of remoteEntries) {
    if (!e.isDirectory && e.relativePath) remoteByPath.set(e.relativePath, e);
  }

  for (const dir of manifest.directories) {
    const fullDir = basePath ? `${basePath}/${dir}` : `/${dir}`;
    await dbx.createFolder(fullDir).catch(() => {});
  }

  // Upload local files. If a remote entry already lives at the same
  // path, suffix the local name so we don't overwrite Dropbox's copy
  // (the original remote will still come down via the download phase
  // below as a separate file).
  for (const file of manifest.files) {
    if (file.type === "image" && file.fileId) {
      const fullPath = basePath ? `${basePath}/${file.relativePath}` : `/${file.relativePath}`;
      try {
        await uploadImage(dbx, fullPath, file.fileId);
        uploaded.push(file.relativePath);
        await tauriInvoke("register_synced_image", {
          filename: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: file.relativePath,
        });
      } catch (e) { console.error(`Image upload failed for ${file.relativePath}:`, e); }
      continue;
    }
    let content = file.content || "";
    if ((file.type === "md" || file.type === "hushnote") && file.fileId) {
      try {
        const fileData = await tauriInvoke("load_file", { id: file.fileId });
        content = fileData.content || "";
      } catch (_) { continue; }
    }
    let path = file.relativePath;
    if (remoteByPath.has(path)) {
      path = uniqueRemotePath(path, remoteByPath);
      if (file.fileId) {
        const baseName = path.split("/").pop().replace(/\.(md|hushnote)$/, "");
        const node = findNodeByFileId(state.fileTree, file.fileId);
        if (node) node.name = baseName;
        try { await tauriInvoke("rename_file", { id: file.fileId, name: baseName }); } catch (_) {}
      }
    }
    const fullPath = basePath ? `${basePath}/${path}` : `/${path}`;
    try {
      const resp = await uploadContent(dbx, fullPath, content, path);
      uploaded.push(path);
      if (file.fileId) {
        await tauriInvoke("register_synced_file_full", {
          internalId: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: path, content,
          remoteId: resp?.id || "",
          rev: resp?.rev || "",
          syncedAt: serverModifiedSecs(resp?.server_modified) || Math.floor(Date.now() / 1000),
        });
      }
      remoteByPath.set(path, { relativePath: path });
    } catch (e) { console.error(`Upload failed for ${path}:`, e); }
  }

  // Pull remotes that aren't in our manifest. Register with full
  // payload so the cursor seed echo-suppresses these on its first pass.
  const manifestPaths = new Set(manifest.files.map(f => f.relativePath));
  for (const entry of remoteEntries) {
    if (entry.isDirectory || !entry.dropboxPath) continue;
    if (entry.tag === "hushproject") continue;
    if (manifestPaths.has(entry.relativePath)) continue;

    if (entry.tag === "image") {
      try {
        const finalName = await downloadImage(dbx, entry.dropboxPath, entry.name);
        await tauriInvoke("register_synced_image", {
          filename: finalName, syncFolderId: SYNC_FOLDER_ID,
          relativePath: entry.relativePath,
        });
        // Route to the desk implied by the path's first segment, if any.
        const parts = entry.relativePath.split("/");
        let preferDeskId = null;
        if (parts.length >= 2) {
          const deskNode = (state.fileTree || []).find(
            (n) => n.type === "desk" && n.name === parts[0]
          );
          if (deskNode) preferDeskId = deskNode.id;
        }
        insertImageIntoTree(state.fileTree, finalName, preferDeskId);
        downloaded.push(entry.relativePath);
      } catch (e) { console.error(`Image download failed for ${entry.relativePath}:`, e); }
      continue;
    }

    try {
      const content = await downloadContent(dbx, entry.dropboxPath, entry.relativePath);
      const file = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: file.id, content });
      await tauriInvoke("register_synced_file_full", {
        internalId: file.id, syncFolderId: SYNC_FOLDER_ID,
        relativePath: entry.relativePath, content,
        remoteId: entry.id || "",
        rev: entry.rev || "",
        syncedAt: serverModifiedSecs(entry.modified) || Math.floor(Date.now() / 1000),
      });
      insertIntoTree(state.fileTree, entry.relativePath, file.id, entry.name);
      downloaded.push(entry.relativePath);
    } catch (e) { console.error(`Download failed for ${entry.relativePath}:`, e); }
  }

  await state.saveFileTree();
  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
  return { uploaded, downloaded };
}

/** Pick a "Foo (2).md"-style suffix that doesn't collide with anything
 *  in `remoteByPath`. Increments the integer until free. */
function uniqueRemotePath(relativePath, remoteByPath) {
  const m = relativePath.match(/^(.*?)(\.(?:md|hushnote))$/);
  const stem = m ? m[1] : relativePath;
  const ext = m ? m[2] : "";
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!remoteByPath.has(candidate)) return candidate;
  }
  return relativePath;
}

/**
 * Insert a downloaded file into the file tree, merging with existing
 * folders/projects (including special nodes like Inbox and Trash).
 * Creates intermediate folder nodes only if no match exists.
 * Trash is always kept as the last item.
 */
function insertIntoTree(fileTree, relativePath, fileId, displayName) {
  const parts = relativePath.split("/");
  const rawFileName = parts.pop();
  const isNotebook = rawFileName.endsWith(".hushnote");
  const fileName = rawFileName.replace(/\.(md|hushnote)$/, "");
  let current = fileTree;

  const isInboxNode = (n) => n.id === "__inbox__" || n.id?.startsWith("__inbox__:");
  const isTrashNode = (n) => n.id === "__trash__" || n.id?.startsWith("__trash__:");
  for (const dirName of parts) {
    if (!dirName) continue;
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(isInboxNode))
      || (dirName === "Trash" && current.find(isTrashNode));
    if (!folder) {
      folder = {
        id: crypto.randomUUID(), type: "folder", name: dirName,
        children: [], flagged: false,
      };
      const trashIdx = current.findIndex(n => isTrashNode(n) || n.name === "Trash");
      if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
      else current.push(folder);
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }

  if (current.some(n => n.fileId === fileId)) return;

  const trashIdx = current.findIndex(n => isTrashNode(n) || n.name === "Trash");
  const node = {
    id: crypto.randomUUID(), type: isNotebook ? "notebook" : "document",
    name: displayName || fileName, fileId,
    children: [], flagged: false,
  };
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}
