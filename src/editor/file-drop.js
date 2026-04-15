/**
 * File drag-and-drop — handles files dragged into the app.
 *
 * Behaviour depends on context:
 *   - If the files sidebar panel is open → show "Import file" overlay
 *     over the panel.  Dropping creates a new document from the file.
 *   - If a Doc is active → insert text content at the end of the editor.
 *   - If a Notebook is active → the notebook's own input-handler handles
 *     images and text drops on the canvas (this module does not interfere).
 *
 * IMPORTANT: We prevent the default browser drop behavior globally so that
 * a missed drop never causes the webview to navigate away.
 */

import { getCanvasInstance } from "../notebook/notebook-bridge.js";

const TEXT_EXTENSIONS = [".md", ".txt", ".text", ".markdown"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function getExtension(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.includes(getExtension(file.name)) || file.type.startsWith("text/");
}

function isImageFile(file) {
  return IMAGE_EXTENSIONS.includes(getExtension(file.name)) || file.type.startsWith("image/");
}

export function setupFileDrop(state) {
  // ── Global safety net ────────────────────────────────────────────
  // Prevent the browser from ever navigating to a dropped file.
  // Use a named handler so we can check if the notebook already handled it.
  document.addEventListener("dragover", (e) => e.preventDefault(), true);
  document.addEventListener("drop", (e) => {
    // Only prevent default if nothing else already handled it
    if (!e.defaultPrevented) e.preventDefault();
  }, true);

  // ── Build import overlay (shown over sidebar panel) ─────────────
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay hidden";

  const importZone = document.createElement("div");
  importZone.className = "drop-zone drop-zone-import";
  importZone.innerHTML = `<span class="drop-zone-label">Import file</span>`;
  overlay.appendChild(importZone);

  document.body.appendChild(overlay);

  // ── Drag enter / leave tracking ──────────────────────────────────
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragCounter++;
    if (dragCounter === 1) {
      // In notebook mode, only show overlay if sidebar panel is open
      if (state.currentNotebookFileId) {
        const panel = document.getElementById("panel-overlay");
        if (panel && !panel.classList.contains("hidden")) {
          overlay.classList.remove("hidden");
        }
        // Otherwise let the notebook canvas handle the drop natively
        return;
      }
      overlay.classList.remove("hidden");
    }
  });

  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; hideOverlay(); }
  });

  // ── Zone hover highlights ────────────────────────────────────────
  importZone.addEventListener("dragenter", () => importZone.classList.add("drop-zone-active"));
  importZone.addEventListener("dragleave", () => importZone.classList.remove("drop-zone-active"));

  // ── Import zone drop handler ─────────────────────────────────────
  importZone.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const file = findDroppedFile(e, [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS]);
    if (!file) return;
    if (isTextFile(file)) {
      const content = await file.text();
      await importAsNewDocument(state, content);
    }
    // Image import as new document isn't supported yet — just ignore
  });

  // ── Overlay background drop (fallback) ───────────────────────────
  overlay.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();

    if (state.currentNotebookFileId) {
      // In notebook mode, forward file drops to the canvas
      await handleNotebookDrop(e);
      return;
    }

    // In doc mode, insert text into editor
    const file = findDroppedFile(e, TEXT_EXTENSIONS);
    if (!file) return;
    const content = await file.text();
    appendToEditor(state, content);
  });

  function hideOverlay() {
    dragCounter = 0;
    overlay.classList.add("hidden");
    importZone.classList.remove("drop-zone-active");
  }
}

function findDroppedFile(e, validExts) {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return null;
  for (let i = 0; i < files.length; i++) {
    const ext = getExtension(files[i].name);
    if (validExts.includes(ext) || files[i].type.startsWith("text/") || files[i].type.startsWith("image/")) {
      return files[i];
    }
  }
  return null;
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

async function handleNotebookDrop(e) {
  const canvas = getCanvasInstance();
  if (!canvas) return;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (isImageFile(file)) {
      const dataUrl = await fileToDataUrl(file);
      const dims = await getImageDimensions(dataUrl);
      canvas.state.addImageShape(dataUrl, file.name, dims.width, dims.height);
    } else if (isTextFile(file)) {
      const text = await file.text();
      if (text.trim()) canvas.state.addTextShapeAtCenter(text);
    }
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 200, height: 200 });
    img.src = dataUrl;
  });
}
