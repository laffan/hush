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
  enqueueCreateFolder,
  triggerDrain,
} from "./op-log.js";
import { appendSyncError } from "./sync-feedback.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function extensionForType(nodeType) {
  if (nodeType === "notebook") return ".hushnote";
  if (nodeType === "pdf") return ".pdf";
  return ".md";
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
    if (nodeType === "pdf") return;
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
    appendSyncError(`Sync rename enqueue failed: ${e?.message || e}`);
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
    if (node.type === "pdf") return;
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
    appendSyncError(`Sync delete enqueue failed: ${e?.message || e}`);
  }
}

/**
 * Propagate a new folder/project creation to Dropbox via the op log.
 *
 * Project-ness is now recorded in `.hush/projects.json` rather than
 * per-folder `.hushproject` files. The folder itself is still created
 * on Dropbox so docs in the project have somewhere to land.
 */
export async function syncCreateNode(state, nodeId, nodeType) {
  if (!syncEnabled(state)) return;

  const { findSyncContext } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx?.relativePath) return;

  try {
    await enqueueCreateFolder({ path: ctx.relativePath });
    triggerDrain(state);
    if (nodeType === "project") {
      const { pushProjectsToDropbox } = await import("./project-sync.js");
      await pushProjectsToDropbox(state);
    }
  } catch (e) {
    appendSyncError(`Sync create dir enqueue failed: ${e?.message || e}`);
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
    appendSyncError(`Sync create file enqueue failed: ${e?.message || e}`);
  }
}

/**
 * Refresh the cross-device project registry on Dropbox after a project's
 * ordering or membership changes. The whole `.hush/projects.json` is
 * rewritten — projects are cheap to enumerate and one upload is simpler
 * than per-project diffs.
 *
 * (The `projectNodeId` parameter is preserved for caller compatibility
 * but we re-serialize all projects regardless of which one changed.)
 */
// eslint-disable-next-line no-unused-vars
export async function syncProjectOrdering(state, projectNodeId) {
  if (!syncEnabled(state)) return;
  try {
    const { pushProjectsToDropbox } = await import("./project-sync.js");
    await pushProjectsToDropbox(state);
  } catch (e) {
    appendSyncError(`Sync project ordering push failed: ${e?.message || e}`);
  }
}
