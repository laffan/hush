/**
 * File drag-and-drop — handles files dragged into the app.
 *
 * Three drop targets:
 *   1. Sidebar panel (when open) → "Import file" overlay appears over
 *      the panel only.  Dropping creates a new document.
 *   2. Editor area (doc mode) → images and plain-text payloads land at
 *      the drop point; whole text-file drops append at the end.
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

export function hasAcceptableDragPayload(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // dataTransfer.types is DOMStringList in Safari; check via includes/contains.
  const has = (t) => (typeof types.includes === "function" ? types.includes(t) : Array.from(types).includes(t));
  return has("Files") || has("text/plain") || has("text/uri-list") || has("Text");
}

export function readDragText(e) {
  const dt = e.dataTransfer;
  if (!dt) return "";
  return dt.getData("text/plain") || dt.getData("text/uri-list") || dt.getData("Text") || "";
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
  // Accepts file drops (images, text files) and plain-text payloads dragged
  // in from another app. iPad WebView doesn't deliver text drops to
  // CodeMirror's internal drop handler, so we always insert the payload
  // ourselves. We attach in the capture phase so we preempt CM — otherwise
  // a text drop would double-insert on desktop while still failing on iPad.
  const editorContainer = document.getElementById("editor-container");
  editorContainer.addEventListener("dragover", (e) => {
    if (state.currentNotebookFileId) return;
    if (!hasAcceptableDragPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, true);
  editorContainer.addEventListener("drop", async (e) => {
    if (state.currentNotebookFileId) return;
    if (!hasAcceptableDragPayload(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // Image drops take priority — insert image references at the drop point.
    const images = findImageFiles(e);
    if (images.length > 0) {
      await insertImagesAtDrop(state, images, e.clientX, e.clientY);
      return;
    }
    const file = findTextFile(e);
    if (file) {
      const content = await file.text();
      appendToEditor(state, content);
      return;
    }
    const text = readDragText(e);
    if (text) insertTextAtDrop(state, text, e.clientX, e.clientY);
  }, true);

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

function insertTextAtDrop(state, text, clientX, clientY) {
  if (!state.editor) return;
  const view = state.editor.view;
  let pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos == null) pos = view.posAtCoords({ x: clientX, y: clientY }, false);
  if (pos == null) pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  view.focus();
  state.markDirty();
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
  // Local Sync docs: write each image as a sibling file inside the
  // mounted folder so refs stay relative and the file remains portable
  // (the same `.md` opened in another editor still resolves images).
  const ls = state.currentLocalSync;
  if (ls?.folderId && ls?.relPath) {
    const slash = ls.relPath.lastIndexOf("/");
    const baseDir = slash >= 0 ? ls.relPath.slice(0, slash) : "";
    const { writeFileBytes } = await import("../sync/local-sync.js");
    const { isImageFile } = await import("../state/state-images.js");
    for (const file of files) {
      if (!isImageFile(file)) continue;
      try {
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const target = baseDir ? `${baseDir}/${file.name}` : file.name;
        const finalRel = await writeFileBytes(ls.folderId, target, bytes);
        const finalName = (finalRel || target).split("/").pop();
        const altSrc = finalName.replace(/\.[^.]+$/, "") || "image";
        chunks.push(buildImageMarkdown(altSrc, finalName));
      } catch (e) {
        console.error("Local Sync image drop failed:", e);
      }
    }
  } else {
    for (const file of files) {
      const res = await state.createImageFromFile(file);
      if (res) chunks.push(buildImageMarkdown(res.alt, res.filename));
    }
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
