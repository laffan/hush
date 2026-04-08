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
 * Handles both local (desktop) and dropbox (iPad) sync types.
 */
export async function importSyncFolder(state, syncFolder) {
  if (!IS_TAURI) return;
  const { AppState } = await import("../state/state.js");

  try {
    let entries;
    if (syncFolder.syncType === "dropbox") {
      entries = await scanDropboxFolder(state, syncFolder);
    } else {
      entries = await tauriInvoke("scan_sync_folder", { folderPath: syncFolder.path });
    }

    const folderNode = {
      id: crypto.randomUUID(), type: "folder", name: syncFolder.name,
      children: [], flagged: false, syncFolderId: syncFolder.id,
    };

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

/** Scan a Dropbox folder and download all .md file contents. */
async function scanDropboxFolder(state, syncFolder) {
  const dbx = await import("./dropbox.js");
  dbx.setToken(state.settings.dropboxToken);
  const rawEntries = await dbx.listFolderRecursive(syncFolder.path === "/" ? "" : syncFolder.path);
  // Download content for each .md file
  for (const entry of rawEntries) {
    if (!entry.isDirectory && entry.dropboxPath) {
      entry.content = await dbx.downloadFile(entry.dropboxPath);
    }
  }
  return rawEntries;
}

/**
 * Write file content to its external synced location (local or Dropbox).
 * Checks external timestamps first — if the external file is newer,
 * accepts the external version instead of overwriting it.
 */
export async function syncFileToExternal(state, fileId, content) {
  if (!IS_TAURI) return;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    if (!info) return;
    const folder = getSyncFolder(state, info.syncFolderId);
    if (!folder) return;

    if (folder.syncType === "dropbox") {
      const dbx = await import("./dropbox.js");
      dbx.setToken(state.settings.dropboxToken);
      const dropboxPath = folder.path === "/" ? `/${info.relativePath}` : `${folder.path}/${info.relativePath}`;
      // Check Dropbox metadata before uploading — don't overwrite newer external edits
      try {
        const metaResp = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${dbx.getToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: dropboxPath }),
        });
        if (metaResp.ok) {
          const meta = await metaResp.json();
          const externalModified = meta.server_modified
            ? Math.floor(new Date(meta.server_modified).getTime() / 1000) : 0;
          if (externalModified > (info.lastSyncedAt || 0)) {
            // External is newer — pull it instead of pushing
            const externalContent = await dbx.downloadFile(dropboxPath);
            if (externalContent !== content) {
              await acceptExternalChange(state, fileId, externalContent);
            } else {
              await tauriInvoke("update_sync_hash", { internalId: fileId, content: externalContent });
            }
            return;
          }
        }
      } catch (_) {
        // Metadata check failed — skip push to be safe, let polling handle it
        return;
      }
      await dbx.uploadFile(dropboxPath, content);
      await tauriInvoke("update_sync_hash", { internalId: fileId, content });
    } else {
      // Local sync — backend checks external mtime before writing
      const result = await tauriInvoke("write_sync_file", {
        folderPath: folder.path, relativePath: info.relativePath,
        content, internalId: fileId,
      });
      if (result && result.externalIsNewer && result.externalContent) {
        // External file was modified outside the app — accept it instead
        await acceptExternalChange(state, fileId, result.externalContent);
      }
    }
  } catch (e) {
    console.error("Sync write failed:", e);
  }
}

function getSyncFolder(state, syncFolderId) {
  return (state.settings.syncFolders || []).find(f => f.id === syncFolderId);
}

function dropboxFullPath(folder, relativePath) {
  return folder.path === "/" ? `/${relativePath}` : `${folder.path}/${relativePath}`;
}

async function getDropbox(state) {
  const dbx = await import("./dropbox.js");
  dbx.setToken(state.settings.dropboxToken);
  return dbx;
}

/**
 * Propagate a rename to the external filesystem.
 * Called AFTER the tree node has already been renamed (so ctx.relativePath has the new name).
 */
export async function syncRenameNode(state, nodeId, oldName, nodeType) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  try {
    if (nodeType === "document") {
      const node = findNode(state.fileTree, nodeId);
      if (!node?.fileId) return;
      const info = await tauriInvoke("get_sync_file_info", { internalId: node.fileId });
      if (!info) return;
      const pathParts = info.relativePath.split("/");
      pathParts[pathParts.length - 1] = node.name + ".md";
      const newRelPath = pathParts.join("/");
      if (folder.syncType === "dropbox") {
        const dbx = await getDropbox(state);
        await dbx.moveEntry(dropboxFullPath(folder, info.relativePath), dropboxFullPath(folder, newRelPath));
        // Update mapping locally
        await tauriInvoke("rename_sync_file", {
          folderPath: "__dropbox__", oldRelative: info.relativePath,
          newRelative: newRelPath, internalId: node.fileId,
        });
      } else {
        await tauriInvoke("rename_sync_file", {
          folderPath: folder.path, oldRelative: info.relativePath,
          newRelative: newRelPath, internalId: node.fileId,
        });
      }
    } else {
      const parts = ctx.relativePath.split("/");
      parts[parts.length - 1] = oldName;
      const oldRelPath = parts.join("/");
      if (folder.syncType === "dropbox") {
        const dbx = await getDropbox(state);
        await dbx.moveEntry(dropboxFullPath(folder, oldRelPath), dropboxFullPath(folder, ctx.relativePath));
      }
      await tauriInvoke("rename_sync_directory", {
        folderPath: folder.syncType === "dropbox" ? "__dropbox__" : folder.path,
        oldRelative: oldRelPath, newRelative: ctx.relativePath, syncFolderId: ctx.syncFolderId,
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
  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx || !ctx.relativePath) return; // Don't delete the sync folder root itself
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  const node = findNode(state.fileTree, nodeId);
  if (!node) return;

  try {
    if (folder.syncType === "dropbox") {
      const dbx = await getDropbox(state);
      await dbx.deleteEntry(dropboxFullPath(folder, ctx.relativePath)).catch(() => {});
    }
    const fp = folder.syncType === "dropbox" ? "__dropbox__" : folder.path;
    if (node.type === "document" && node.fileId) {
      await tauriInvoke("delete_sync_file", { folderPath: fp, internalId: node.fileId });
    } else {
      await tauriInvoke("delete_sync_directory", {
        folderPath: fp, relativePath: ctx.relativePath, syncFolderId: ctx.syncFolderId,
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
  const { findSyncContext } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  try {
    if (folder.syncType === "dropbox") {
      const dbx = await getDropbox(state);
      await dbx.createFolder(dropboxFullPath(folder, ctx.relativePath));
      if (nodeType === "project") {
        const data = JSON.stringify({ ordering: [] }, null, 2);
        await dbx.uploadFile(dropboxFullPath(folder, ctx.relativePath + "/.hush-project.json"), data);
      }
    } else {
      await tauriInvoke("create_sync_directory", {
        folderPath: folder.path, relativePath: ctx.relativePath,
      });
      if (nodeType === "project") {
        await tauriInvoke("write_project_json", {
          folderPath: folder.path, relativePath: ctx.relativePath, docNames: [],
        });
      }
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
  const { findSyncContext, findNode } = await import("../state/tree-helpers.js");
  const ctx = findSyncContext(state.fileTree, nodeId);
  if (!ctx) return;
  const folder = getSyncFolder(state, ctx.syncFolderId);
  if (!folder) return;

  const relPath = ctx.relativePath + ".md";

  try {
    if (folder.syncType === "dropbox") {
      const dbx = await getDropbox(state);
      await dbx.uploadFile(dropboxFullPath(folder, relPath), content);
      // Register in sync map (no local file write)
      await tauriInvoke("register_synced_file", {
        internalId: fileId, syncFolderId: ctx.syncFolderId,
        relativePath: relPath, content,
      });
    } else {
      await tauriInvoke("create_sync_file", {
        folderPath: folder.path, relativePath: relPath, content,
        internalId: fileId, syncFolderId: ctx.syncFolderId,
      });
    }
  } catch (e) {
    console.error("Sync create file failed:", e);
  }
}

/**
 * Update a project's .hush-project.json ordering file.
 */
export async function syncProjectOrdering(state, projectNodeId) {
  if (!IS_TAURI) return;
  const { findSyncContext, findNode, collectDocumentIds } = await import("../state/tree-helpers.js");
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
    if (folder.syncType === "dropbox") {
      const dbx = await getDropbox(state);
      const data = JSON.stringify({ ordering: docNames }, null, 2);
      await dbx.uploadFile(dropboxFullPath(folder, ctx.relativePath + "/.hush-project.json"), data);
    } else {
      await tauriInvoke("write_project_json", {
        folderPath: folder.path, relativePath: ctx.relativePath, docNames,
      });
    }
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
 * A snapshot of the current internal content is created by the backend
 * before overwriting, preserving it in version history.
 */
export async function acceptExternalChange(state, internalId, content) {
  if (!IS_TAURI) return;
  try {
    await tauriInvoke("accept_external_change", { internalId, content });
    state.files = await tauriInvoke("list_files");
    // If the changed file is currently open, reload it without marking dirty
    if (state.currentFileId === internalId && state.editor) {
      state._syncPulling = true;
      state.editor.setContent(content);
      state._syncPulling = false;
    }
    state.emit("files-changed");
  } catch (e) {
    state._syncPulling = false;
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

/**
 * Reconcile sync state after a tree reorganization (e.g. drag-and-drop).
 * Handles three cases:
 * 1. Document moved INTO a synced folder — create external file
 * 2. Document moved OUT of a synced folder — remove registration
 * 3. Document moved WITHIN a synced folder — move file on disk to match
 */
export async function reconcileSync(state) {
  if (!IS_TAURI) return;
  const { findSyncContext } = await import("../state/tree-helpers.js");

  // Collect all document nodes from the tree
  function collectDocs(nodes) {
    const docs = [];
    for (const n of nodes) {
      if (n.type === "document" && n.fileId) docs.push(n);
      if (n.children) docs.push(...collectDocs(n.children));
    }
    return docs;
  }

  const docs = collectDocs(state.fileTree);

  for (const doc of docs) {
    const ctx = findSyncContext(state.fileTree, doc.id);
    let info = null;
    try {
      info = await tauriInvoke("get_sync_file_info", { internalId: doc.fileId });
    } catch (_) {}

    if (ctx && !info) {
      // Document is in a synced folder but has no registration — create external file
      const folder = getSyncFolder(state, ctx.syncFolderId);
      if (!folder) continue;
      let content = "";
      try {
        const file = await tauriInvoke("load_file", { id: doc.fileId });
        content = file.content || "";
      } catch (_) {}
      await syncCreateFile(state, doc.id, doc.fileId, content);
    } else if (!ctx && info) {
      // Document was moved out of a synced folder — remove sync registration
      const folder = getSyncFolder(state, info.syncFolderId);
      if (!folder) continue;
      try {
        const fp = folder.syncType === "dropbox" ? "__dropbox__" : folder.path;
        await tauriInvoke("delete_sync_file", { folderPath: fp, internalId: doc.fileId });
      } catch (_) {}
    } else if (ctx && info) {
      // Document is in a synced folder AND has a registration —
      // check if its path changed (moved within the synced folder)
      const newRelPath = ctx.relativePath
        ? ctx.relativePath + ".md"
        : doc.name + ".md";
      if (newRelPath !== info.relativePath) {
        const folder = getSyncFolder(state, ctx.syncFolderId);
        if (!folder) continue;
        try {
          if (folder.syncType === "dropbox") {
            const dbx = await getDropbox(state);
            await dbx.moveEntry(
              dropboxFullPath(folder, info.relativePath),
              dropboxFullPath(folder, newRelPath)
            );
            await tauriInvoke("rename_sync_file", {
              folderPath: "__dropbox__",
              oldRelative: info.relativePath,
              newRelative: newRelPath,
              internalId: doc.fileId,
            });
          } else {
            await tauriInvoke("rename_sync_file", {
              folderPath: folder.path,
              oldRelative: info.relativePath,
              newRelative: newRelPath,
              internalId: doc.fileId,
            });
          }
        } catch (e) {
          console.error("Sync move failed:", e);
        }
      }
    }
  }
}

/**
 * Diff a sync folder against its filesystem contents.
 * Detects new files (created externally) and deleted files (removed externally).
 * Creates/removes internal files and tree nodes accordingly.
 * Returns true if any changes were made.
 */
export async function diffSyncFolder(state, syncFolder) {
  if (!IS_TAURI) return false;
  const { findNode, findNodeByFileId, removeNode } = await import("../state/tree-helpers.js");

  try {
    let diff;
    if (syncFolder.syncType === "dropbox") {
      diff = await diffDropboxFolder(state, syncFolder);
    } else {
      diff = await tauriInvoke("diff_sync_folder", { syncFolderId: syncFolder.id });
    }

    if (!diff) return false;
    const hasChanges = (diff.newFiles?.length > 0) || (diff.deletedFileIds?.length > 0);
    if (!hasChanges) return false;

    // Find the sync folder root node in the tree
    const syncRoot = findSyncFolderNode(state.fileTree, syncFolder.id);
    if (!syncRoot) return false;

    // Handle new external files — create internal files + tree nodes
    for (const entry of (diff.newFiles || [])) {
      if (entry.isDirectory) continue; // only handle files
      const file = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: file.id, content: entry.content });
      await tauriInvoke("register_synced_file", {
        internalId: file.id, syncFolderId: syncFolder.id,
        relativePath: entry.relativePath, content: entry.content,
      });
      // Add tree node in the correct subdirectory
      const parts = entry.relativePath.split(/[\\/]/);
      const fileName = parts.pop().replace(/\.md$/, "");
      const parentNode = ensureSubdirectories(syncRoot, parts);
      const docNode = {
        id: crypto.randomUUID(), type: "document", name: fileName || entry.name,
        fileId: file.id, children: [], flagged: false,
      };
      parentNode.children.push(docNode);
    }

    // Handle externally deleted files — remove tree nodes + unregister
    for (const internalId of (diff.deletedFileIds || [])) {
      const treeNode = findNodeByFileId(state.fileTree, internalId);
      if (treeNode) {
        removeNode(state.fileTree, treeNode.id);
      }
      try {
        const fp = syncFolder.syncType === "dropbox" ? "__dropbox__" : syncFolder.path;
        await tauriInvoke("delete_sync_file", { folderPath: fp, internalId });
      } catch (_) {}
    }

    await state.saveFileTree();
    state.files = await tauriInvoke("list_files");
    state.emit("files-changed");
    return true;
  } catch (e) {
    console.error("Sync folder diff failed:", e);
    return false;
  }
}

/**
 * Diff a Dropbox folder by listing all files and comparing against registered ones.
 * Returns a diff object with newFiles and deletedFileIds.
 */
async function diffDropboxFolder(state, syncFolder) {
  if (!state.settings.dropboxToken) return null;
  const dbx = await import("./dropbox.js");
  dbx.setToken(state.settings.dropboxToken);
  const { invoke } = await import("@tauri-apps/api/core");

  // List all .md files on Dropbox
  const rawEntries = await dbx.listFolderRecursive(
    syncFolder.path === "/" ? "" : syncFolder.path
  );
  const dropboxPaths = new Set();
  const newFiles = [];

  // Get all registered files for this folder
  const syncedFiles = await invoke("get_synced_files", { syncFolderId: syncFolder.id });
  const registeredPaths = new Set(syncedFiles.map(f => f.relativePath));

  for (const entry of rawEntries) {
    if (entry.isDirectory) continue;
    dropboxPaths.add(entry.relativePath);
    if (!registeredPaths.has(entry.relativePath)) {
      // New file on Dropbox — download its content
      if (entry.dropboxPath) {
        entry.content = await dbx.downloadFile(entry.dropboxPath);
      }
      newFiles.push(entry);
    }
  }

  // Find registered files no longer on Dropbox
  const deletedFileIds = syncedFiles
    .filter(f => !dropboxPaths.has(f.relativePath))
    .map(f => f.internalId);

  return { newFiles, deletedFileIds };
}

/** Find the sync folder root node in the tree by syncFolderId. */
function findSyncFolderNode(nodes, syncFolderId) {
  for (const n of nodes) {
    if (n.syncFolderId === syncFolderId) return n;
    if (n.children) {
      const found = findSyncFolderNode(n.children, syncFolderId);
      if (found) return found;
    }
  }
  return null;
}

/** Ensure subdirectory nodes exist in the tree, creating them if needed. */
function ensureSubdirectories(root, pathParts) {
  let current = root;
  for (const dirName of pathParts) {
    if (!dirName) continue;
    let child = current.children.find(
      c => c.type === "folder" && c.name === dirName
    );
    if (!child) {
      child = {
        id: crypto.randomUUID(), type: "folder", name: dirName,
        children: [], flagged: false,
      };
      current.children.push(child);
    }
    current = child;
  }
  return current;
}

/** Helper to get fileId from a document tree node by nodeId */
async function getFileIdForNode(state, nodeId) {
  const { findNode } = await import("../state/tree-helpers.js");
  const node = findNode(state.fileTree, nodeId);
  return node?.fileId || "";
}
