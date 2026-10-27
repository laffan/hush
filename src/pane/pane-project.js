/**
 * Project panes — a project cmd-dragged out of the sidebar, shown the way
 * the main editor shows one: its documents joined into one buffer with
 * the dashed separators between them (state-project.js does the same for
 * the main editor). The pane's `fileId` is the project's tree-node id.
 *
 * The buffer holds the documents the project had when the pane loaded
 * (`pane._projectDocIds`), and a save splits it back into exactly those —
 * a document added to the project afterwards joins on the next load, and
 * one moved out keeps receiving its own text rather than its neighbour's.
 * While the main editor has the same project open, each side mirrors the
 * other the way a document pane does.
 */
import { IS_TAURI, tauriInvoke, appState, syncing, setSyncing } from "./pane-state.js";
import { createPaneEditor, attachPaneTextDrop } from "./pane-editor.js";
import { attachEditorTextDrag } from "./text-drag.js";
import { createModeContext } from "../state/mode-context.js";
import { findNode, collectDocumentIds } from "../state/tree-helpers.js";
import {
  SEPARATOR, createProjectViewField, createSeparatorFilter,
} from "../editor/plugins/project-view.js";

/** Split a joined buffer into `count` parts — bounded the way
 *  state-project.js bounds it, so a stray separator line can't shift
 *  text across documents. */
function splitBuffer(text, count) {
  const parts = [];
  let pos = 0;
  for (let i = 0; i < count - 1; i++) {
    const idx = text.indexOf(SEPARATOR, pos);
    if (idx === -1) break;
    parts.push(text.slice(pos, idx));
    pos = idx + SEPARATOR.length;
  }
  parts.push(text.slice(pos));
  return parts;
}

async function readDocs(ids) {
  const out = [];
  for (const id of ids) {
    let content = "";
    if (IS_TAURI) {
      try { content = (await tauriInvoke("load_file", { id })).content || ""; }
      catch (e) { console.warn(`Project pane: couldn't read ${id}:`, e); }
    } else {
      content = (appState.files || []).find((f) => f.id === id)?.content || "";
    }
    out.push(content);
  }
  return out;
}

export async function loadProjectPane(pane) {
  const node = findNode(appState.fileTree, pane.fileId);
  pane._projectDocIds = node ? collectDocumentIds(node.children || []) : [];
  // The separator plugins key off `currentProjectId`; the pane's own
  // project is the one that counts here, whatever the main editor shows.
  const projectRef = { get currentProjectId() { return pane.fileId; } };

  const mc = createModeContext(appState);
  pane.modeContext = mc;
  const editor = createPaneEditor(pane._content, appState, () => {
    pane.dirty = true;
    syncMainFromProjectPane(pane);
  }, {
    modeContext: mc.proxy,
    runway: true,
    extraExtensions: [createProjectViewField(projectRef), createSeparatorFilter(projectRef)],
  });
  pane.editor = editor;
  if (editor.reconfigureTheme) editor.reconfigureTheme(appState.settings, null);
  editor.setContent((await readDocs(pane._projectDocIds)).join(SEPARATOR));

  pane._mainSyncHandler = () => syncProjectPaneFromMain(pane);
  appState.on("doc-content-changed", pane._mainSyncHandler);
  attachEditorTextDrag(editor.view, pane._content);
  attachPaneTextDrop(pane);
  if (pane.docked) {
    requestAnimationFrame(() => {
      import("./pane-dock.js").then((m) => m.syncPaneChromeInset(pane)).catch(() => {});
    });
  }
}

/** Write each document's part of the buffer back to its file. */
export async function saveProjectPane(pane) {
  if (!pane.dirty || !pane.editor) return;
  pane.dirty = false;
  const ids = pane._projectDocIds || [];
  const parts = splitBuffer(pane.editor.getContent(), ids.length);
  for (let i = 0; i < ids.length && i < parts.length; i++) {
    const id = ids[i];
    const content = parts[i] || "";
    if (IS_TAURI) {
      try {
        await tauriInvoke("save_file", { id, content });
        appState.syncFileToExternal(id, content);
      } catch (e) { console.warn(`Project pane: couldn't save ${id}:`, e); }
    }
    const cached = (appState.files || []).find((f) => f.id === id);
    if (cached) {
      cached.content = content;
      cached.modified = Math.floor(Date.now() / 1000);
    }
  }
  appState.emit("files-changed");
}

function sameProjectInMain(pane) {
  return appState.currentProjectId === pane.fileId && !!appState.editor
    && (appState.projectDocIds || []).join() === (pane._projectDocIds || []).join();
}

function syncMainFromProjectPane(pane) {
  if (syncing || !sameProjectInMain(pane)) return;
  setSyncing(true);
  try {
    appState.acquirePullLock(pane.fileId);
    try { appState.editor.setContent(pane.editor.getContent()); }
    finally { appState.releasePullLock(); }
    // The pane saves these documents; the main editor needn't too.
    appState.dirty = false;
  } finally {
    setSyncing(false);
  }
}

function syncProjectPaneFromMain(pane) {
  if (syncing || !pane.editor || !sameProjectInMain(pane)) return;
  setSyncing(true);
  try {
    pane.editor.setContent(appState.editor.getContent());
    pane.dirty = false;
  } finally {
    setSyncing(false);
  }
}
