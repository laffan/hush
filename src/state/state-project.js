/**
 * Project view operations — extracted from state.js to keep under 700 lines.
 * Each function takes the AppState instance as the first argument.
 */

import { findNode, findNodeByFileId, collectDocumentIds, nearestAncestorProjectId } from "./tree-helpers.js";
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

/** Pair `notebookFileId` as the gutter for the document `docFileId`. A gutter
 *  belongs to a single doc, not the project. The pairing is recorded in the
 *  in-memory `state.gutterAssignments` map (keyed by docFileId → gutter
 *  notebook fileId, which survives `get_file_tree` reloads within a session)
 *  and stamped on the notebook node (`gutter`, `gutterForDoc`) for the sidebar
 *  styling + nesting. The notebook is itself named `<docName>-gutter`, so the
 *  pairing is also derivable from names across a restart / fresh device. */
export async function markGutterForDoc(state, docFileId, notebookFileId) {
  (state.gutterAssignments || (state.gutterAssignments = {}))[docFileId] = notebookFileId;
  const nb = findNodeByFileId(state.fileTree, notebookFileId);
  if (!nb || nb.type !== "notebook") return;
  nb.gutter = true;
  nb.gutterForDoc = docFileId;
  await state.saveFileTree();
  const projId = nearestAncestorProjectId(state.fileTree, nb.id);
  if (projId) state.syncProjectOrdering?.(projId);
  state.emit("files-changed");
}

/** Clear the gutter pairing for doc `docFileId` (used when the gutter is
 *  permanently unpaired — closing the gutter keeps the pairing). */
export async function unmarkGutterForDoc(state, docFileId) {
  const nbId = state.gutterAssignments && state.gutterAssignments[docFileId];
  if (state.gutterAssignments) delete state.gutterAssignments[docFileId];
  const nb = nbId ? findNodeByFileId(state.fileTree, nbId) : null;
  if (!nb) return;
  delete nb.gutter;
  delete nb.gutterForDoc;
  await state.saveFileTree();
  const projId = nearestAncestorProjectId(state.fileTree, nb.id);
  if (projId) state.syncProjectOrdering?.(projId);
  state.emit("files-changed");
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
