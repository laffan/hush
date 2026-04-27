/**
 * Per-tree-node Dropbox sync mutations: rename, delete, create folder/
 * project, create file, project-ordering refresh. These fire from the
 * sidebar / state layer immediately after the local change so the
 * Dropbox copy stays current without waiting for the polling cycle.
 *
 * Bulk operations (initial sync, polling diff, conflict reconciliation)
 * live in sync-state.js; image-specific mutations live in sync-images.js.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function extensionForType(nodeType) {
  return nodeType === "notebook" ? ".hushnote" : ".md";
}

function isNotebookPath(relativePath) {
  return relativePath.endsWith(".hushnote");
}

async function uploadContent(dbx, fullPath, content, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(content);
    return dbx.uploadBinary(fullPath, zipData);
  }
  return dbx.uploadFile(fullPath, content);
}

/**
 * Propagate a rename to Dropbox.
 */
export async function syncRenameNode(state, nodeId, oldName, nodeType) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;

  try {
    if (nodeType === "document" || nodeType === "notebook") {
      const node = findNode(state.fileTree, nodeId);
      if (!node?.fileId) return;
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (!info) return;
      const pathParts = info.relativePath.split("/");
      pathParts[pathParts.length - 1] = node.name + extensionForType(nodeType);
      const newRelPath = pathParts.join("/");
      if (newRelPath === info.relativePath) return; // no actual rename needed
      const oldFull = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
      const newFull = basePath ? `${basePath}/${newRelPath}` : `/${newRelPath}`;
      try {
        await dbx.moveEntry(oldFull, newFull);
      } catch (_) {
        // 409 = conflict — file already at destination. Update map anyway.
        const meta = await dbx.getMetadata(newFull).catch(() => null);
        if (!meta) return;
      }
      await tauriInvoke("rename_sync_file", {
        folderPath: "__dropbox__", oldRelative: info.relativePath,
        newRelative: newRelPath, internalId: node.fileId,
      }).catch(() => {});
    } else {
      const ctx = findSyncContext(state.fileTree, nodeId);
      if (!ctx || !ctx.relativePath) return;
      const parts = ctx.relativePath.split("/");
      parts[parts.length - 1] = oldName;
      const oldRelPath = parts.join("/");
      if (oldRelPath === ctx.relativePath) return; // no actual rename needed
      const oldFull = basePath ? `${basePath}/${oldRelPath}` : `/${oldRelPath}`;
      const newFull = basePath ? `${basePath}/${ctx.relativePath}` : `/${ctx.relativePath}`;
      try {
        await dbx.moveEntry(oldFull, newFull);
      } catch (_) {
        const meta = await dbx.getMetadata(newFull).catch(() => null);
        if (!meta) return;
      }
      await tauriInvoke("rename_sync_directory", {
        folderPath: "__dropbox__", oldRelative: oldRelPath,
        newRelative: ctx.relativePath, syncFolderId: SYNC_FOLDER_ID,
      }).catch(() => {});
    }
  } catch (e) {
    console.error("Sync rename failed:", e);
  }
}

/**
 * Propagate a delete to Dropbox.
 */
export async function syncDeleteNode(state, nodeId) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const { findNode, findSyncContext } = await import("../state/tree-helpers.js");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;

  try {
    if ((node.type === "document" || node.type === "notebook") && node.fileId) {
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (info) {
        const fullPath = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
        await dbx.deleteEntry(fullPath).catch(() => {});
        await tauriInvoke("delete_sync_file", { folderPath: "__dropbox__", internalId: node.fileId });
      }
    } else {
      const ctx = findSyncContext(state.fileTree, nodeId);
      if (ctx && ctx.relativePath) {
        const fullPath = basePath ? `${basePath}/${ctx.relativePath}` : `/${ctx.relativePath}`;
        await dbx.deleteEntry(fullPath).catch(() => {});
        await tauriInvoke("delete_sync_directory", {
          folderPath: "__dropbox__", relativePath: ctx.relativePath,
          syncFolderId: SYNC_FOLDER_ID,
        });
      }
    }
  } catch (e) {
    console.error("Sync delete failed:", e);
  }
}

/**
 * Propagate a new folder/project creation to Dropbox.
 */
export async function syncCreateNode(state, nodeId, nodeType) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const { findSyncContext } = await import("../state/tree-helpers.js");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx || !ctx.relativePath) return;

  try {
    const fullPath = basePath ? `${basePath}/${ctx.relativePath}` : `/${ctx.relativePath}`;
    await dbx.createFolder(fullPath);
    if (nodeType === "project") {
      const data = JSON.stringify({ ordering: [] }, null, 2);
      await dbx.uploadFile(`${fullPath}/.hushproject`, data);
    }
  } catch (e) {
    console.error("Sync create dir failed:", e);
  }
}

/**
 * Propagate a new file creation to Dropbox.
 */
export async function syncCreateFile(state, nodeId, fileId, content) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;

  const node = findNode(state.fileTree, nodeId);
  const nodeName = node?.name || "Untitled";
  const ext = extensionForType(node?.type);
  const relPath = ctx.relativePath ? `${ctx.relativePath}${ext}` : `${nodeName}${ext}`;

  try {
    const fullPath = basePath ? `${basePath}/${relPath}` : `/${relPath}`;
    await uploadContent(dbx, fullPath, content, relPath);
    await tauriInvoke("register_synced_file", {
      internalId: fileId, syncFolderId: SYNC_FOLDER_ID,
      relativePath: relPath, content,
    });
  } catch (e) {
    console.error("Sync create file failed:", e);
  }
}

/**
 * Update a project's .hushproject ordering file on Dropbox.
 */
export async function syncProjectOrdering(state, projectNodeId) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const ctx = findSyncContext(state.fileTree, projectNodeId);
  if (!ctx) return;
  const node = findNode(state.fileTree, projectNodeId);
  if (!node || node.type !== "project") return;

  const docNames = (node.children || [])
    .filter(c => c.type === "document" || c.type === "notebook")
    .map(c => c.name + extensionForType(c.type));

  try {
    const data = JSON.stringify({ ordering: docNames }, null, 2);
    const fullPath = basePath
      ? `${basePath}/${ctx.relativePath}/.hushproject`
      : `/${ctx.relativePath}/.hushproject`;
    await dbx.uploadFile(fullPath, data);
  } catch (e) {
    console.error("Sync project ordering failed:", e);
  }
}
