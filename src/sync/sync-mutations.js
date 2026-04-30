/**
 * Per-tree-node Dropbox sync mutations: rename, delete, create folder/
 * project, create file, project-ordering refresh.
 *
 * Each mutation appends a row to the durable op log (`sync.db.pending_ops`)
 * and triggers the drain worker to execute it. This replaces the previous
 * fire-and-forget design where every UI action did its own Dropbox call —
 * a design that lost ops on offline and produced duplicates when calls
 * raced (the "rename creates a duplicate" bug).
 *
 * Bulk operations (initial sync, polling diff, conflict reconciliation)
 * still live in sync-state.js; image-specific mutations in sync-images.js.
 */

import {
  enqueueRename,
  enqueueRenameDir,
  enqueueDelete,
  enqueueDeleteDir,
  enqueueUpload,
  enqueueUploadPayload,
  enqueueCreateFolder,
  triggerDrain,
} from "./op-log.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function extensionForType(nodeType) {
  return nodeType === "notebook" ? ".hushnote" : ".md";
}

function syncEnabled(state) {
  return IS_TAURI
    && state.settings.dropboxEnabled
    && !!state.settings.dropboxSyncPath;
}

/**
 * Propagate a rename to Dropbox via the op log.
 */
export async function syncRenameNode(state, nodeId, oldName, nodeType) {
  if (!syncEnabled(state)) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");

  try {
    if (nodeType === "document" || nodeType === "notebook") {
      const node = findNode(state.fileTree, nodeId);
      if (!node?.fileId) return;
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (!info) return;
      const pathParts = info.relativePath.split("/");
      pathParts[pathParts.length - 1] = node.name + extensionForType(nodeType);
      const newRelPath = pathParts.join("/");
      if (newRelPath === info.relativePath) return;
      await enqueueRename({
        internalId: node.fileId,
        fromPath: info.relativePath,
        toPath: newRelPath,
      });
    } else {
      const ctx = findSyncContext(state.fileTree, nodeId);
      if (!ctx?.relativePath) return;
      const parts = ctx.relativePath.split("/");
      parts[parts.length - 1] = oldName;
      const oldRelPath = parts.join("/");
      if (oldRelPath === ctx.relativePath) return;
      await enqueueRenameDir({ fromPath: oldRelPath, toPath: ctx.relativePath });
    }
    triggerDrain(state);
  } catch (e) {
    console.error("Sync rename enqueue failed:", e);
  }
}

/**
 * Propagate a delete to Dropbox via the op log.
 */
export async function syncDeleteNode(state, nodeId) {
  if (!syncEnabled(state)) return;

  const { findNode, findSyncContext } = await import("../state/tree-helpers.js");
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;

  try {
    if ((node.type === "document" || node.type === "notebook") && node.fileId) {
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (!info) return;
      await enqueueDelete({ internalId: node.fileId, path: info.relativePath });
    } else {
      const ctx = findSyncContext(state.fileTree, nodeId);
      if (!ctx?.relativePath) return;
      await enqueueDeleteDir({ path: ctx.relativePath });
    }
    triggerDrain(state);
  } catch (e) {
    console.error("Sync delete enqueue failed:", e);
  }
}

/**
 * Propagate a new folder/project creation to Dropbox via the op log.
 */
export async function syncCreateNode(state, nodeId, nodeType) {
  if (!syncEnabled(state)) return;

  const { findSyncContext } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx?.relativePath) return;

  try {
    await enqueueCreateFolder({ path: ctx.relativePath });
    if (nodeType === "project") {
      const data = JSON.stringify({ ordering: [] }, null, 2);
      await enqueueUploadPayload({
        path: `${ctx.relativePath}/.hushproject`,
        payload: data,
      });
    }
    triggerDrain(state);
  } catch (e) {
    console.error("Sync create dir enqueue failed:", e);
  }
}

/**
 * Propagate a new file creation to Dropbox via the op log.
 *
 * `content` is intentionally ignored — the executor reads fresh content
 * from FileManager at drain time so the latest edit wins.
 */
// eslint-disable-next-line no-unused-vars
export async function syncCreateFile(state, nodeId, fileId, content) {
  if (!syncEnabled(state)) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;

  const node = findNode(state.fileTree, nodeId);
  const nodeName = node?.name || "Untitled";
  const ext = extensionForType(node?.type);
  const relPath = ctx.relativePath ? `${ctx.relativePath}${ext}` : `${nodeName}${ext}`;

  try {
    await enqueueUpload({ internalId: fileId, path: relPath });
    triggerDrain(state);
  } catch (e) {
    console.error("Sync create file enqueue failed:", e);
  }
}

/**
 * Update a project's .hushproject ordering file on Dropbox via the op log.
 */
export async function syncProjectOrdering(state, projectNodeId) {
  if (!syncEnabled(state)) return;

  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, projectNodeId);
  if (!ctx) return;
  const node = findNode(state.fileTree, projectNodeId);
  if (!node || node.type !== "project") return;

  const docNames = (node.children || [])
    .filter(c => c.type === "document" || c.type === "notebook")
    .map(c => c.name + extensionForType(c.type));

  try {
    const data = JSON.stringify({ ordering: docNames }, null, 2);
    await enqueueUploadPayload({
      path: `${ctx.relativePath}/.hushproject`,
      payload: data,
    });
    triggerDrain(state);
  } catch (e) {
    console.error("Sync project ordering enqueue failed:", e);
  }
}
