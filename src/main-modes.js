/**
 * Mode switching + initial content mount, extracted from `main.js` to keep
 * the entry point under the project's 700-line cap.
 *
 * Owns the notebook / PDF / stack "mode" machinery: the `activateMode`
 * container toggling, the `show*` helpers, every `state.on(...)` handler
 * that mounts/unmounts those surfaces, the notebook autosave + cross-window
 * broadcast, and the one-time initial mount that opens whatever file/project
 * the window booted with. `applyActiveStyle` runs here (between wiring and
 * the initial mount) because the active style must be applied before the
 * first surface mounts.
 */

import { mountNotebook, unmountNotebook, saveNotebook, getCanvasInstance, reloadNotebookShapes } from "./notebook/notebook-bridge.js";
import { applyActiveStyle } from "./style-application.js";
import { mountEmptyState } from "./editor/empty-state.js";

export async function setupModeSwitching(state) {
  // === Mode switching (notebook / PDF / stack / empty) ===
  const appEl = document.getElementById("app");
  const notebookContainer = document.getElementById("notebook-container");
  const pdfContainer = document.getElementById("pdf-container");
  const stackContainer = document.getElementById("stack-container");
  const emptyContainer = document.getElementById("editor-empty-state");
  mountEmptyState(emptyContainer, state);
  const modeCls = ["notebook-mode", "pdf-mode", "stack-mode", "empty-mode"];
  const modeContainers = { "notebook-mode": notebookContainer, "pdf-mode": pdfContainer, "stack-mode": stackContainer, "empty-mode": emptyContainer };

  function activateMode(mode) {
    modeCls.forEach(c => { appEl.classList.remove(c); document.body.classList.remove(c); });
    Object.values(modeContainers).forEach(el => el.classList.add("hidden"));
    if (mode) {
      appEl.classList.add(mode); document.body.classList.add(mode);
      modeContainers[mode]?.classList.remove("hidden");
      state.emit("hide-outline");
    }
  }
  const showEditor = () => activateMode(null);
  const showNotebook = () => activateMode("notebook-mode");
  const showPdf = () => activateMode("pdf-mode");
  const showStack = () => activateMode("stack-mode");
  const showEmpty = () => activateMode("empty-mode");

  // Editor was cleared (last file deleted, desk has nothing to restore,
  // or no files at all) — surface the create-a-file pane instead of
  // silently leaving a stale buffer or jumping to an unrelated file.
  state.on("no-file-state", () => showEmpty());

  state.on("notebook-open", async (fileId) => {
    // Switch to notebook mode *before* the (async) mount so a large
    // notebook shows its own loading overlay instead of leaving the doc
    // editor's "Start writing…" placeholder visible while shapes decode.
    showNotebook();
    await mountNotebook(notebookContainer, fileId, state);
  });
  state.on("notebook-unmount", async () => {
    const result = await unmountNotebook();
    if (result) state.syncFileToExternal(result.fileId, result.content);
    // Notebook→notebook switches re-set currentNotebookFileId right
    // after emitting this event, and the next mount (serialized behind
    // this unmount in the bridge) shows notebook mode — don't yank the
    // freshly opened notebook back to the editor. Every non-notebook
    // open path nulls the id before this handler resumes, so the
    // editor still comes back for docs / stacks / PDFs / deletes.
    if (!state.currentNotebookFileId) showEditor();
  });
  state.on("pdf-open", async (fileId) => {
    const { mountPdf } = await import("./pdf/pdf-bridge.js");
    await mountPdf(pdfContainer, fileId, state);
    showPdf();
  });
  state.on("pdf-toggle-shelf", () => {
    import("./pdf/pdf-bridge.js").then(({ getPdfInstance }) => {
      const v = getPdfInstance();
      if (v) v.toggleShelf();
    });
  });
  state.on("pdf-unmount", async () => {
    const { unmountPdf } = await import("./pdf/pdf-bridge.js");
    await unmountPdf();
    showEditor();
  });
  state.on("stack-open", async (fileId) => {
    const { mountStack } = await import("./stack/stack-bridge.js");
    await mountStack(stackContainer, fileId, state);
    showStack();
  });
  state.on("stack-unmount", async () => {
    const { unmountStack } = await import("./stack/stack-bridge.js");
    const result = await unmountStack();
    if (result) state.syncFileToExternal(result.fileId, result.content);
    showEditor();
  });
  state.on("project-demoted", async (projectId) => {
    const { getStackInstance } = await import("./stack/stack-bridge.js");
    const inst = getStackInstance();
    if (!inst) return;
    const victims = inst._items.filter(i => i.fileType === "project" && i.fileId === projectId);
    for (const v of victims) inst.removeItem(v.id);
  });
  // Notebook minimap — wires itself to AppState.
  import("./notebook/minimap.js").then(m => m.wireMinimap(state));
  state.on("notebook-autosave", async () => {
    const result = await saveNotebook();
    if (result) {
      state.syncFileToExternal(result.fileId, result.content);
      // Nudge sibling windows showing the same notebook to reload it
      // from disk. Id-only: shipping the multi-MB envelope through the
      // broadcast marshalled it on this thread right after every save —
      // the post-save frame stall that ate stroke points.
      state.emit("notebook-cross-window-broadcast", { fileId: result.fileId });
    }
  });
  state.on("notebook-sync-reload", (content) => {
    reloadNotebookShapes(content).catch((e) => console.warn("notebook-sync-reload failed:", e));
  });
  state.on("file-opened", () => { if (!state.currentNotebookFileId && !state.currentPdfFileId && !state.currentStackFileId) showEditor(); });

  // Notebook commands from the command palette
  state.on("notebook-toggle-shelf", () => {
    for (const btn of notebookContainer.querySelectorAll("button")) {
      if (btn.textContent === "‹" || btn.textContent === "›") { btn.click(); break; }
    }
  });
  // Quick-find (Cmd+F) in a notebook context opens the shape shelf and
  // focuses its Search box rather than the doc-only find bar.
  state.on("notebook-open-shelf-search", () => {
    getCanvasInstance()?.openShelfSearch();
  });
  state.on("notebook-toggle-brainstorm", () => {
    const c = getCanvasInstance();
    if (!c) return;
    c.state.brainstormMode = !c.state.brainstormMode;
    if (c.state.brainstormMode) { c.state.tool = "text"; c.state.notify("tool"); }
    c.state.notify("brainstormMode");
  });

  // Seed globalStyleId for existing users who have an activeStyleId but no globalStyleId yet
  if (state.settings.activeStyleId && !state.settings.globalStyleId) {
    state.settings.globalStyleId = state.settings.activeStyleId;
  }

  // Apply active style — runs even when activeStyleId is null so the
  // Default style's post-processing layer (settings.shaderLayer) mounts
  // on startup. The no-style branch of applyActiveStyle is a near-no-op
  // for everything else (just re-asserts standard font/theme/color
  // values that are already in place from earlier init steps).
  applyActiveStyle(state);

  // Load current file content into the newly created editor
  // (init() already opened the last file/project — re-open only if editor wasn't set yet)
  if (state.currentNotebookFileId) {
    showNotebook();
    await mountNotebook(notebookContainer, state.currentNotebookFileId, state);
  } else if (state.currentPdfFileId) {
    const { mountPdf } = await import("./pdf/pdf-bridge.js");
    await mountPdf(pdfContainer, state.currentPdfFileId, state);
    showPdf();
  } else if (state.currentStackFileId) {
    const { mountStack } = await import("./stack/stack-bridge.js");
    await mountStack(stackContainer, state.currentStackFileId, state);
    showStack();
  } else if (state.currentProjectId) {
    await state.openProject(state.currentProjectId);
  } else if (state.currentFileId) {
    await state.openFile(state.currentFileId);
  } else if (state.runtime?.pendingLocalSync) {
    // Local Folder file was the last thing open — re-open it now that the
    // editor exists (init() deferred it because local opens need a live
    // editor and emit surface-mount events).
    const { folderId, relPath, name } = state.runtime.pendingLocalSync;
    state.runtime.pendingLocalSync = null;
    try {
      const m = await import("./sync/local-sync.js");
      await m.openLocalEntry(state, folderId, relPath, name);
    } catch (e) {
      console.warn("restore local-sync file failed:", e);
      showEmpty();
    }
  } else {
    // Nothing to restore — show the "no file selected" pane rather than
    // spawning a throwaway Untitled doc.
    showEmpty();
  }
}
