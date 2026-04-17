/**
 * Tree node operations — extracted from state.js to keep under 700 lines.
 * Each function takes the AppState instance as the first argument.
 */

import { findNode, findNodeByFileId, removeNode, insertNode, insertAfter, collectDocumentIds } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function createTreeNode(state, command, type, name, parentId) {
  const { AppState } = await import("./state.js");
  if (IS_TAURI) {
    try {
      const created = await tauriInvoke(command, { name, parentId });
      state.fileTree = await tauriInvoke("get_file_tree");
      state.emit("files-changed");
      state.syncCreateNode(created.id, type);
      return created;
    } catch (e) { console.error(`Create ${type} failed:`, e); }
  } else {
    const node = { id: crypto.randomUUID(), type, name, children: [], flagged: false };
    insertNode(state.fileTree, node, parentId, findNode);
    state._saveTreeLocal();
    state.emit("files-changed");
    return node;
  }
}

export async function deleteTreeNode(state, nodeId) {
  const { AppState } = await import("./state.js");
  if (nodeId === AppState.INBOX_ID || nodeId === AppState.TRASH_ID || nodeId === AppState.IMAGES_ID) return;
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (state.isInTrash(nodeId)) return permanentDeleteNode(state, nodeId);
  await state.syncDeleteNode(nodeId);
  const removed = removeNode(state.fileTree, nodeId);
  if (removed) {
    clearFlaggedRecursive(removed);
    const trash = findNode(state.fileTree, AppState.TRASH_ID);
    if (trash) (trash.children || (trash.children = [])).push(removed);
  }
  await state.saveFileTree();
  const { docFileIds } = collectTypedFileIds(node);
  if (docFileIds.includes(state.currentNotebookFileId)) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (docFileIds.includes(state.currentFileId) || nodeId === state.currentProjectId || docFileIds.includes(state.currentNotebookFileId)) {
    state.currentProjectId = null; state.projectDocIds = [];
    if (state.files.length > 0) await state.openFile(state.files[0].id);
    else await state.newFile();
  }
  state.emit("files-changed");
}

async function permanentDeleteNode(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const { docFileIds, imageFileIds } = collectTypedFileIds(node);
  await deleteDocFilesByIds(state, docFileIds);
  await deleteImageFilesByIds(imageFileIds);
  removeNode(state.fileTree, nodeId);
  await finalizeFileDeletion(state, docFileIds);
}

export async function emptyTrash(state) {
  const { AppState } = await import("./state.js");
  const trash = findNode(state.fileTree, AppState.TRASH_ID);
  if (!trash?.children?.length) return;
  const docFileIds = [];
  const imageFileIds = [];
  for (const child of trash.children) {
    const typed = collectTypedFileIds(child);
    docFileIds.push(...typed.docFileIds);
    imageFileIds.push(...typed.imageFileIds);
  }
  await deleteDocFilesByIds(state, docFileIds);
  await deleteImageFilesByIds(imageFileIds);
  trash.children = [];
  await finalizeFileDeletion(state, docFileIds);
}

function clearFlaggedRecursive(node) {
  node.flagged = false;
  if (node.children) node.children.forEach(c => clearFlaggedRecursive(c));
}

/** Walk a node and classify its descendants' fileIds by type. */
function collectTypedFileIds(node) {
  const docFileIds = [];
  const imageFileIds = [];
  function walk(n) {
    if (!n) return;
    if ((n.type === "document" || n.type === "notebook") && n.fileId) docFileIds.push(n.fileId);
    else if (n.type === "image" && n.fileId) imageFileIds.push(n.fileId);
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return { docFileIds, imageFileIds };
}

async function deleteDocFilesByIds(state, fileIds) {
  for (const fid of fileIds) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fid }); } catch (e) { console.error("Delete file:", e); }
      try { await tauriInvoke("delete_document_snapshots", { documentId: fid }); } catch (e) { console.error("Delete snapshots:", e); }
    } else { state.files = state.files.filter(f => f.id !== fid); }
  }
}

async function deleteImageFilesByIds(fileIds) {
  if (!fileIds.length) return;
  const { clearImageCache } = await import("./state-images.js");
  for (const fid of fileIds) {
    clearImageCache(fid);
    if (IS_TAURI) {
      try { await tauriInvoke("delete_image", { fileId: fid }); } catch (e) { console.error("Delete image:", e); }
    }
  }
}

async function finalizeFileDeletion(state, fileIds) {
  await state.saveFileTree();
  if (IS_TAURI) state.files = await tauriInvoke("list_files");
  else state._saveFilesLocal();
  if (fileIds.includes(state.currentNotebookFileId)) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (fileIds.includes(state.currentFileId) || fileIds.includes(state.currentNotebookFileId)) {
    state.currentProjectId = null; state.projectDocIds = [];
    if (state.files.length > 0) await state.openFile(state.files[0].id);
    else await state.newFile();
  }
  state.emit("files-changed");
}

export async function renameTreeNode(state, nodeId, newName) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const oldName = node.name;
  node.name = newName;
  if ((node.type === "document" || node.type === "notebook") && node.fileId) {
    if (IS_TAURI) {
      try { await tauriInvoke("rename_file", { id: node.fileId, name: newName }); state.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Rename failed:", e); }
    } else {
      const file = state.files.find((f) => f.id === node.fileId);
      if (file) file.name = newName;
      state._saveFilesLocal();
    }
  }
  await state.saveFileTree();
  if (oldName !== newName) {
    state.syncRenameNode(nodeId, oldName, node.type);
  }
}

export async function toggleFlagged(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  node.flagged = !node.flagged;
  await state.saveFileTree();
}

export async function duplicateTreeNode(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || (node.type !== "document" && node.type !== "notebook") || !node.fileId) return;
  const newFileId = await state.duplicateFile(node.fileId);
  if (!newFileId) return;
  const newNode = { id: crypto.randomUUID(), type: node.type, name: node.name + " copy", fileId: newFileId, children: [], flagged: false };
  insertAfter(state.fileTree, nodeId, newNode);
  await state.saveFileTree();
}
