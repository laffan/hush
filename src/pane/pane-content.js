/**
 * Content I/O for floating panes — load on create, save on dirty,
 * bidirectional sync with the main editor / notebook canvas.
 *
 * Pulled out of pane-manager.js to keep that file focused on lifecycle
 * and DOM. Module-level state (panes Map, appState, IS_TAURI flag,
 * notebook bridge) lives in pane-state.js.
 */
import {
  IS_TAURI,
  tauriInvoke,
  panes,
  appState,
  notebookBridge,
  syncing,
  setSyncing,
} from "./pane-state.js";
import { createPaneEditor } from "./pane-editor.js";
import { attachEditorTextDrag, attachNotebookTextShapeDrag, attachNotebookImageShapeDrag } from "./text-drag.js";
import { countWords } from "../editor/plugins/word-count.js";

/** Update a pane's word-count chip from the current editor content.
 *  Notebook panes don't have a word count. The chip itself is created
 *  in `buildPaneDOM` (pane-manager.js); this function just refreshes its
 *  text and visibility. */
export function updatePaneWordCount(pane) {
  const el = pane._wordCountEl;
  if (!el) return;
  const visible = !!appState?.settings?.wordCountVisible
    && pane.fileType === "document"
    && !!pane.editor;
  if (!visible) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  const n = countWords(pane.editor.getContent());
  el.textContent = `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;
  el.style.display = "";
}

/** Refresh every pane's word-count chip — used when the user toggles
 *  the global `wordCountVisible` setting on or off. */
export function syncAllPaneWordCounts() {
  for (const [, pane] of panes) updatePaneWordCount(pane);
}

export async function loadPaneContent(pane) {
  if (pane.fileType === "document") {
    await loadDocumentPane(pane);
  } else if (pane.fileType === "notebook") {
    await loadNotebookPane(pane);
  }
}

async function loadDocumentPane(pane) {

  const editor = createPaneEditor(pane._content, appState, () => {
    pane.dirty = true;
    syncDocFromPane(pane);
    updatePaneWordCount(pane);
  });
  pane.editor = editor;

  // Apply the active style (or the locked style for this document) at
  // creation time so the pane opens with the right theme, font, AND
  // color overrides. Local Sync files aren't in the internal tree so
  // they never have a locked style — they pick up the session style.
  // Calling reconfigureTheme unconditionally also handles the
  // colour-override path (applyStyleColorsToView in pane-editor.js)
  // which is what makes panes track --bg / --fg overrides.
  if (editor.reconfigureTheme) {
    const lockedStyleId = pane.localSync ? null : findLockedStyleForFile(pane.fileId);
    editor.reconfigureTheme(appState.settings, lockedStyleId);
  }

  // Load file content — Local Sync panes read straight from disk via
  // the local_sync_read_file command; everything else goes through the
  // internal file store.
  let content = "";
  try {
    if (IS_TAURI) {
      if (pane.localSync) {
        const { readFile } = await import("../sync/local-sync.js");
        content = await readFile(pane.localSync.folderId, pane.localSync.relPath);
      } else {
        const file = await tauriInvoke("load_file", { id: pane.fileId });
        content = file.content || "";
      }
    }
  } catch (e) {
    console.error("Failed to load pane file:", e);
  }
  editor.setContent(content);
  updatePaneWordCount(pane);

  // Listen for main editor changes to sync back into this pane
  pane._mainSyncHandler = () => syncDocToPane(pane);
  appState.on("doc-content-changed", pane._mainSyncHandler);

  // Cmd+drag a selection out of this pane to drop into another editor
  // or a notebook canvas.
  attachEditorTextDrag(pane.editor.view, pane._content);
  // Accept text dragged INTO the pane from outside the app (or from
  // another doc / pane). The main editor's file-drop net doesn't
  // cover panes, so without this drops fall through silently.
  const { attachPaneTextDrop } = await import("./pane-editor.js");
  attachPaneTextDrop(pane);
  // Cmd+drag image chips / raw image refs in a pane so they can be moved
  // between panes just like any other markdown text.
  import("../editor/plugins/image-decorator.js").then((m) => {
    if (pane.editor && pane._content) m.attachImageDrag(pane.editor.view, pane._content, appState);
  });
}

async function loadNotebookPane(pane) {

  const { NotesCanvas } = await import("../notebook/notes-canvas.ts");
  const { computeNotebookSettings } = await import("../notebook/notebook-bridge.js");
  const s = appState.settings;
  const shortcuts = {
    shortcutNbSelect: s.shortcutNbSelect,
    shortcutNbText: s.shortcutNbText,
    shortcutNbDragArea: s.shortcutNbDragArea,
    shortcutNbBrainstorm: s.shortcutNbBrainstorm,
    shortcutNbDelete: s.shortcutNbDelete,
    shortcutNbUndo: s.shortcutNbUndo,
    shortcutNbRedo: s.shortcutNbRedo,
    shortcutNbGroup: s.shortcutNbGroup,
    shortcutNbUngroup: s.shortcutNbUngroup,
  };

  const canvas = new NotesCanvas(pane._content, shortcuts);
  pane.notebook = canvas;

  // Inherit the current Hush editor style (appearance/theme/font/grid) —
  // if the notebook has a locked style, that takes precedence.
  const lockedStyleId = findLockedStyleForFile(pane.fileId);
  canvas.applySettings(computeNotebookSettings(appState, lockedStyleId));

  // Load shapes + layers + flowchart edges through the canonical
  // envelope decoder so panes match the main canvas's persistence.
  let snapshot = null;
  try {
    if (IS_TAURI) {
      const file = await tauriInvoke("load_file", { id: pane.fileId });
      const { decodeNotebookContent } = await import("../notebook/notebook-content.ts");
      snapshot = decodeNotebookContent(file.content);
    }
  } catch (e) {
    console.error("Failed to load notebook pane shapes:", e);
  }

  if (snapshot) {
    canvas.loadShapes(snapshot.shapes, snapshot.layers);
    canvas.state.flowchart.deserialize(snapshot.flowEdges);
  }

  // Center the pane on the same canvas point the notebook would show
  // when opened normally (i.e. the centre of the main notebook viewport
  // with the default camera). Without this the pane shows the canvas
  // origin in its top-left corner. Deferred to the next frame so
  // pane._content has its final layout size.
  requestAnimationFrame(() => {
    if (!canvas.state || !pane._content) return;
    const mainC = document.getElementById("notebook-container");
    const mainW = (mainC && mainC.clientWidth) || window.innerWidth;
    const mainH = (mainC && mainC.clientHeight) || window.innerHeight;
    const paneW = pane._content.clientWidth || pane.width;
    const paneH = pane._content.clientHeight || pane.height;
    canvas.state.camera = { x: (paneW - mainW) / 2, y: (paneH - mainH) / 2, zoom: 1 };
    canvas.state.notify("camera");
  });

  // Mark dirty + propagate shapes to main canvas on changes
  pane._content.addEventListener("notebook-change", () => {
    pane.dirty = true;
    syncNotebookFromPane(pane);
  });

  // Listen for main canvas changes to sync back into this pane
  pane._mainNbSyncHandler = () => syncNotebookToPane(pane);
  appState.on("notebook-shapes-changed", pane._mainNbSyncHandler);

  // Cmd+drag text or image shapes out of this notebook pane.
  const nbCanvas = pane._content.querySelector("canvas");
  if (nbCanvas && pane.notebook) {
    try {
      const { findShapeAtPoint, hitTestLink } = await import("../notebook/state-helpers.ts");
      attachNotebookTextShapeDrag(
        nbCanvas,
        pane._content,
        pane.notebook.state,
        {
          findTextShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, pane.notebook.state.fontFamily);
            return hit && hit.type === "text" ? hit : null;
          },
          hitTestLink,
        },
        () => { pane.dirty = true; },
      );
      attachNotebookImageShapeDrag(
        nbCanvas,
        pane._content,
        pane.notebook.state,
        {
          findImageShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, pane.notebook.state.fontFamily);
            return hit && hit.type === "image" ? hit : null;
          },
        },
        () => { pane.dirty = true; },
      );
    } catch (e) {
      console.error("Failed to wire notebook pane drag:", e);
    }
  }
}

// ── Saving ────────────────────────────────────────────────────────────
export async function savePaneContent(pane) {
  if (!pane.dirty) return;
  pane.dirty = false;

  try {
    if (IS_TAURI) {
      let content = "";
      if (pane.fileType === "document" && pane.editor) {
        content = pane.editor.getContent();
      } else if (pane.fileType === "notebook" && pane.notebook) {
        const { encodeNotebookContent } = await import("../notebook/notebook-content.ts");
        content = encodeNotebookContent({
          shapes: pane.notebook.getShapes(),
          layers: pane.notebook.state.layers,
          flowEdges: pane.notebook.state.flowchart.serialize(),
        });
      }
      if (pane.localSync) {
        // Write back to the mounted folder on disk. The Local Sync
        // watcher would otherwise echo this change back as an external
        // update — the state's `runtime.localSyncWriteFlag` guard (in
        // sync/local-sync.js) suppresses the reload for a short window.
        if (appState) appState.runtime.localSyncWriteFlag = Date.now();
        const { writeFile } = await import("../sync/local-sync.js");
        await writeFile(pane.localSync.folderId, pane.localSync.relPath, content);
      } else {
        await tauriInvoke("save_file", { id: pane.fileId, content });
      }
    }
  } catch (e) {
    console.error("Failed to save pane content:", e);
  }
}

export function autosaveAllPanes() {
  for (const [, pane] of panes) {
    if (pane.dirty) savePaneContent(pane);
  }
}

// ── Sync between pane and main editor / notebook canvas ─────────────
export function syncDocFromPane(pane) {

  if (syncing || pane.fileType !== "document" || !pane.editor) return;
  if (pane.fileId !== appState.currentFileId || !appState.editor) return;
  setSyncing(true);
  try {
    const content = pane.editor.getContent();
    const mainView = appState.editor.view;
    const mainSel = mainView.state.selection.main;
    const anchor = Math.min(mainSel.anchor, content.length);
    const head = Math.min(mainSel.head, content.length);
    appState.runtime.syncPulling = true;
    appState.editor.setContent(content);
    try { mainView.dispatch({ selection: { anchor, head } }); } catch (_) {}
    appState.runtime.syncPulling = false;
  } finally {
    setSyncing(false);
  }
}

export function syncDocToPane(pane) {

  if (syncing || pane.fileType !== "document" || !pane.editor) return;
  if (pane.fileId !== appState.currentFileId) return;
  setSyncing(true);
  try {
    const content = appState.editor.getContent();
    const paneView = pane.editor.view;
    const paneSel = paneView.state.selection.main;
    const anchor = Math.min(paneSel.anchor, content.length);
    const head = Math.min(paneSel.head, content.length);
    pane.editor.setContent(content);
    try { paneView.dispatch({ selection: { anchor, head } }); } catch (_) {}
    // Don't mark pane dirty — this came from the main editor
    pane.dirty = false;
  } finally {
    setSyncing(false);
  }
}

export function syncNotebookFromPane(pane) {

  const bridge = notebookBridge;
  if (syncing || pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId || !bridge) return;
  const mainCanvas = bridge.getCanvasInstance();
  if (!mainCanvas) return;

  setSyncing(true);
  let deferred = false;
  try {
    const shapes = pane.notebook.getShapes();
    mainCanvas.loadShapes(JSON.parse(JSON.stringify(shapes)));
    // Mirror flowchart edges too — without this, edges added in the
    // pane wouldn't surface in the main canvas (or vice versa below).
    mainCanvas.state.flowchart.deserialize(pane.notebook.state.flowchart.serialize());
    // Defer reset: loadShapes triggers change events via queueMicrotask,
    // so syncing must stay true until those microtasks have fired.
    queueMicrotask(() => queueMicrotask(() => setSyncing(false)));
    deferred = true;
  } finally {
    // If anything threw before the deferred reset was queued, clear the
    // flag synchronously so future syncs aren't silently dropped.
    if (!deferred) setSyncing(false);
  }
}

export function syncNotebookToPane(pane) {

  const bridge = notebookBridge;
  if (syncing || pane.fileType !== "notebook" || !pane.notebook) return;
  if (pane.fileId !== appState.currentNotebookFileId || !bridge) return;
  const mainCanvas = bridge.getCanvasInstance();
  if (!mainCanvas) return;

  setSyncing(true);
  let deferred = false;
  try {
    const shapes = mainCanvas.getShapes();
    pane.notebook.loadShapes(JSON.parse(JSON.stringify(shapes)));
    pane.notebook.state.flowchart.deserialize(mainCanvas.state.flowchart.serialize());
    pane.dirty = false;
    queueMicrotask(() => queueMicrotask(() => setSyncing(false)));
    deferred = true;
  } finally {
    if (!deferred) setSyncing(false);
  }
}

/** Shared lookup used by load + theme paths. Walks the file tree for
 *  the pane's fileId and returns its `lockedStyleId`, if any. */
export function findLockedStyleForFile(fileId) {

  if (!fileId || !appState || !appState.fileTree) return null;
  function walk(nodes) {
    for (const n of nodes) {
      if (n.fileId === fileId) return n.lockedStyleId || null;
      if (n.children) {
        const r = walk(n.children);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }
  const v = walk(appState.fileTree);
  return v || null;
}
