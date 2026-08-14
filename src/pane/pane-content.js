/**
 * Content I/O for floating panes — load on create, save on dirty,
 * bidirectional sync with the main editor / notebook canvas.
 *
 * Pulled out of pane-manager.js to keep that file focused on lifecycle
 * and DOM. Module-level state (panes Map, appState, IS_TAURI flag,
 * notebook bridge) lives in pane-state.js.
 */
import {
  IS_TAURI, tauriInvoke, panes, appState,
  notebookBridge, syncing, setSyncing,
} from "./pane-state.js";
import { createPaneEditor, attachPaneTextDrop } from "./pane-editor.js";
import { findLockedStyleForFile } from "./pane-locked-style.js";
export { findLockedStyleForFile };
import { attachEditorTextDrag, attachNotebookTextShapeDrag, attachNotebookImageShapeDrag } from "./text-drag.js";
import { countWords } from "../editor/plugins/word-count.js";
import { createModeContext } from "../state/mode-context.js";
import { loadPdfPane, loadStackPane } from "./pane-media.js";

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
  const t = pane.fileType;
  if (t === "document") return loadDocumentPane(pane);
  if (t === "notebook") return loadNotebookPane(pane);
  if (t === "pdf") return loadPdfPane(pane);
  if (t === "stack") return loadStackPane(pane);
  // Fileless custom types mount from their own modules. A `desktop`
  // pane's `fileId` is a project's tree-node id, not a file id.
  if (t === "zotero-highlights") {
    return (await import("../zotero/highlight-pane.js")).mountZoteroHighlightPane(pane, appState);
  }
  if (t === "desktop") {
    return (await import("../desktop/desktop-pane.js")).mountDesktopPane(pane, appState);
  }
}

async function loadDocumentPane(pane) {

  const mc = createModeContext(appState);
  pane.modeContext = mc;

  const editor = createPaneEditor(pane._content, appState, () => {
    pane.dirty = true;
    // Version-snapshot cadence for pane-driven edits — the main
    // editor's keystroke counter never sees pane typing (the mirror is
    // a programmatic change), so panes count their own keystrokes and
    // savePaneContent snapshots every 30.
    pane._snapKeystrokes = (pane._snapKeystrokes || 0) + 1;
    syncDocFromPane(pane);
    updatePaneWordCount(pane);
  }, {
    modeContext: mc.proxy,
    getLocalSyncContext: () => {
      const ls = pane.localSync;
      if (!ls || !ls.folderId || !ls.relPath) return null;
      const slash = ls.relPath.lastIndexOf("/");
      const baseDir = slash >= 0 ? ls.relPath.slice(0, slash) : "";
      return { kind: "localSync", folderId: ls.folderId, baseDir };
    },
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

  // Restore the persisted editor scroll position (if any). Defer to the
  // next frame so CodeMirror has applied the document insert and laid
  // out its viewport — setting scrollTop before measure leaves the
  // editor pinned to 0. Inline panes are parked off-screen at restore
  // time and only reparented into the CM widget host once the owning
  // doc becomes the active editor — by then the first setScrollTop has
  // already run against a zero-height scroller. A short re-apply
  // schedule covers the reparent-after-measure case without a heavy
  // observer.
  if (typeof pane.editorScrollTop === "number" && pane.editorScrollTop > 0 && editor.setScrollTop) {
    const target = pane.editorScrollTop;
    const apply = () => { try { editor.setScrollTop(target); } catch (_) {} };
    requestAnimationFrame(apply);
    if (pane.inline) {
      setTimeout(apply, 100);
      setTimeout(apply, 500);
    }
  }

  // Track scroll changes so persist + sync see the latest position.
  // Throttle to 200 ms — scroll events are noisy and we only need to
  // capture the resting offset.
  if (editor.onScroll) {
    let scrollTimer = null;
    pane._scrollListenerCleanup = editor.onScroll(() => {
      const next = editor.getScrollTop();
      if (next === pane.editorScrollTop) return;
      pane.editorScrollTop = next;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        import("./pane-persistence.js").then((m) => m.schedulePersist?.()).catch(() => {});
      }, 200);
    });
  }

  // Listen for main editor changes to sync back into this pane
  pane._mainSyncHandler = () => syncDocToPane(pane);
  appState.on("doc-content-changed", pane._mainSyncHandler);

  // Cmd+drag a selection out of this pane to drop into another editor
  // or a notebook canvas.
  attachEditorTextDrag(pane.editor.view, pane._content);
  // Accept text dragged INTO the pane from outside the app (or from
  // another doc / pane). The main editor's file-drop net doesn't
  // cover panes, so without this drops fall through silently.
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
  // The pane carves around the window chrome itself — the canvas must
  // not mirror global dock footprints or window safe-area insets.
  canvas.state.paneHosted = true;
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
    // Splits and proofread metadata hydrate with the shapes, exactly as
    // the main canvas does it (`notebook-bridge.js`). They are content:
    // without them a proof opens in the pane as an ordinary notebook —
    // no page rail, no scroll wheel, splits collapsed — and the pane's
    // own autosave then writes that back over the file.
    canvas.loadShapes(snapshot.shapes, snapshot.layers, undefined, {
      splits: snapshot.splits,
      proof: snapshot.proof || null,
    });
    canvas.state.flowchart.deserialize(snapshot.flowEdges);
    // Bookmarks ride alongside shapes through the same JSON envelope; without
    // this the pane's local state stays empty and a save from the pane
    // would overwrite the disk file with no bookmarks (silent loss).
    if (Array.isArray(snapshot.bookmarks)) {
      canvas.state.bookmarks = snapshot.bookmarks;
      canvas.state.notify("bookmarks");
    }
    // Per-notebook background ride-along (pattern / spacing / opacity).
    // Pane and main canvas pull from the same file so a bg pick from
    // either side sticks across reopens.
    if (snapshot.background) {
      const bg = snapshot.background;
      if (bg.pattern) canvas.state.backgroundPattern = bg.pattern;
      if (typeof bg.spacing === "number") canvas.state.gridSpacing = bg.spacing;
      if (typeof bg.opacity === "number") canvas.state.gridOpacity = bg.opacity;
      if (typeof bg.rotationEnabled === "boolean") canvas.state.setCanvasRotationEnabled(bg.rotationEnabled);
      canvas.state.notify("theme");
      pane._notebookBackground = { ...bg };
    }
  }

  // Center the pane on the same canvas point the notebook would show
  // when opened normally (i.e. the centre of the main notebook viewport
  // with the default camera). Without this the pane shows the canvas
  // origin in its top-left corner. Deferred to the next frame so
  // pane._content has its final layout size.
  //
  // Skip when the pane is acting as a gutter — gutter mode owns
  // `state.camera` (it tracks the host doc's scrollTop), and centering
  // overwrites that with a fixed value, sending the shadow headers
  // off-screen via the per-header `y < -40 || y > canvasH + 4` cull.
  // The gutter flag is set synchronously by `useActivePaneAsGutter` /
  // hydrated by `restorePanes` before this rAF fires, so the check sees
  // the final value in both the fresh and restore paths.
  //
  // Also skip when this pane has a persisted notebookCamera — restoring
  // the user's saved pan / zoom takes precedence over the centring.
  requestAnimationFrame(() => {
    if (!canvas.state || !pane._content) return;
    if (pane.gutter) return;
    if (pane.notebookCamera) {
      canvas.state.camera = { ...pane.notebookCamera };
      canvas.state.notify("camera");
      canvas.state.rebasePinAnchor?.();
      return;
    }
    const mainC = document.getElementById("notebook-container");
    const mainW = (mainC && mainC.clientWidth) || window.innerWidth;
    const mainH = (mainC && mainC.clientHeight) || window.innerHeight;
    const paneW = pane._content.clientWidth || pane.width;
    const paneH = pane._content.clientHeight || pane.height;
    canvas.state.camera = { x: (paneW - mainW) / 2, y: (paneH - mainH) / 2, zoom: 1 };
    canvas.state.notify("camera");
    // Initial centring is a viewport placement, not a user pan — don't
    // let it drag pinned boxes along.
    canvas.state.rebasePinAnchor?.();
  });

  // Capture pan / zoom changes so they survive app open/close. Gutter
  // panes are excluded — their camera is scroll-driven (see
  // `project/gutter.js#syncCameraFromScroll`) and stashing it would round-
  // trip a meaningless value through persistedPanes.
  let cameraPersistTimer = null;
  pane._cameraChangeListener = () => {
    if (pane.gutter) return;
    const c = pane.notebook?.state?.camera;
    if (!c) return;
    pane.notebookCamera = { x: c.x, y: c.y, zoom: c.zoom };
    if (cameraPersistTimer) clearTimeout(cameraPersistTimer);
    cameraPersistTimer = setTimeout(() => {
      cameraPersistTimer = null;
      import("./pane-persistence.js").then((m) => m.schedulePersist?.()).catch(() => {});
    }, 200);
  };
  pane._content.addEventListener("notebook-camera-change", pane._cameraChangeListener);

  // Mark dirty + propagate shapes to main canvas on changes
  pane._content.addEventListener("notebook-change", () => {
    pane.dirty = true;
    syncNotebookFromPane(pane);
  });

  // Per-notebook background overrides — pane popup dispatches on document
  // and tags its state ref so we can filter to this pane's canvas.
  const onPaneBgChange = (e) => {
    const d = e.detail || {};
    if (d.state !== pane.notebook.state) return;
    pane.dirty = true;
  };
  document.addEventListener("notebook-bg-changed", onPaneBgChange);
  pane._bgChangeListener = onPaneBgChange;

  // Listen for main canvas changes to sync back into this pane
  pane._mainNbSyncHandler = () => syncNotebookToPane(pane);
  appState.on("notebook-shapes-changed", pane._mainNbSyncHandler);

  // Cmd+drag text or image shapes out of this notebook pane.
  const nbCanvas = pane._content.querySelector("canvas");
  if (nbCanvas && pane.notebook) {
    try {
      const { findShapeAtPoint, hitTestLink, openSoleLinkOf } = await import("../notebook/state-helpers.ts");
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
          openSoleLink: openSoleLinkOf,
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
  // These types own their own persistence (or have no file behind them).
  if (["pdf", "stack", "zotero-highlights", "desktop"].includes(pane.fileType)) { pane.dirty = false; return; }
  if (!pane.dirty) return;
  pane.dirty = false;

  try {
    if (IS_TAURI) {
      let content = "";
      if (pane.fileType === "document" && pane.editor) {
        content = pane.editor.getContent();
      } else if (pane.fileType === "notebook" && pane.notebook) {
        const { encodeNotebookContent } = await import("../notebook/notebook-content.ts");
        // In gutter mode `state.camera.y` is driven by the host doc's
        // scrollTop (see `project/gutter.js#syncCameraFromScroll`) rather
        // than tracking a meaningful canvas viewport. Persisting it
        // would write a scroll-tied value into the file, and on the
        // next mount the main-canvas restore path
        // (`notebook-bridge.js`) would seed the canvas at that bogus
        // position. `_gutterPrev.camera` snapshots the pane's camera
        // at the moment the gutter mode was entered — that's the
        // right value to round-trip.
        const cameraToSave = pane.gutter
          ? (pane._gutterPrev?.camera || null)
          : pane.notebook.state.camera;
        content = encodeNotebookContent({
          shapes: pane.notebook.getShapes(),
          layers: pane.notebook.state.layers,
          flowEdges: pane.notebook.state.flowchart.serialize(),
          // Persist bookmarks + camera so a pane save doesn't drop the
          // user's saved viewports. Without these the pane path silently
          // loses every bookmark the moment it autosaves the file.
          bookmarks: pane.notebook.state.bookmarks,
          camera: cameraToSave,
          background: {
            pattern: pane.notebook.state.backgroundPattern,
            spacing: pane.notebook.state.gridSpacing,
            opacity: pane.notebook.state.gridOpacity,
            rotationEnabled: pane.notebook.state.canvasRotationEnabled,
          },
          // Same reason as the bookmarks above: the pane holds the whole
          // notebook, so its save has to write the whole notebook.
          splits: pane.notebook.state.splits,
          proof: pane.notebook.state.proof ?? undefined,
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
        // Report through the external-store content hook (no-op today;
        // the desk-folder write-through re-attaches here). When the same
        // file is also open in the main editor, syncDocFromPane
        // propagates the pane's content under a pull lock — the main
        // editor's autosave stays quiet for this file.
        if (appState) appState.syncFileToExternal(pane.fileId, content);
      }
      // Mirror the main editor's "name follows first line" behaviour for
      // panes — without this, docs created via "New Document as Pane"
      // never pick up a name and stay "Untitled". Skip Local Sync (its
      // filename is on disk) and the file currently open in the main
      // editor (saveCurrentFile already handles it).
      if (!pane.localSync && pane.fileType === "document"
          && appState && pane.fileId !== appState.currentFileId) {
        await appState.maybeRenameFileFromContent(pane.fileId, content);
      }
      // Version snapshots for pane-driven edits — they previously never
      // reached the snapshots table at all. Docs follow the main
      // editor's 30-keystroke cadence; notebook panes mirror the main
      // canvas's snapshot-per-successful-autosave behaviour (skipped
      // when the same notebook is also the open main canvas, whose
      // bridge autosave already snapshots it).
      const snapDocId = pane.localSync
        ? `localsync:${pane.localSync.folderId}:${pane.localSync.relPath}`
        : pane.fileId;
      if (pane.fileType === "document" && (pane._snapKeystrokes || 0) >= 30) {
        pane._snapKeystrokes = 0;
        try { await tauriInvoke("create_snapshot", { documentId: snapDocId, content }); }
        catch (_) {}
      } else if (pane.fileType === "notebook"
          && pane.fileId !== appState?.currentNotebookFileId) {
        try { await tauriInvoke("create_snapshot", { documentId: snapDocId, content }); }
        catch (_) {}
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
    appState.acquirePullLock(pane.fileId);
    try {
      appState.editor.setContent(content);
      try { mainView.dispatch({ selection: { anchor, head } }); } catch (_) {}
    } finally {
      appState.releasePullLock();
    }
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
    // The mirror is a programmatic change, so the editor's onChange
    // (which used to refresh the chip) no longer fires — do it here.
    updatePaneWordCount(pane);
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
    // Mirror (not load): the main canvas keeps its undo history and
    // records this change as a checkpoint, so pane-made edits stay
    // undoable from the main surface. Flowchart edges + bookmarks ride
    // in the same snapshot.
    mainCanvas.mirrorContent({
      shapes: JSON.parse(JSON.stringify(pane.notebook.getShapes())),
      flowEdges: pane.notebook.state.flowchart.serialize(),
      bookmarks: JSON.parse(JSON.stringify(pane.notebook.state.bookmarks || [])),
    });
    // Defer reset: the mirror triggers change events via queueMicrotask,
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
    // Mirror (not load) — see syncNotebookFromPane: the pane keeps its
    // own undo history and records main-canvas changes as checkpoints.
    pane.notebook.mirrorContent({
      shapes: JSON.parse(JSON.stringify(mainCanvas.getShapes())),
      flowEdges: mainCanvas.state.flowchart.serialize(),
      bookmarks: JSON.parse(JSON.stringify(mainCanvas.state.bookmarks || [])),
    });
    pane.dirty = false;
    queueMicrotask(() => queueMicrotask(() => setSyncing(false)));
    deferred = true;
  } finally {
    if (!deferred) setSyncing(false);
  }
}

