/** Session identity is per window, and all last-surface slots are exclusive. */
import { findNode, findNodeByFileId } from "./tree-helpers.js";

export const PER_WINDOW_SETTINGS_KEYS = new Set([
  "lastFileId", "lastNotebookId", "lastProjectId", "lastPdfId", "lastStackId", "lastLocalSync",
  "activeDeskId", "scrollPosition", "typewriterMode", "dryMode", "sidebarOpenPanel", "sidebarPinned",
]);

export function preserveWindowSettings(settings) {
  return Object.fromEntries([...PER_WINDOW_SETTINGS_KEYS].map(key => [key, settings[key]]));
}

export function currentSurface(state) {
  for (const [key, fileType] of [
    ["currentStackFileId", "stack"], ["currentPdfFileId", "pdf"],
    ["currentNotebookFileId", "notebook"], ["currentProjectId", "project"], ["currentFileId", "document"],
  ]) {
    if (state[key]) return { fileId: state[key], fileType };
  }
  return null;
}

export function sessionSettings(state) {
  const patch = {
    lastFileId: null, lastNotebookId: null, lastProjectId: null,
    lastPdfId: null, lastStackId: null, lastLocalSync: state.currentLocalSync || null,
  };
  const surface = currentSurface(state);
  // Local Folder canvases use ls: sentinels; only the descriptor is restorable.
  if (surface && !state.currentLocalSync && !surface.fileId.startsWith("ls:")) {
    const key = { document: "lastFileId", notebook: "lastNotebookId", project: "lastProjectId", pdf: "lastPdfId", stack: "lastStackId" }[surface.fileType];
    patch[key] = surface.fileId;
  }
  return patch;
}

function validSurface(state, nodes, fileId, fileType) {
  if (!fileId) return null;
  const node = fileType === "project" ? findNode(nodes, fileId) : findNodeByFileId(nodes, fileId);
  if (!node || node.type !== fileType) return null;
  if ((fileType === "document" || fileType === "notebook") && !state.files.some(f => f.id === fileId)) return null;
  return { fileId, fileType };
}

/** Pick before mounting: never decode a foreign desk's notebook just to discard it. */
export function startupSurface(state, { initialFile = null, initialDesk = null, windowSession = null } = {}) {
  const settings = state.settings;
  const deskId = initialDesk || settings.activeDeskId;
  const desk = state.fileTree.find(n => n.type === "desk" && n.id === deskId)
    || state.fileTree.find(n => n.type === "desk");
  const nodes = desk ? desk.children || [] : state.fileTree;
  if (initialFile) return validSurface(state, nodes, initialFile.fileId, initialFile.fileType);
  // An explicitly empty new window must not borrow main's saved file.
  if (initialDesk) return null;
  for (const [key, type] of [
    ["lastStackId", "stack"], ["lastPdfId", "pdf"], ["lastNotebookId", "notebook"],
    ["lastProjectId", "project"], ["lastFileId", "document"],
  ]) {
    const surface = validSurface(state, nodes, settings[key], type);
    if (surface) return surface;
  }
  for (const local of [settings.lastLocalSync, !windowSession && settings.deskLastLocalSync?.[desk?.id]]) {
    if (local?.folderId && local.relPath && settings.localSyncFolders?.some(f => f.id === local.folderId && (!f.deskId || f.deskId === desk?.id))) {
      return { localSync: local };
    }
  }
  // Old global slots may belong to another desk after a switch or a
  // sibling settings merge. Recover this desk's own saved landing file.
  if (windowSession) return null;
  const last = settings.desksMeta?.[desk?.id];
  return last ? validSurface(state, nodes, last.lastFileId, last.lastFileType) : null;
}

export function restoreStartupSurface(state, opts) {
  const surface = startupSurface(state, opts);
  if (!surface) return;
  if (surface.localSync) { state.runtime.pendingLocalSync = { ...surface.localSync }; return; }
  const key = { document: "currentFileId", notebook: "currentNotebookFileId", project: "currentProjectId", pdf: "currentPdfFileId", stack: "currentStackFileId" }[surface.fileType];
  state[key] = surface.fileId;
}
