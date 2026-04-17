/**
 * File drag-and-drop — handles files dragged into the app.
 *
 * Three drop targets:
 *   1. Sidebar panel (when open) → "Import file" overlay appears over
 *      the panel only.  Dropping creates a new document.
 *   2. Editor area (doc mode) → text is inserted at the end of the doc.
 *   3. Notebook canvas → handled natively by notebook input-handler
 *      (images become shapes, text becomes text shapes).
 *
 * The global safety net prevents the browser from navigating to a
 * dropped file, but does NOT block the editor/notebook from receiving
 * the drop event.
 */

const TEXT_EXTENSIONS = [".md", ".txt", ".text", ".markdown"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".heif", ".avif", ".tif", ".tiff"];

function getExtension(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.includes(getExtension(file.name)) || file.type.startsWith("text/");
}

function isImageFile(file) {
  return IMAGE_EXTENSIONS.includes(getExtension(file.name)) || (file.type || "").startsWith("image/");
}

function findTextFile(e) {
  const files = e.dataTransfer?.files;
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    if (isTextFile(files[i])) return files[i];
  }
  return null;
}

function findImageFiles(e) {
  const files = e.dataTransfer?.files;
  if (!files) return [];
  const out = [];
  for (let i = 0; i < files.length; i++) {
    if (isImageFile(files[i])) out.push(files[i]);
  }
  return out;
}

export function setupFileDrop(state) {
  // ── Global safety net ────────────────────────────────────────────
  // Prevent the browser from navigating to a dropped file.
  document.addEventListener("dragover", (e) => e.preventDefault(), true);
  document.addEventListener("drop", (e) => {
    if (!e.defaultPrevented) e.preventDefault();
  }, true);

  // ── Sidebar import overlay (lives inside #panel-overlay) ─────────
  const panelOverlay = document.getElementById("panel-overlay");
  const importOverlay = document.createElement("div");
  importOverlay.className = "drop-import-overlay hidden";
  importOverlay.innerHTML = `<span class="drop-zone-label">Import file</span>`;
  panelOverlay.appendChild(importOverlay);

  importOverlay.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    importOverlay.classList.add("drop-zone-active");
  });
  importOverlay.addEventListener("dragleave", () => {
    importOverlay.classList.remove("drop-zone-active");
  });
  importOverlay.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideImport();
    const file = findTextFile(e);
    if (!file) return;
    const content = await file.text();
    await importAsNewDocument(state, content);
  });

  // ── Editor drop handler (doc mode) ───────────────────────────────
  const editorContainer = document.getElementById("editor-container");
  editorContainer.addEventListener("dragover", (e) => {
    if (state.currentNotebookFileId) return;
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  editorContainer.addEventListener("drop", async (e) => {
    if (state.currentNotebookFileId) return;
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    // Image drops take priority — insert image references at the drop point.
    const images = findImageFiles(e);
    if (images.length > 0) {
      await insertImagesAtDrop(state, images, e.clientX, e.clientY);
      return;
    }
    const file = findTextFile(e);
    if (!file) return;
    const content = await file.text();
    appendToEditor(state, content);
  });

  // ── Show / hide sidebar import overlay on drag ───────────────────
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragCounter++;
    if (dragCounter === 1 && !panelOverlay.classList.contains("hidden")) {
      importOverlay.classList.remove("hidden");
    }
  });
  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; hideImport(); }
  });
  document.addEventListener("drop", () => {
    dragCounter = 0;
    hideImport();
  });

  function hideImport() {
    importOverlay.classList.add("hidden");
    importOverlay.classList.remove("drop-zone-active");
  }
}

async function importAsNewDocument(state, text) {
  await state.newFile();
  if (state.editor) {
    state.editor.setContent(text);
    state.markDirty();
    await state.saveCurrentFile();
  }
}

function appendToEditor(state, text) {
  if (!state.editor) return;
  const view = state.editor.view;
  const end = view.state.doc.length;
  const prefix = end > 0 ? "\n\n" : "";
  view.dispatch({ changes: { from: end, insert: prefix + text } });
  state.markDirty();
}

async function insertImagesAtDrop(state, files, clientX, clientY) {
  if (!state.editor) return;
  const view = state.editor.view;
  const { buildImageMarkdown } = await import("../state/state-images.js");
  // Pick the insertion point — the coordinate under the cursor, or the
  // selection head if the coord lies between lines.
  let pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos == null) pos = view.posAtCoords({ x: clientX, y: clientY }, false);
  if (pos == null) pos = view.state.selection.main.head;

  const chunks = [];
  for (const file of files) {
    const res = await state.createImageFromFile(file);
    if (res) chunks.push(buildImageMarkdown(res.alt, res.filename));
  }
  if (!chunks.length) return;
  const line = view.state.doc.lineAt(pos);
  // Insert on its own line — add newlines if needed so markdown parses correctly.
  const atLineStart = pos === line.from;
  const atLineEnd = pos === line.to;
  const prefix = atLineStart ? "" : (atLineEnd ? "\n" : "\n");
  const suffix = atLineEnd && line.to !== view.state.doc.length ? "\n" : (atLineEnd ? "\n" : "\n");
  const insert = prefix + chunks.join("\n\n") + suffix;
  view.dispatch({
    changes: { from: pos, to: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
  state.markDirty();
}
