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

  // ── Build drop overlay ────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay hidden";

  const importZone = document.createElement("div");
  importZone.className = "drop-zone drop-zone-import";
  const importLabel = document.createElement("span");
  importLabel.className = "drop-zone-label";
  importZone.appendChild(importLabel);

  const insertZone = document.createElement("div");
  insertZone.className = "drop-zone drop-zone-copy";
  insertZone.innerHTML = `<span class="drop-zone-label">Insert into current document</span>`;

  overlay.appendChild(importZone);
  overlay.appendChild(insertZone);
  document.body.appendChild(overlay);

  // ── Drag enter / leave tracking ──────────────────────────────────
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragCounter++;
    if (dragCounter === 1) {
      // In notebook mode, only show overlay if sidebar panel is open —
      // otherwise let the canvas handle the drop natively.
      if (state.currentNotebookFileId) {
        const panel = document.getElementById("panel-overlay");
        if (panel && !panel.classList.contains("hidden")) {
          importLabel.textContent = "Import file";
          importZone.style.display = "";
          insertZone.style.display = "none";
          overlay.classList.remove("hidden");
        }
        return;
      }
      // In doc mode, always show the overlay so we can capture the drop.
      // Show both zones: "Import file" + "Insert into current document".
      importLabel.textContent = "Import file";
      importZone.style.display = "";
      insertZone.style.display = "";
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
  insertZone.addEventListener("dragenter", () => insertZone.classList.add("drop-zone-active"));
  insertZone.addEventListener("dragleave", () => insertZone.classList.remove("drop-zone-active"));

  // ── Import zone: create a new document ───────────────────────────
  importZone.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const file = findDroppedFile(e, TEXT_EXTENSIONS);
    if (!file) return;
    const content = await file.text();
    await importAsNewDocument(state, content);
  });

  // ── Insert zone: append to current document ──────────────────────
  insertZone.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const file = findDroppedFile(e, TEXT_EXTENSIONS);
    if (!file) return;
    const content = await file.text();
    appendToEditor(state, content);
  });

  // ── Overlay background drop (fallback) ───────────────────────────
  overlay.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
  });

  function hideOverlay() {
    dragCounter = 0;
    overlay.classList.add("hidden");
    importZone.classList.remove("drop-zone-active");
    insertZone.classList.remove("drop-zone-active");
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
