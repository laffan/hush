/**
 * Sync state operations — extracted from state.js to keep under 700 lines.
 * These methods are mixed into AppState via initSyncMethods().
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * Import a sync folder's contents into the internal file system.
 */
export async function importSyncFolder(state, syncFolder) {
  if (!IS_TAURI) return;
  const { findNode } = await import("./tree-helpers.js");
  const { AppState } = await import("./state.js");

  try {
    const entries = await tauriInvoke("scan_sync_folder", { folderPath: syncFolder.path });
    const folderNode = {
      id: crypto.randomUUID(), type: "folder", name: syncFolder.name,
      children: [], flagged: false, syncFolderId: syncFolder.id,
    };

    // Build nested structure from flat entries
    const dirMap = { "": folderNode };
    for (const entry of entries) {
      const parts = entry.relativePath.split(/[\\/]/);
      const parentPath = parts.slice(0, -1).join("/");
      const parent = dirMap[parentPath] || folderNode;

      if (entry.isDirectory) {
        const node = {
          id: crypto.randomUUID(), type: "folder", name: entry.name,
          children: [], flagged: false,
        };
        parent.children.push(node);
        dirMap[entry.relativePath] = node;
      } else {
        const file = await tauriInvoke("create_file");
        await tauriInvoke("save_file", { id: file.id, content: entry.content });
        await tauriInvoke("register_synced_file", {
          internalId: file.id, syncFolderId: syncFolder.id,
          relativePath: entry.relativePath, content: entry.content,
        });
        const node = {
          id: crypto.randomUUID(), type: "document", name: entry.name,
          fileId: file.id, children: [], flagged: false,
        };
        parent.children.push(node);
      }
    }

    // Insert before Trash
    const trashIdx = state.fileTree.findIndex(n => n.id === AppState.TRASH_ID);
    if (trashIdx >= 0) state.fileTree.splice(trashIdx, 0, folderNode);
    else state.fileTree.push(folderNode);

    await state.saveFileTree();
    state.files = await tauriInvoke("list_files");
    state.emit("files-changed");
  } catch (e) {
    console.error("Sync import failed:", e);
  }
}

/**
 * Write file content to its external synced location.
 */
export async function syncFileToExternal(state, fileId, content) {
  if (!IS_TAURI) return;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    if (!info) return;
    const folder = (state.settings.syncFolders || []).find(f => f.id === info.syncFolderId);
    if (!folder) return;
    await tauriInvoke("write_sync_file", {
      folderPath: folder.path, relativePath: info.relativePath,
      content, internalId: fileId,
    });
  } catch (e) {
    console.error("Sync write failed:", e);
  }
}

/**
 * Get the sync folder path for a given syncFolderId from settings.
 */
function getSyncFolder(state, syncFolderId) {
  return (state.settings.syncFolders || []).find(f => f.id === syncFolderId);
}

/**
 * Propagate a rename to the external filesystem.
 * Called AFTER the tree node has already been renamed (so ctx.relativePath has the new name).
 */
export async function syncRenameNode(state, nodeId, oldName, nodeType) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode } = await import("./tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  try {
    if (nodeType === "document") {
      // For documents, use the sync map to get the current external path
      const node = findNode(state.fileTree, nodeId);
      if (!node?.fileId) return;
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (!info) return;
      // Build new relative path by replacing the filename
      const pathParts = info.relativePath.split("/");
      pathParts[pathParts.length - 1] = node.name + ".md";
      const newRelPath = pathParts.join("/");
      await tauriInvoke("rename_sync_file", {
        folderPath: folder.path, oldRelative: info.relativePath,
        newRelative: newRelPath, internalId: node.fileId,
      });
    } else {
      // For folders/projects, compute old path from ctx (which has new name) by swapping last segment
      const parts = ctx.relativePath.split("/");
      parts[parts.length - 1] = oldName;
      const oldRelPath = parts.join("/");
      await tauriInvoke("rename_sync_directory", {
        folderPath: folder.path, oldRelative: oldRelPath,
        newRelative: ctx.relativePath, syncFolderId: ctx.syncFolderId,
      });
    }
  } catch (e) {
    console.error("Sync rename failed:", e);
  }
}

/**
 * Propagate a delete to the external filesystem.
 * Called BEFORE the node is removed from the tree (so we can still find its context).
 */
export async function syncDeleteNode(state, nodeId) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode } = await import("./tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx || !ctx.relativePath) return; // Don't delete the sync folder root itself
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  const node = findNode(state.fileTree, nodeId);
  if (!node) return;

  try {
    if (node.type === "document" && node.fileId) {
      await tauriInvoke("delete_sync_file", {
        folderPath: folder.path, internalId: node.fileId,
      });
    } else {
      // folder or project — delete directory and all child mappings
      await tauriInvoke("delete_sync_directory", {
        folderPath: folder.path, relativePath: ctx.relativePath,
        syncFolderId: ctx.syncFolderId,
      });
    }
  } catch (e) {
    console.error("Sync delete failed:", e);
  }
}

/**
 * Propagate a new folder/project creation to the external filesystem.
 */
export async function syncCreateNode(state, nodeId, nodeType) {
  if (!IS_TAURI) return;
  const { findSyncContext } = await import("./tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  try {
    await tauriInvoke("create_sync_directory", {
      folderPath: folder.path, relativePath: ctx.relativePath,
    });
    if (nodeType === "project") {
      await tauriInvoke("write_project_json", {
        folderPath: folder.path, relativePath: ctx.relativePath, docNames: [],
      });
    }
  } catch (e) {
    console.error("Sync create dir failed:", e);
  }
}

/**
 * Propagate a new file creation to the external filesystem.
 */
export async function syncCreateFile(state, nodeId, fileId, content) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode } = await import("./tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  const node = findNode(state.fileTree, nodeId);
  const relPath = ctx.relativePath + ".md";

  try {
    await tauriInvoke("create_sync_file", {
      folderPath: folder.path, relativePath: relPath, content,
      internalId: fileId, syncFolderId: ctx.syncFolderId,
    });
  } catch (e) {
    console.error("Sync create file failed:", e);
  }
}

/**
 * Update a project's .hush-project.json ordering file.
 */
export async function syncProjectOrdering(state, projectNodeId) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode, collectDocumentIds } = await import("./tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, projectNodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  const node = findNode(state.fileTree, projectNodeId);
  if (!node || node.type !== "project") return;

  // Build ordered list of document names
  const docNames = (node.children || [])
    .filter(c => c.type === "document")
    .map(c => c.name + ".md");

  try {
    await tauriInvoke("write_project_json", {
      folderPath: folder.path, relativePath: ctx.relativePath, docNames,
    });
  } catch (e) {
    console.error("Sync project JSON failed:", e);
  }
}

/**
 * Check all sync folders for external changes. Returns array of ExternalChange.
 */
export async function checkSyncChanges() {
  if (!IS_TAURI) return [];
  try {
    return await tauriInvoke("check_sync_changes");
  } catch (e) {
    console.error("Sync change check failed:", e);
    return [];
  }
}

/**
 * Accept an external change — replace internal content with external.
 */
export async function acceptExternalChange(state, internalId, content) {
  if (!IS_TAURI) return;
  try {
    await tauriInvoke("accept_external_change", { internalId, content });
    state.files = await tauriInvoke("list_files");
    // If the changed file is currently open, reload it
    if (state.currentFileId === internalId && state.editor) {
      state.editor.setContent(content);
    }
    state.emit("files-changed");
  } catch (e) {
    console.error("Accept external change failed:", e);
  }
}

/**
 * Reject an external change — overwrite external with internal.
 */
export async function rejectExternalChange(state, internalId, folderPath) {
  if (!IS_TAURI) return;
  try {
    await tauriInvoke("reject_external_change", { internalId, folderPath });
  } catch (e) {
    console.error("Reject external change failed:", e);
  }
}

/** Helper to get fileId from a document tree node by nodeId */
async function getFileIdForNode(state, nodeId) {
  const { findNode } = await import("./tree-helpers.js");
  const node = findNode(state.fileTree, nodeId);
  return node?.fileId || "";
}
