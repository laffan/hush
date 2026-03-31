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
