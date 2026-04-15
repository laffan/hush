/**
 * Sync state operations — full tree sync to Dropbox.
 * Syncs all documents, folders, projects, and notebooks as a mirror backup.
 * Documents → .md files, Notebooks → .hushnote (zip) files, Projects → .hushproject (JSON) files.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ===== Tree → Dropbox Path Helpers =====

/**
 * Derive a filesystem-safe name from a document's tree name.
 * Strips characters illegal in filenames. Max 50 chars.
 */
function safeName(name) {
  if (!name || name === "Untitled") return "Untitled";
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 50) || "Untitled";
}

/**
 * Return the Dropbox file extension for a given tree node type.
 */
function extensionForType(nodeType) {
  return nodeType === "notebook" ? ".hushnote" : ".md";
}

function isNotebookPath(relativePath) {
  return relativePath.endsWith(".hushnote");
}

/** Upload content to Dropbox, packing notebooks as zip. */
async function uploadContent(dbx, fullPath, content, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(content);
    return dbx.uploadBinary(fullPath, zipData);
  }
  return dbx.uploadFile(fullPath, content);
}

/** Download content from Dropbox, unpacking notebooks from zip. */
async function downloadContent(dbx, dropboxPath, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { unpackNotebook } = await import("./notebook-sync.js");
    const zipData = await dbx.downloadBinary(dropboxPath);
    return unpackNotebook(zipData);
  }
  return dbx.downloadFile(dropboxPath);
}

/**
 * Build a flat map of files and directories from the file tree.
 * Documents become "Name.md", Notebooks become "Name.hushnote",
 * Projects get a ".hushproject" metadata file, Folders become directories.
 */
export function buildSyncManifest(fileTree) {
  const manifest = { files: [], directories: [] };

  function walk(nodes, parentPath) {
    for (const node of nodes) {
      const name = safeName(node.name) || "Untitled";
      if ((node.type === "document" || node.type === "notebook") && node.fileId) {
        const ext = extensionForType(node.type);
        const relPath = parentPath ? `${parentPath}/${name}${ext}` : `${name}${ext}`;
        manifest.files.push({ nodeId: node.id, fileId: node.fileId, relativePath: relPath, type: node.type === "notebook" ? "hushnote" : "md" });
      } else if (node.type === "project") {
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        manifest.directories.push(dirPath);
        const childEntries = (node.children || [])
          .filter(c => c.type === "document" || c.type === "notebook")
          .map(c => c.name + extensionForType(c.type));
        manifest.files.push({
          nodeId: node.id, fileId: null, relativePath: `${dirPath}/.hushproject`,
          type: "hushproject", content: JSON.stringify({ ordering: childEntries }, null, 2),
        });
        if (node.children) walk(node.children, dirPath);
      } else if (node.type === "folder") {
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        manifest.directories.push(dirPath);
        if (node.children) walk(node.children, dirPath);
      }
    }
  }

  walk(fileTree, "");
  return manifest;
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
 */
export async function performInitialSync(state, dropboxPath) {
  if (!IS_TAURI) return { uploaded: [], downloaded: [] };
  const dbx = await import("./dropbox.js");

  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const manifest = buildSyncManifest(state.fileTree);
  const uploaded = [];
  const downloaded = [];

  // Ensure the root sync folder exists
  if (basePath) {
    await dbx.createFolder(basePath).catch(() => {});
  }

  // Create all directories first
  for (const dir of manifest.directories) {
    const fullDir = basePath ? `${basePath}/${dir}` : `/${dir}`;
    await dbx.createFolder(fullDir).catch(() => {});
  }

  // Upload all files
  for (const file of manifest.files) {
    const fullPath = basePath ? `${basePath}/${file.relativePath}` : `/${file.relativePath}`;
    let content = file.content || "";
    if ((file.type === "md" || file.type === "hushnote") && file.fileId) {
      try {
        const fileData = await tauriInvoke("load_file", { id: file.fileId });
        content = fileData.content || "";
      } catch (_) { continue; }
    }
    try {
      await uploadContent(dbx, fullPath, content, file.relativePath);
      uploaded.push(file.relativePath);
      if (file.fileId) {
        await tauriInvoke("register_synced_file", {
          internalId: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: file.relativePath, content,
        });
      }
    } catch (e) {
      console.error(`Upload failed for ${file.relativePath}:`, e);
    }
  }

  // Pull files from Dropbox that aren't in our tree
  let remoteEntries = [];
  try {
    remoteEntries = await dbx.listFolderRecursive(basePath || "");
  } catch (_) {}

  const localPaths = new Set(manifest.files.map(f => f.relativePath));

  for (const entry of remoteEntries) {
    if (entry.isDirectory || localPaths.has(entry.relativePath)) continue;
    if (entry.tag === "hushproject") continue;
    if (!entry.dropboxPath) continue;

    try {
      const content = await downloadContent(dbx, entry.dropboxPath, entry.relativePath);
      const file = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: file.id, content });
      await tauriInvoke("register_synced_file", {
        internalId: file.id, syncFolderId: SYNC_FOLDER_ID,
        relativePath: entry.relativePath, content,
      });
      insertIntoTree(state.fileTree, entry.relativePath, file.id, entry.name);
      downloaded.push(entry.relativePath);
    } catch (e) {
      console.error(`Download failed for ${entry.relativePath}:`, e);
    }
  }

  await state.saveFileTree();
  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
  return { uploaded, downloaded };
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

  for (const dirName of parts) {
    if (!dirName) continue;
    // Match any container node by name (folder, project, or any non-document/notebook).
    // Also match special nodes by ID as fallback (Inbox = __inbox__, Trash = __trash__).
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(n => n.id === "__inbox__"))
      || (dirName === "Trash" && current.find(n => n.id === "__trash__"));
    if (!folder) {
      folder = {
        id: crypto.randomUUID(), type: "folder", name: dirName,
        children: [], flagged: false,
      };
      // Insert before Trash to keep Trash last
      const trashIdx = current.findIndex(n => n.id === "__trash__" || n.name === "Trash");
      if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
      else current.push(folder);
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }

  // Check if a node with this fileId already exists to avoid duplicates
  if (current.some(n => n.fileId === fileId)) return;

  // Insert before Trash if we're at the top level
  const trashIdx = current.findIndex(n => n.id === "__trash__" || n.name === "Trash");
  const node = {
    id: crypto.randomUUID(), type: isNotebook ? "notebook" : "document",
    name: displayName || fileName, fileId,
    children: [], flagged: false,
  };
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}

// ===== Ongoing Sync Operations =====

/**
 * Push a single file's content to Dropbox after an edit.
 */
export async function syncFileToExternal(state, fileId, content) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    if (!info) return;

    const dbx = await import("./dropbox.js");
    const basePath = dropboxPath === "/" ? "" : dropboxPath;
    const fullPath = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;

    const meta = await dbx.getMetadata(fullPath);
    if (meta) {
      const externalModified = meta.server_modified
        ? Math.floor(new Date(meta.server_modified).getTime() / 1000) : 0;
      if (externalModified > (info.lastSyncedAt || 0)) {
        const externalContent = await downloadContent(dbx, fullPath, info.relativePath);
        if (externalContent !== content) {
          await acceptExternalChange(state, fileId, externalContent);
        } else {
          await tauriInvoke("update_sync_hash", { internalId: fileId, content: externalContent });
        }
        return;
      }
    }

    await uploadContent(dbx, fullPath, content, info.relativePath);
    await tauriInvoke("update_sync_hash", { internalId: fileId, content });
  } catch (e) {
    console.error("Sync write failed:", e);
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
    if (state.currentFileId === internalId && state.editor) {
      state._syncPulling = true;
      state.editor.setContent(content);
      state._syncPulling = false;
    } else if (state.currentNotebookFileId === internalId) {
      // Reload shapes into the open notebook canvas
      state.emit("notebook-sync-reload", content);
    }
    state.emit("files-changed");
  } catch (e) {
    state._syncPulling = false;
    console.error("Accept external change failed:", e);
  }
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
      const oldFull = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
      const newFull = basePath ? `${basePath}/${newRelPath}` : `/${newRelPath}`;
      await dbx.moveEntry(oldFull, newFull);
      await tauriInvoke("rename_sync_file", {
        folderPath: "__dropbox__", oldRelative: info.relativePath,
        newRelative: newRelPath, internalId: node.fileId,
      });
    } else {
      const ctx = findSyncContext(state.fileTree, nodeId);
      if (!ctx || !ctx.relativePath) return;
      const parts = ctx.relativePath.split("/");
      parts[parts.length - 1] = oldName;
      const oldRelPath = parts.join("/");
      const oldFull = basePath ? `${basePath}/${oldRelPath}` : `/${oldRelPath}`;
      const newFull = basePath ? `${basePath}/${ctx.relativePath}` : `/${ctx.relativePath}`;
      await dbx.moveEntry(oldFull, newFull);
      await tauriInvoke("rename_sync_directory", {
        folderPath: "__dropbox__", oldRelative: oldRelPath,
        newRelative: ctx.relativePath, syncFolderId: SYNC_FOLDER_ID,
      });
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

/**
 * Reconcile sync state after a tree reorganization (drag-and-drop).
 */
export async function reconcileSync(state) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;

  function collectDocs(nodes) {
    const docs = [];
    for (const n of nodes) {
      if ((n.type === "document" || n.type === "notebook") && n.fileId) docs.push(n);
      if (n.children) docs.push(...collectDocs(n.children));
    }
    return docs;
  }

  const docs = collectDocs(state.fileTree);
  const manifest = buildSyncManifest(state.fileTree);
  const expectedPaths = new Map(manifest.files.filter(f => f.fileId).map(f => [f.fileId, f.relativePath]));

  for (const doc of docs) {
    const expectedPath = expectedPaths.get(doc.fileId);
    if (!expectedPath) continue;

    let info = null;
    try { info = await tauriInvoke("get_sync_file_info", { internalId: doc.fileId }); } catch (_) {}

    if (!info) {
      let content = "";
      try { const file = await tauriInvoke("load_file", { id: doc.fileId }); content = file.content || ""; } catch (_) {}
      const fullPath = basePath ? `${basePath}/${expectedPath}` : `/${expectedPath}`;
      try {
        await uploadContent(dbx, fullPath, content, expectedPath);
        await tauriInvoke("register_synced_file", {
          internalId: doc.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: expectedPath, content,
        });
      } catch (_) {}
    } else if (info.relativePath !== expectedPath) {
      const oldFull = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
      const newFull = basePath ? `${basePath}/${expectedPath}` : `/${expectedPath}`;
      try {
        await dbx.moveEntry(oldFull, newFull);
        await tauriInvoke("rename_sync_file", {
          folderPath: "__dropbox__", oldRelative: info.relativePath,
          newRelative: expectedPath, internalId: doc.fileId,
        });
      } catch (e) {
        console.error("Sync move failed:", e);
      }
    }
  }
}

/**
 * Check all synced files for content changes on Dropbox.
 */
export async function checkDropboxChanges(state) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return [];
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const syncedFiles = await invoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID });
  const changes = [];

  for (const info of syncedFiles) {
    try {
      const fullPath = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
      const meta = await dbx.getMetadata(fullPath);
      if (!meta) continue;

      const externalModified = meta.server_modified
        ? Math.floor(new Date(meta.server_modified).getTime() / 1000) : 0;
      const internalFile = await invoke("load_file", { id: info.internalId });
      if (!internalFile) continue;
      const internalModified = internalFile.modified || 0;

      if (externalModified > (info.lastSyncedAt || 0)) {
        const externalContent = await downloadContent(dbx, fullPath, info.relativePath);
        if (externalContent === internalFile.content) {
          await invoke("update_sync_hash", { internalId: info.internalId, content: externalContent });
          continue;
        }
        if (externalModified >= internalModified) {
          changes.push({ type: "pull", internalId: info.internalId, content: externalContent });
          continue;
        }
      }

      if (internalModified > (info.lastSyncedAt || 0) && internalFile.content) {
        changes.push({
          type: "push", internalId: info.internalId,
          content: internalFile.content, relativePath: info.relativePath,
        });
      }
    } catch (_) {}
  }

  return changes;
}

/**
 * Diff Dropbox against local: detect new remote files and deleted remote files.
 */
export async function diffDropboxSync(state) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return null;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return null;

  const dbx = await import("./dropbox.js");
  const { invoke } = await import("@tauri-apps/api/core");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;

  let remoteEntries;
  try { remoteEntries = await dbx.listFolderRecursive(basePath); } catch (_) { return null; }

  const syncedFiles = await invoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID });
  const registeredPaths = new Set(syncedFiles.map(f => f.relativePath));
  const remotePaths = new Set();
  const newFiles = [];

  for (const entry of remoteEntries) {
    if (entry.isDirectory || entry.tag === "hushproject") continue;
    remotePaths.add(entry.relativePath);
    if (!registeredPaths.has(entry.relativePath) && entry.dropboxPath) {
      entry.content = await downloadContent(dbx, entry.dropboxPath, entry.relativePath);
      newFiles.push(entry);
    }
  }

  const deletedFileIds = syncedFiles
    .filter(f => !remotePaths.has(f.relativePath))
    .map(f => f.internalId);

  return { newFiles, deletedFileIds };
}

/**
 * Disconnect Dropbox sync. Optionally removes data from Dropbox.
 */
export async function disconnectSync(state, removeFromDropbox) {
  if (!IS_TAURI) return;

  if (removeFromDropbox && state.settings.dropboxSyncPath) {
    try {
      const dbx = await import("./dropbox.js");
      const basePath = state.settings.dropboxSyncPath === "/" ? "" : state.settings.dropboxSyncPath;
      if (basePath) await dbx.deleteEntry(basePath).catch(() => {});
    } catch (_) {}
  }

  await tauriInvoke("unregister_sync_folder", { syncFolderId: SYNC_FOLDER_ID }).catch(() => {});
  const dbx = await import("./dropbox.js");
  dbx.clearTokens();
}

export { SYNC_FOLDER_ID };
