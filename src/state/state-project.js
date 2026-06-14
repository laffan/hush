/**
 * Project view operations — extracted from state.js to keep under 700 lines.
 * Each function takes the AppState instance as the first argument.
 */

import { findNode, collectDocumentIds } from "./tree-helpers.js";
import { SEPARATOR } from "../editor/plugins/project-view.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/**
 * Split the joined project buffer back into per-doc parts. Bounded to
 * `expectedCount - 1` separator hits so a stray `---hush-separator---`
 * line (e.g. carried over from data corrupted by an earlier version of
 * this plugin) can't bleed content across doc boundaries.
 */
function splitProjectBuffer(text, expectedCount) {
  const parts = [];
  let pos = 0;
  for (let i = 0; i < expectedCount - 1; i++) {
    const idx = text.indexOf(SEPARATOR, pos);
    if (idx === -1) break;
    parts.push(text.slice(pos, idx));
    pos = idx + SEPARATOR.length;
  }
  parts.push(text.slice(pos));
  return parts;
}

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function openProject(state, projectId) {
  const node = findNode(state.fileTree, projectId);
  if (!node || node.type !== "project") return;
  if (state.dirty) await state.saveCurrentFile();
  // Unmount any active notebook / PDF / stack so their views don't stay
  // mounted over the project editor (e.g. opening a project from a stack).
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  state.currentProjectId = projectId;
  state.currentFileId = null;
  state.projectDocIds = collectDocumentIds(node.children || []);
  let ordered = [];
  if (IS_TAURI) {
    for (const fid of state.projectDocIds) {
      try { ordered.push(await tauriInvoke("load_file", { id: fid })); }
      catch (e) { console.warn(`Project load: skipping file ${fid}:`, e); }
    }
  } else { ordered = state.projectDocIds.map(fid => state.files.find(e => e.id === fid)).filter(Boolean); }
  if (state.editor) state.editor.setContent(ordered.map(e => e.content).join(SEPARATOR));
  state.emit("file-opened");
  // Clear lastNotebookId so a notebook the user had open before
  // switching to this project doesn't reopen on next launch (init
  // checks lastNotebookId before lastProjectId).
  state.updateSettings({ lastProjectId: projectId, lastFileId: null, lastNotebookId: null });
}

/** Mark `fileId`'s notebook child as the project's gutter (and clear the
 *  flag from any sibling — at most one gutter per project). The marking is
 *  recorded two ways: (1) on the tree node so it rides the .hushproject
 *  envelope, persists across restart, and drives the sidebar styling; and
 *  (2) in an in-memory `state.gutterAssignments` map keyed by projectId,
 *  which survives `get_file_tree` reloads within a session (the tree the
 *  Rust backend returns can drop the node flag on older builds). The map is
 *  the source of truth the Open/Close/Add predicates read first. */
export async function markProjectGutterNotebook(state, projectId, fileId) {
  // In-memory assignment first — independent of the tree round-trip.
  (state.gutterAssignments || (state.gutterAssignments = {}))[projectId] = fileId;
  const node = findNode(state.fileTree, projectId);
  if (!node || node.type !== "project") return;
  let target = null;
  for (const c of (node.children || [])) {
    if (c.type === "notebook" && c.fileId === fileId) { c.gutter = true; target = c; }
    else if (c.gutter) delete c.gutter;
  }
  if (!target) return;
  await state.saveFileTree();
  state.emit("files-changed");
}

/** Clear the project's gutter marking for `fileId` (demote path). */
export async function unmarkProjectGutterNotebook(state, projectId, fileId) {
  if (state.gutterAssignments && state.gutterAssignments[projectId] === fileId) {
    delete state.gutterAssignments[projectId];
  }
  const node = findNode(state.fileTree, projectId);
  if (!node || node.type !== "project") return;
  let changed = false;
  for (const c of (node.children || [])) {
    if (c.type === "notebook" && c.fileId === fileId && c.gutter) { delete c.gutter; changed = true; }
  }
  if (!changed) return;
  await state.saveFileTree();
  state.emit("files-changed");
}

/** Find the project's gutter notebook child, if any. */
export function projectGutterChild(node) {
  if (!node || node.type !== "project") return null;
  return (node.children || []).find((c) => c.type === "notebook" && c.gutter && c.fileId) || null;
}

export async function saveProjectContent(state) {
  if (!state.currentProjectId || !state.editor || !state.projectDocIds.length) return;
  const parts = splitProjectBuffer(state.editor.getContent(), state.projectDocIds.length);
  for (let i = 0; i < state.projectDocIds.length && i < parts.length; i++) {
    const fid = state.projectDocIds[i], content = parts[i] || "";
    if (IS_TAURI) {
      try {
        await tauriInvoke("save_file", { id: fid, content });
        state.syncFileToExternal(fid, content);
      } catch (e) { console.warn(`Project save: failed to write file ${fid}:`, e); }
    }
    else {
      const f = state.files.find(f => f.id === fid);
      if (f) {
        f.content = content;
        f.modified = Math.floor(Date.now()/1000);
        if (!f.name || f.name === "Untitled") f.name = state._deriveName(f.content);
      }
    }
  }
  state.dirty = false;
  if (IS_TAURI) state.files = await tauriInvoke("list_files");
  else state._saveFilesLocal();
  state.emit("files-changed");
  // Update project ordering JSON
  state.syncProjectOrdering(state.currentProjectId);
}
