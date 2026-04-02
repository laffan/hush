/**
 * Project view operations — extracted from state.js to keep under 700 lines.
 * Each function takes the AppState instance as the first argument.
 */

import { findNode, collectDocumentIds } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function openProject(state, projectId) {
  if (state.dirty) await state.saveCurrentFile();
  const node = findNode(state.fileTree, projectId);
  if (!node || node.type !== "project") return;
  state.currentProjectId = projectId;
  state.currentFileId = null;
  state.projectDocIds = collectDocumentIds(node.children || []);
  let ordered = [];
  if (IS_TAURI) {
    for (const fid of state.projectDocIds) {
      try { ordered.push(await tauriInvoke("load_file", { id: fid })); } catch (e) { /* skip */ }
    }
  } else { ordered = state.projectDocIds.map(fid => state.files.find(e => e.id === fid)).filter(Boolean); }
  if (state.editor) state.editor.setContent(ordered.map(e => e.content).join("\n\n---hush-separator---\n\n"));
  state.emit("file-opened");
  state.updateSettings({ lastProjectId: projectId, lastFileId: null });
}

export async function saveProjectContent(state) {
  if (!state.currentProjectId || !state.editor || !state.projectDocIds.length) return;
  const parts = state.editor.getContent().split("\n\n---hush-separator---\n\n");
  for (let i = 0; i < state.projectDocIds.length && i < parts.length; i++) {
    const fid = state.projectDocIds[i], content = parts[i] || "";
    if (IS_TAURI) {
      try {
        await tauriInvoke("save_file", { id: fid, content });
        state.syncFileToExternal(fid, content);
      } catch (e) { /* skip */ }
    }
    else { const f = state.files.find(f => f.id === fid); if (f) { f.content = content; f.modified = Math.floor(Date.now()/1000); f.name = state._deriveName(f.content); } }
  }
  state.dirty = false;
  if (IS_TAURI) state.files = await tauriInvoke("list_files");
  else state._saveFilesLocal();
  state.emit("files-changed");
  // Update project ordering JSON
  state.syncProjectOrdering(state.currentProjectId);
}
