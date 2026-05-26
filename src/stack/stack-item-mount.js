/**
 * Stack item mount/unmount — handles live-mounting docs, notebooks,
 * PDFs, and nested stacks into stack column content areas.
 *
 * Memory strategy:
 * - Docs: live CodeMirror editor when visible, unmounted when off-screen
 * - Notebooks: live canvas when visible, unmounted when off-screen
 * - PDFs: always snapshot-based; click to activate into a live viewer
 * - Stacks: nested StackComponent (recursive)
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function mountItemContent(contentEl, item, state, liveColumns) {
  if (liveColumns.has(item.id)) return;
  contentEl.innerHTML = "";

  const type = item.fileType;
  const liveData = { type, getScrollState: null };

  if (type === "document") {
    await mountDocContent(contentEl, item, state, liveData);
  } else if (type === "notebook") {
    await mountNotebookContent(contentEl, item, state, liveData);
  } else if (type === "pdf") {
    await mountPdfContent(contentEl, item, state, liveData);
  } else if (type === "stack") {
    await mountNestedStack(contentEl, item, state, liveData);
  } else {
    contentEl.innerHTML = `<div class="stack-placeholder">Unknown type: ${type}</div>`;
  }

  liveColumns.set(item.id, liveData);
}

export function unmountItemContent(contentEl, item, liveColumns) {
  const liveData = liveColumns.get(item.id);
  if (!liveData) return;

  if (liveData.cleanup) liveData.cleanup();
  liveColumns.delete(item.id);
  contentEl.innerHTML = "";
}

/** Capture all view state from a live column back onto the item. */
export function snapshotItemContent(contentEl, item, liveColumns) {
  const liveData = liveColumns?.get(item.id);
  if (!liveData?.getScrollState) return;
  const s = liveData.getScrollState();
  if (s.scrollY != null) item.scrollY = s.scrollY;
  if (s.cameraState != null) item.cameraState = s.cameraState;
  if (s.pdfZoom != null) item.pdfZoom = s.pdfZoom;
}

// --- Document mounting (full pane editor, same as pane-content.js) ---

async function mountDocContent(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-doc-wrapper";
  contentEl.appendChild(wrapper);

  let content = "";
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: item.fileId });
      content = file.content || "";
    } catch (e) { console.error("Failed to load doc for stack:", e); }
  }

  try {
    const { createPaneEditor } = await import("../pane/pane-editor.js");
    let dirty = false;
    const editor = createPaneEditor(wrapper, state, () => { dirty = true; });
    editor.setContent(content);

    const saveInterval = setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      const text = editor.getContent();
      if (IS_TAURI) {
        try { await tauriInvoke("save_file", { id: item.fileId, content: text }); }
        catch (e) { console.error("Stack doc save failed:", e); }
      }
      state.syncFileToExternal?.(item.fileId, text);
    }, 2000);

    liveData.editor = editor;
    liveData.cleanup = () => {
      clearInterval(saveInterval);
      editor.destroy();
    };
    liveData.getScrollState = () => ({
      scrollY: editor.view?.scrollDOM?.scrollTop ?? 0,
      cameraState: null,
    });

    if (item.scrollY) {
      requestAnimationFrame(() => {
        try { editor.view?.scrollDOM?.scrollTo(0, item.scrollY); } catch (_) {}
      });
    }
  } catch (e) {
    console.error("Failed to create stack editor:", e);
    wrapper.textContent = content.slice(0, 500) + "...";
  }
}

// --- Notebook mounting (live canvas, same as pane-content.js) ---

async function mountNotebookContent(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-notebook-wrapper";
  contentEl.appendChild(wrapper);

  try {
    const { NotesCanvas } = await import("../notebook/notes-canvas.ts");
    const { computeNotebookSettings } = await import("../notebook/notebook-bridge.js");
    const { decodeNotebookContent } = await import("../notebook/notebook-content.ts");
    const { encodeNotebookContent } = await import("../notebook/notebook-content.ts");

    const s = state.settings;
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

    const canvas = new NotesCanvas(wrapper, shortcuts);
    canvas.applySettings(computeNotebookSettings(state, null));

    let fileContent = null;
    if (IS_TAURI) {
      try {
        const file = await tauriInvoke("load_file", { id: item.fileId });
        fileContent = file.content;
      } catch (e) { console.error("Failed to load notebook for stack:", e); }
    }

    const snapshot = fileContent ? decodeNotebookContent(fileContent) : null;
    if (snapshot) {
      canvas.loadShapes(snapshot.shapes, snapshot.layers);
      canvas.state.flowchart.deserialize(snapshot.flowEdges);
      if (Array.isArray(snapshot.bookmarks)) {
        canvas.state.bookmarks = snapshot.bookmarks;
        canvas.state.notify("bookmarks");
      }
    }

    // Restore camera or center on content
    requestAnimationFrame(() => {
      if (!canvas.state) return;
      if (item.cameraState) {
        canvas.state.camera = { ...item.cameraState };
      } else {
        const w = wrapper.clientWidth || 500;
        const h = wrapper.clientHeight || 400;
        canvas.state.camera = { x: -w / 4, y: -h / 4, zoom: 0.75 };
      }
      canvas.state.notify("camera");
    });

    // Autosave on changes
    let dirty = false;
    wrapper.addEventListener("notebook-change", () => { dirty = true; });

    const saveInterval = setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      const content = encodeNotebookContent({
        shapes: canvas.getShapes(),
        layers: canvas.state.layers,
        flowEdges: canvas.state.flowchart.serialize(),
        bookmarks: canvas.state.bookmarks,
        camera: canvas.state.camera,
      });
      if (IS_TAURI) {
        try { await tauriInvoke("save_file", { id: item.fileId, content }); }
        catch (e) { console.error("Stack notebook save failed:", e); }
      }
      state.syncFileToExternal?.(item.fileId, content);
    }, 2000);

    liveData.canvas = canvas;
    liveData.cleanup = () => {
      clearInterval(saveInterval);
      canvas.destroy();
    };
    liveData.getScrollState = () => ({
      scrollY: 0,
      cameraState: canvas.state?.camera ? { ...canvas.state.camera } : null,
    });
  } catch (e) {
    console.error("Failed to mount notebook in stack:", e);
    wrapper.innerHTML = `<div class="stack-placeholder">Notebook</div>`;
    liveData.cleanup = () => {};
    liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
  }
}

// --- PDF mounting (immediate, same as pane-content.js) ---

async function mountPdfContent(contentEl, item, state, liveData) {
  const wrapper = document.createElement("div");
  wrapper.className = "stack-pdf-wrapper";
  contentEl.appendChild(wrapper);

  try {
    const { createPdfViewer } = await import("../pdf/pdf-viewer.js");
    const { findNodeByFileId } = await import("../state/tree-helpers.js");
    const node = findNodeByFileId(state.fileTree, item.fileId);
    const zoteroAttKey = node?.zoteroAttKey || null;

    const viewer = createPdfViewer(wrapper, { mode: "pane", zoteroAttKey });

    let bytes;
    if (IS_TAURI) {
      try { bytes = await tauriInvoke("load_pdf", { fileId: item.fileId }); }
      catch (e) { console.error("Failed to load PDF for stack:", e); }
    }

    if (bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await viewer.loadPdf(data);
    }

    // Restore zoom and scroll position
    requestAnimationFrame(() => {
      try {
        if (item.pdfZoom != null && viewer.setZoom) viewer.setZoom(item.pdfZoom);
        if (typeof item.scrollY === "number" && item.scrollY > 0) viewer.setScrollTop(item.scrollY);
      } catch (_) {}
    });

    if (zoteroAttKey) {
      const userId = state.settings?.zoteroUserId;
      const apiKey = state.settings?.zoteroApiKey;
      if (userId && apiKey) {
        try {
          const { getAnnotations } = await import("../zotero-annotations.js");
          const { annotations } = await getAnnotations(zoteroAttKey, userId, apiKey);
          viewer.setAnnotations(annotations);
        } catch (_) {}
      }
    }

    liveData.pdfViewer = viewer;
    liveData.cleanup = () => { if (viewer.destroy) viewer.destroy(); };
    liveData.getScrollState = () => ({
      scrollY: viewer.getScrollTop?.() ?? 0,
      cameraState: null,
      pdfZoom: viewer.getZoom?.() ?? null,
    });
  } catch (e) {
    console.error("Failed to mount PDF in stack:", e);
    wrapper.innerHTML = `<div class="stack-placeholder">Failed to load PDF</div>`;
    liveData.cleanup = () => {};
    liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
  }
}

// --- Nested stack ---

async function mountNestedStack(contentEl, item, state, liveData) {
  const { StackComponent } = await import("./stack-component.js");
  const { decodeStackContent } = await import("./stack-content.js");

  let content = null;
  if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: item.fileId });
      content = file.content;
    } catch (e) {
      console.error("Failed to load nested stack:", e);
    }
  }

  const data = decodeStackContent(content);
  const nested = new StackComponent(contentEl, data, state);

  liveData.nestedStack = nested;
  liveData.cleanup = () => nested.destroy();
  liveData.getScrollState = () => ({
    scrollY: 0,
    cameraState: null,
  });
}
