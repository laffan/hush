/**
 * Tree node operations — extracted from state.js to keep under 700 lines.
 * Each function takes the AppState instance as the first argument.
 */

import { findNode, findNodeByFileId, removeNode, insertNode, insertAfter, collectDocumentIds, enforceSpecialPositions, uniqueChildName, findParentOfNode } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function createTreeNode(state, command, type, name, parentId) {
  const { AppState } = await import("./state.js");
  // Avoid same-type sibling collisions so two folders/projects can't
  // share a name (names map to on-disk paths).
  const parentNode = parentId ? findNode(state.fileTree, parentId) : { children: state.fileTree };
  const finalName = uniqueChildName(parentNode, name, type);
  if (IS_TAURI) {
    try {
      const created = await tauriInvoke(command, { name: finalName, parentId });
      state.fileTree = await tauriInvoke("get_file_tree");
      // Rust `create_folder` / `create_project` append to children, so
      // re-pin specials so the new entry sits above Inbox/Images/Trash.
      enforceSpecialPositions(state.fileTree);
      await state.saveFileTree();
      state.syncCreateNode(created.id, type);
      return created;
    } catch (e) { console.error(`Create ${type} failed:`, e); }
  } else {
    const node = { id: crypto.randomUUID(), type, name: finalName, children: [], flagged: false };
    insertNode(state.fileTree, node, parentId, findNode);
    enforceSpecialPositions(state.fileTree);
    state._saveTreeLocal();
    state.emit("files-changed");
    return node;
  }
}

export async function deleteTreeNode(state, nodeId) {
  // Special nodes (Inbox / Images / Trash) — global or per-desk — and
  // top-level desk nodes themselves are not deletable through this path.
  // Removing a desk goes through Archive (sidebar/desk-archive.js).
  if (state.isSpecialNodeId(nodeId)) return;
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (node.type === "desk") return;
  if (state.isInTrash(nodeId)) return permanentDeleteNode(state, nodeId);
  // PDF aliases (and a project's own PDFs folder of aliases) are pure
  // references — deleting one removes just the reference, never the desk
  // copy, and references don't take a trip through Trash.
  if (node.pdfAlias || node.pdfFolder) {
    removeNode(state.fileTree, nodeId);
    const { pruneEmptyPdfFolders } = await import("./state-pdf-aliases.js");
    pruneEmptyPdfFolders(state.fileTree);
    await state.saveFileTree();
    state.emit("files-changed");
    return;
  }
  await state.syncDeleteNode(nodeId);
  // Purge any markdown refs to deleted images before detaching the node
  // so the regex still has the filenames in the tree snapshot.
  const { imageFileIds: removedImageIds } = collectTypedFileIds(node);
  if (removedImageIds.length) {
    const { removeImageRefs } = await import("./state-images.js");
    await removeImageRefs(state, removedImageIds);
  }
  const removed = removeNode(state.fileTree, nodeId);
  if (removed) {
    clearFlaggedRecursive(removed);
    // Send to the active desk's Trash (or the global Trash when desks
    // are off). For nodes that already lived inside a specific desk's
    // trash branch, we still route to the active trash — easier to
    // empty in one place.
    const trash = findNode(state.fileTree, state.getTrashId());
    if (trash) (trash.children || (trash.children = [])).push(removed);
  }
  const { docFileIds, pdfFileIds, stackFileIds } = collectTypedFileIds(node);
  // A PDF removed from the desk takes its project aliases with it.
  if (pdfFileIds.length) {
    const { removeAliasesForFileIds } = await import("./state-pdf-aliases.js");
    removeAliasesForFileIds(state.fileTree, pdfFileIds);
  }
  await state.saveFileTree();
  // Close any open panes backed by a file we just removed so they don't
  // linger orphaned — most importantly a gutter notebook: deleting the
  // gutter file detaches it from its doc (the node, with its `gutter`
  // marker, left the project) and the gutter pane closes here.
  const deletedFileIds = new Set([...docFileIds, ...pdfFileIds, ...stackFileIds]);
  if (deletedFileIds.size) {
    try {
      const [{ panes }, { closePane }] = await Promise.all([
        import("../pane/pane-state.js"),
        import("../pane/pane-manager.js"),
      ]);
      const victims = [];
      for (const [id, p] of panes) {
        if (p.fileId && deletedFileIds.has(p.fileId)) victims.push(id);
      }
      for (const id of victims) closePane(id);
    } catch (_) {}
  }
  if (docFileIds.includes(state.currentNotebookFileId)) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (pdfFileIds.includes(state.currentPdfFileId)) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (stackFileIds.includes(state.currentStackFileId)) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  if (docFileIds.includes(state.currentFileId) || nodeId === state.currentProjectId || docFileIds.includes(state.currentNotebookFileId) || pdfFileIds.includes(state.currentPdfFileId) || stackFileIds.includes(state.currentStackFileId)) {
    // The open surface was just deleted. Drop to the "no file selected"
    // pane instead of jumping to an arbitrary DB file (which often lived
    // in a different desk).
    await state.clearActiveFile();
  }
  state.emit("files-changed");
}

async function permanentDeleteNode(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const { docFileIds, imageFileIds, pdfFileIds, stackFileIds } = collectTypedFileIds(node);
  await deleteDocFilesByIds(state, docFileIds);
  await deleteImageFilesByIds(state, imageFileIds);
  await deletePdfFilesByIds(state, pdfFileIds);
  await deleteStackFilesByIds(state, stackFileIds);
  removeNode(state.fileTree, nodeId);
  if (pdfFileIds.length) {
    const { removeAliasesForFileIds } = await import("./state-pdf-aliases.js");
    removeAliasesForFileIds(state.fileTree, pdfFileIds);
  }
  await finalizeFileDeletion(state, docFileIds);
}

export async function restoreFromTrash(state, nodeId) {
  if (!state.isInTrash(nodeId)) return;
  const node = removeNode(state.fileTree, nodeId);
  if (!node) return;
  const inbox = findNode(state.fileTree, state.getInboxId());
  if (inbox) (inbox.children || (inbox.children = [])).push(node);
  await state.saveFileTree();
  state.emit("files-changed");
}

export async function permanentDelete(state, nodeId) {
  if (!state.isInTrash(nodeId)) return;
  await permanentDeleteNode(state, nodeId);
  await state.saveFileTree();
  state.emit("files-changed");
}

export async function emptyTrash(state, deskId) {
  // With desks on, callers can pass a specific deskId to empty just
  // that desk's trash. Default empties the active desk's trash (or
  // the global trash when desks are off).
  const trashId = deskId
    ? `__trash__:${deskId}`
    : state.getTrashId();
  const trash = findNode(state.fileTree, trashId);
  if (!trash?.children?.length) return;
  const docFileIds = [];
  const imageFileIds = [];
  const pdfFileIds = [];
  const stackFileIds = [];
  for (const child of trash.children) {
    const typed = collectTypedFileIds(child);
    docFileIds.push(...typed.docFileIds);
    imageFileIds.push(...typed.imageFileIds);
    pdfFileIds.push(...typed.pdfFileIds);
    stackFileIds.push(...typed.stackFileIds);
  }
  await deleteDocFilesByIds(state, docFileIds);
  await deleteImageFilesByIds(state, imageFileIds);
  await deletePdfFilesByIds(state, pdfFileIds);
  await deleteStackFilesByIds(state, stackFileIds);
  trash.children = [];
  if (pdfFileIds.length) {
    const { removeAliasesForFileIds } = await import("./state-pdf-aliases.js");
    removeAliasesForFileIds(state.fileTree, pdfFileIds);
  }
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
  const pdfFileIds = [];
  const stackFileIds = [];
  function walk(n) {
    if (!n) return;
    if ((n.type === "document" || n.type === "notebook") && n.fileId) docFileIds.push(n.fileId);
    else if (n.type === "image" && n.fileId) imageFileIds.push(n.fileId);
    // Aliases share the original's fileId — counting them here would
    // let a deleted project purge the desk's actual PDF binary.
    else if (n.type === "pdf" && n.fileId && !n.pdfAlias) pdfFileIds.push(n.fileId);
    else if (n.type === "stack" && n.fileId) stackFileIds.push(n.fileId);
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return { docFileIds, imageFileIds, pdfFileIds, stackFileIds };
}

async function deleteDocFilesByIds(state, fileIds) {
  for (const fid of fileIds) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fid }); } catch (e) { console.error("Delete file:", e); }
      try { await tauriInvoke("delete_document_snapshots", { documentId: fid }); } catch (e) { console.error("Delete snapshots:", e); }
    } else { state.files = state.files.filter(f => f.id !== fid); }
  }
}

async function deleteImageFilesByIds(state, fileIds) {
  if (!fileIds.length) return;
  const { clearImageCache } = await import("./state-images.js");
  for (const fid of fileIds) {
    clearImageCache(fid);
    if (IS_TAURI) {
      try { await tauriInvoke("delete_image", { filename: fid }); } catch (e) { console.error("Delete image:", e); }
    }
  }
}

async function deletePdfFilesByIds(state, fileIds) {
  for (const fid of fileIds) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_pdf", { fileId: fid }); } catch (e) { console.error("Delete PDF:", e); }
    }
    try {
      const { removePdfEntry } = await import("../sync/pdf-sync.js");
      await removePdfEntry(fid);
    } catch (e) { console.error("Remove PDF registry entry:", e); }
  }
}

async function deleteStackFilesByIds(state, fileIds) {
  for (const fid of fileIds) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fid }); } catch (e) { console.error("Delete stack:", e); }
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
  if (fileIds.includes(state.currentPdfFileId)) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (fileIds.includes(state.currentFileId) || fileIds.includes(state.currentNotebookFileId) || fileIds.includes(state.currentPdfFileId)) {
    // The open surface was just permanently deleted — drop to the "no
    // file selected" pane rather than jumping to an arbitrary DB file.
    await state.clearActiveFile();
  }
  state.emit("files-changed");
}

export async function renameTreeNode(state, nodeId, newName) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  // Desks are renamed through state.renameDesk so settings.desks stays
  // in sync with the tree. Route through there if a caller hits this
  // path with a desk node.
  if (node.type === "desk") {
    return state.renameDesk(nodeId, newName);
  }
  const oldName = node.name;
  if (node.type === "image" && node.fileId) {
    const { renameImageFile } = await import("./state-images.js");
    const finalName = await renameImageFile(state, node.fileId, newName);
    node.fileId = finalName;
    node.name = finalName;
    await state.saveFileTree();
    state.emit("files-changed");
    return;
  }
  // Same-type siblings can't share a name (would map to the same
  // on-disk path). Auto-suffix on collision; the node's own id is
  // excluded from the check so the rename is a no-op when the user
  // re-types the existing name.
  const parent = findParentOfNode(state.fileTree, nodeId);
  const finalName = uniqueChildName(parent, newName, node.type, nodeId);
  if (finalName === oldName) return;
  node.name = finalName;
  if ((node.type === "document" || node.type === "notebook" || node.type === "pdf") && node.fileId) {
    if (IS_TAURI) {
      try {
        await tauriInvoke("rename_file", { id: node.fileId, name: finalName });
        // Patch the cache in place instead of re-reading the whole
        // library. `list_files` loads every file's full content across
        // the IPC bridge — and this path runs on every 1.5 s typing
        // pause while a first line is being composed (the idle-debounce
        // title rename), which stalled typing exactly the way the old
        // autosave-path list_files did (see saveCurrentFile).
        const cached = state.files.find((f) => f.id === node.fileId);
        if (cached) cached.name = finalName;
        else state.files = await tauriInvoke("list_files");
      }
      catch (e) { console.error("Rename failed:", e); }
    } else {
      const file = state.files.find((f) => f.id === node.fileId);
      if (file) file.name = finalName;
      state._saveFilesLocal();
    }
  }
  await state.saveFileTree();
  // Rewrite every `[[oldName]]` reference across the user's docs and
  // notebooks so existing wikilinks keep resolving after the rename.
  // Folders / projects / desks aren't link targets so the helper exits
  // early on those types.
  try {
    const { propagateWikilinkRename } = await import("../links/wikilink-rename.js");
    await propagateWikilinkRename(state, oldName, finalName, node.type);
  } catch (e) {
    console.error("wikilink rename propagation failed:", e);
  }
  state.syncRenameNode(nodeId, oldName, node.type);
}

export async function toggleFlagged(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  node.flagged = !node.flagged;
  // Flagged PDFs float to the top of their PDFs folder (the shelf's
  // flag feature) — keep that ordering current however the flag flips.
  if (node.type === "pdf") {
    const { enforceFlaggedPdfOrder } = await import("./state-pdf-aliases.js");
    enforceFlaggedPdfOrder(state.fileTree);
  }
  await state.saveFileTree();
}

/** Flip a doc inside a project between "main flow" (joins the project's
 *  editor buffer) and "Use as Note" (sorts with notebooks under the
 *  buffer at 50 % opacity). No-op for non-document nodes. The flag is
 *  persisted on the tree node and round-trips through `save_file_tree`
 *  alongside flagged / lockedStyleId. */
export async function toggleUseAsNote(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || node.type !== "document") return;
  node.useAsNote = !node.useAsNote;
  // Re-normalize so the sidebar order tracks the new flag immediately.
  const { normalizeProjectChildren } = await import("./tree-helpers.js");
  normalizeProjectChildren(state.fileTree);
  await state.saveFileTree();
  state.emit("files-changed");
  // If the user is currently viewing the project this doc lives in,
  // re-open it so the joined buffer drops (or re-includes) the doc.
  if (state.currentProjectId) {
    const project = findNode(state.fileTree, state.currentProjectId);
    if (project && project.children?.some((c) => c.id === nodeId)) {
      await state.openProject(state.currentProjectId);
    }
  }
}

/** Convert a Folder ↔ Project. The two types are structurally
 *  identical in the tree (children stay put); only the `type` field
 *  changes. Project → Folder loses ordering and the joined preview but
 *  no files are deleted. The full project list is re-pushed via
 *  `.hush/projects.json` so other devices learn about the conversion. */
export async function convertContainerType(state, nodeId, targetType) {
  if (targetType !== "folder" && targetType !== "project") return;
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (node.type === targetType) return;
  if (node.type !== "folder" && node.type !== "project") return;
  const wasProject = node.type === "project";
  // Demoting a project to a folder dissolves the project's special
  // structure: a folder has no joined buffer for a gutter to track, so the
  // gutter notebook is unpaired back into a normal sibling. (The child files
  // themselves already live in the container, so there's nothing else to
  // "unpack" in the current tree model.)
  if (wasProject && targetType === "folder") {
    for (const c of (node.children || [])) {
      if (c.gutter) delete c.gutter;
    }
    // The project's PDFs folder holds aliases — references that only
    // make sense on a project — so demotion drops it (desk copies are
    // untouched).
    if (Array.isArray(node.children)) {
      node.children = node.children.filter((c) => !(c?.type === "folder" && c.pdfFolder));
    }
    if (node.showNumbers) delete node.showNumbers;
    if (state.gutterAssignments) delete state.gutterAssignments[nodeId];
  }
  node.type = targetType;
  await state.saveFileTree();
  state.emit("files-changed");
  // Re-push the projects registry so peers see the converted node. Both
  // directions: a new project gets added to the list, a demoted one is
  // dropped from it. Receiving devices fold the list (`applyProjectsFile`
  // flips matching folders to projects on import).
  state.syncProjectOrdering(nodeId);
  // When a project is demoted to a folder, remove it from any stacks
  // that reference it — the project fileType is no longer valid.
  if (wasProject && targetType === "folder") {
    state.emit("project-demoted", nodeId);
  }
}

export async function duplicateTreeNode(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node || (node.type !== "document" && node.type !== "notebook") || !node.fileId) return;
  const newFileId = await state.duplicateFile(node.fileId);
  if (!newFileId) return;
  const newNode = { id: crypto.randomUUID(), type: node.type, name: node.name + "-Copy", fileId: newFileId, children: [], flagged: false, ...(node.bgColor ? { bgColor: node.bgColor } : {}) };
  insertAfter(state.fileTree, nodeId, newNode);
  await state.saveFileTree();
}
