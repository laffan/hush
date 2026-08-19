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
  } else if (type === "project") {
    await mountProjectContent(contentEl, item, state, liveData);
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
    const { createModeContext } = await import("../state/mode-context.js");
    const mc = createModeContext(state);
    let dirty = false;
    // Stack columns count their own keystrokes for the 30-keystroke
    // version-snapshot cadence — like panes, their edits never reach
    // the main editor's counter.
    let snapKeystrokes = 0;
    const editor = createPaneEditor(wrapper, state, () => { dirty = true; snapKeystrokes++; }, { modeContext: mc.proxy });
    editor.setContent(content);
    // Apply the active style's theme + colour overrides to the column's
    // editor. Unlike floating panes (handled by pane-content), stack
    // columns have no other code path that calls this, so without it a
    // style's fg/bg override never reaches stack doc text.
    editor.reconfigureTheme?.(state.settings);

    // One writer for both the interval and teardown. A column is torn
    // down whenever it leaves the virtualization window (or the whole
    // stack is re-mounted), and teardown that only cleared the timer
    // took the last couple of seconds of typing with it — scroll a
    // just-edited column off-screen and those keystrokes were gone.
    // Everything up to the first `await` runs synchronously, so calling
    // this immediately before `editor.destroy()` still reads a live
    // buffer.
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      const text = editor.getContent();
      if (IS_TAURI) {
        try { await tauriInvoke("save_file", { id: item.fileId, content: text }); }
        catch (e) { console.error("Stack doc save failed:", e); }
        if (snapKeystrokes >= 30) {
          snapKeystrokes = 0;
          try { await tauriInvoke("create_snapshot", { documentId: item.fileId, content: text }); }
          catch (_) {}
        }
      }
      state.syncFileToExternal?.(item.fileId, text);
    };
    const saveInterval = setInterval(flush, 2000);

    liveData.editor = editor;
    liveData.modeContext = mc;
    liveData.container = wrapper;

    if (editor.view) {
      import("../pane/text-drag.js").then(({ attachEditorTextDrag }) => {
        attachEditorTextDrag(editor.view, wrapper);
      });
    }

    // A column editor never re-reads its file on its own — the same gap
    // floating panes have. The text in a column is a separate file that
    // syncs independently of the `.hushstack` envelope, so without this
    // a stack showed the far device's *layout* over this device's stale
    // text. Policy matches the main editor's external apply: an unsaved
    // column is strictly newer than disk and keeps what it has, and the
    // apply clears `dirty` on the same tick so the next save can't write
    // the just-loaded content straight back out. `setContent` is already
    // a minimal common-prefix/suffix diff carrying the programmatic
    // annotations, so the caret maps through instead of jumping.
    liveData.applyExternal = (text) => {
      if (dirty || typeof text !== "string") return;
      if (editor.getContent() === text) return;
      editor.setContent(text);
      dirty = false;
    };
    liveData.cleanup = () => {
      clearInterval(saveInterval);
      void flush();
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
  // The canvas fills this box exactly and the chrome around it (shelf,
  // page rail, scroll wheel) is absolutely positioned against it, so it
  // has nothing to scroll — but `overflow: hidden` doesn't stop a
  // `scrollIntoView` from inside, and once shoved the user can't shove it
  // back. Same guard as the column content box; see `pinUnscrollable`.
  wrapper.addEventListener("scroll", () => {
    if (wrapper.scrollLeft !== 0) wrapper.scrollLeft = 0;
    if (wrapper.scrollTop !== 0) wrapper.scrollTop = 0;
  });
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
    // A stack column lives inside #stack-container, which already
    // shrinks via the pane-dock CSS vars — mirroring the global dock
    // footprints here would double-apply them.
    canvas.state.paneHosted = true;
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
      // Content, not viewport: a column that dropped splits and proof
      // metadata on load would write them out of the file on its first
      // autosave. Mirrors the main canvas and the pane path.
      canvas.loadShapes(snapshot.shapes, snapshot.layers, undefined, {
        splits: snapshot.splits,
        proof: snapshot.proof || null,
      });
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
      // Initial viewport placement, not a user pan — don't drag pinned
      // drag-boxes along with it.
      canvas.state.rebasePinAnchor?.();
    });

    // Autosave on changes
    let dirty = false;
    wrapper.addEventListener("notebook-change", () => { dirty = true; });

    // Same single-writer shape as mountDocContent — teardown flushes.
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      const content = encodeNotebookContent({
        shapes: canvas.getShapes(),
        layers: canvas.state.layers,
        flowEdges: canvas.state.flowchart.serialize(),
        bookmarks: canvas.state.bookmarks,
        camera: canvas.state.camera,
        splits: canvas.state.splits,
        proof: canvas.state.proof ?? undefined,
      });
      if (IS_TAURI) {
        try { await tauriInvoke("save_file", { id: item.fileId, content }); }
        catch (e) { console.error("Stack notebook save failed:", e); }
      }
      state.syncFileToExternal?.(item.fileId, content);
    };
    const saveInterval = setInterval(flush, 2000);

    liveData.canvas = canvas;
    // Register as a Cmd+drag drop target so text can be dragged
    // between stack columns (and from panes/main editor into this notebook)
    const nbCanvas = wrapper.querySelector("canvas");
    let unregDrop = null;
    let unregTxtDrag = null;
    let unregImgDrag = null;
    if (nbCanvas) {
      import("../pane/text-drag.js").then(async ({ registerNotebookDropTarget, attachNotebookTextShapeDrag, attachNotebookImageShapeDrag }) => {
        const { findShapeAtPoint, hitTestLink, openSoleLinkOf } = await import("../notebook/state-helpers.ts");
        unregDrop = registerNotebookDropTarget(nbCanvas, canvas.state);
        unregTxtDrag = attachNotebookTextShapeDrag(nbCanvas, wrapper, canvas.state, {
          findTextShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, canvas.state.fontFamily);
            return hit && hit.type === "text" ? hit : null;
          },
          hitTestLink,
          openSoleLink: openSoleLinkOf,
        }, () => { dirty = true; });
        unregImgDrag = attachNotebookImageShapeDrag(nbCanvas, wrapper, canvas.state, {
          findImageShapeAt: (shapes, pt) => {
            const hit = findShapeAtPoint(pt, shapes, canvas.state.fontFamily);
            return hit && hit.type === "image" ? hit : null;
          },
        }, () => { dirty = true; });
      });
    }
    // Same re-read seam as a doc column, mirroring rather than loading
    // so the column's own undo history survives; the incoming camera is
    // dropped for the same reason the main canvas drops it — a viewport
    // is per-device.
    liveData.applyExternal = (content) => {
      if (dirty || typeof content !== "string") return;
      try {
        const snap = decodeNotebookContent(content);
        if (!snap || typeof canvas.mirrorContent !== "function") return;
        canvas.mirrorContent({
          shapes: snap.shapes,
          layers: snap.layers,
          flowEdges: snap.flowEdges,
          bookmarks: Array.isArray(snap.bookmarks) ? snap.bookmarks : undefined,
        });
        dirty = false;
      } catch (e) { console.warn("stack notebook column reload failed:", e); }
    };
    liveData.cleanup = () => {
      clearInterval(saveInterval);
      void flush();
      if (unregDrop) unregDrop();
      if (unregTxtDrag) unregTxtDrag();
      if (unregImgDrag) unregImgDrag();
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

    const viewer = createPdfViewer(wrapper, { mode: "pane", zoteroAttKey, fileId: item.fileId });

    let bytes;
    if (IS_TAURI) {
      try { bytes = await tauriInvoke("load_pdf", { fileId: item.fileId }); }
      catch (e) { console.error("Failed to load PDF for stack:", e); }
    }

    if (bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await viewer.loadPdf(data);
    }

    try {
      const { getPdfMeta } = await import("../sync/pdf-sync.js");
      const meta = getPdfMeta(item.fileId);
      if (meta && viewer.setToolbarInfo) {
        viewer.setToolbarInfo(meta.title, meta.firstAuthor);
      }
    } catch {}

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

// --- Project mounting (joined doc buffer, same as state-project.js) ---

async function mountProjectContent(contentEl, item, state, liveData) {
  const { findNode, collectDocumentIds } = await import("../state/tree-helpers.js");
  const { SEPARATOR, createProjectViewField, createSeparatorFilter } = await import("../editor/plugins/project-view.js");

  const node = findNode(state.fileTree, item.fileId);
  if (!node || node.type !== "project") {
    contentEl.innerHTML = `<div class="stack-placeholder">Project not found</div>`;
    liveData.cleanup = () => {};
    liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
    return;
  }

  const docIds = collectDocumentIds(node.children || []);
  let joined = "";
  if (IS_TAURI && docIds.length) {
    const parts = [];
    for (const fid of docIds) {
      try {
        const file = await tauriInvoke("load_file", { id: fid });
        parts.push(file.content || "");
      } catch (e) {
        console.error("Failed to load project doc for stack:", e);
        parts.push("");
      }
    }
    joined = parts.join(SEPARATOR);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "stack-doc-wrapper";
  contentEl.appendChild(wrapper);

  try {
    const { createPaneEditor } = await import("../pane/pane-editor.js");
    const { createModeContext } = await import("../state/mode-context.js");
    const projectState = Object.create(state);
    projectState.currentProjectId = item.fileId;
    const mc = createModeContext(projectState);
    let dirty = false;
    const editor = createPaneEditor(wrapper, projectState, () => { dirty = true; }, {
      modeContext: mc.proxy,
      extraExtensions: [
        createProjectViewField(mc.proxy),
        createSeparatorFilter(mc.proxy),
      ],
    });
    editor.setContent(joined);
    // Match the active style's theme + colour overrides (see mountDocContent).
    editor.reconfigureTheme?.(projectState.settings);

    // Same single-writer shape as mountDocContent — teardown flushes.
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      const text = editor.getContent();
      const { SEPARATOR: SEP } = await import("../editor/plugins/project-view.js");
      const parts = [];
      let pos = 0;
      for (let i = 0; i < docIds.length - 1; i++) {
        const idx = text.indexOf(SEP, pos);
        if (idx === -1) break;
        parts.push(text.slice(pos, idx));
        pos = idx + SEP.length;
      }
      parts.push(text.slice(pos));
      if (IS_TAURI) {
        for (let i = 0; i < docIds.length && i < parts.length; i++) {
          try { await tauriInvoke("save_file", { id: docIds[i], content: parts[i] || "" }); }
          catch (e) { console.error("Stack project save failed:", e); }
        }
      }
    };
    const saveInterval = setInterval(flush, 2000);

    liveData.editor = editor;
    liveData.modeContext = mc;
    liveData.container = wrapper;
    liveData.cleanup = () => {
      clearInterval(saveInterval);
      void flush();
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
    console.error("Failed to create stack project editor:", e);
    wrapper.textContent = joined.slice(0, 500) + "...";
    liveData.cleanup = () => {};
    liveData.getScrollState = () => ({ scrollY: 0, cameraState: null });
  }
}
