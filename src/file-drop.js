/**
 * File drag-and-drop — handles .md and .txt files dragged into the app.
 * - Dropping on the sidebar imports the file as a new document.
 * - Dropping on the editor appends the text to the current document.
 * Drop zone overlays appear when a valid file is being dragged over the app.
 */

const VALID_EXTENSIONS = [".md", ".txt"];

function hasValidFiles(dt) {
  if (!dt || !dt.items) return false;
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    if (item.kind === "file") {
      // On drag events, type may be empty; check on drop
      const type = item.type;
      if (
        type === "text/plain" ||
        type === "text/markdown" ||
        type === "" // type is often empty during dragover
      ) {
        return true;
      }
    }
  }
  return false;
}

function fileHasValidExtension(file) {
  const name = file.name.toLowerCase();
  return VALID_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function setupFileDrop(state) {
  // Create drop zone overlays
  const importZone = document.createElement("div");
  importZone.className = "drop-zone drop-zone-import";
  importZone.innerHTML = `<span class="drop-zone-label">Import File</span>`;

  const appendZone = document.createElement("div");
  appendZone.className = "drop-zone drop-zone-append";
  appendZone.innerHTML = `<span class="drop-zone-label">Append Text</span>`;

  const overlay = document.createElement("div");
  overlay.className = "drop-overlay hidden";
  overlay.appendChild(importZone);
  overlay.appendChild(appendZone);
  document.getElementById("app").appendChild(overlay);

  let dragCounter = 0;

  // Show overlay on drag enter
  document.addEventListener("dragenter", (e) => {
    if (!hasValidFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      overlay.classList.remove("hidden");
    }
  });

  document.addEventListener("dragover", (e) => {
    if (!overlay.classList.contains("hidden")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });

  document.addEventListener("dragleave", (e) => {
    if (overlay.classList.contains("hidden")) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.add("hidden");
      importZone.classList.remove("drop-zone-active");
      appendZone.classList.remove("drop-zone-active");
    }
  });

  // Highlight individual zones on hover
  importZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    importZone.classList.add("drop-zone-active");
  });
  importZone.addEventListener("dragleave", () => {
    importZone.classList.remove("drop-zone-active");
  });
  appendZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    appendZone.classList.add("drop-zone-active");
  });
  appendZone.addEventListener("dragleave", () => {
    appendZone.classList.remove("drop-zone-active");
  });

  // Handle drop on import zone (sidebar) — create new document
  importZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideOverlay();
    const text = await readDroppedFile(e);
    if (text === null) return;
    await importAsNewDocument(state, text);
  });

  // Handle drop on append zone (editor) — append to current document
  appendZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideOverlay();
    const text = await readDroppedFile(e);
    if (text === null) return;
    appendToEditor(state, text);
  });

  // Fallback: drop anywhere on overlay defaults to append
  overlay.addEventListener("drop", async (e) => {
    e.preventDefault();
    hideOverlay();
    const text = await readDroppedFile(e);
    if (text === null) return;
    appendToEditor(state, text);
  });

  function hideOverlay() {
    dragCounter = 0;
    overlay.classList.add("hidden");
    importZone.classList.remove("drop-zone-active");
    appendZone.classList.remove("drop-zone-active");
  }
}

async function readDroppedFile(e) {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return null;

  for (let i = 0; i < files.length; i++) {
    if (fileHasValidExtension(files[i])) {
      return await files[i].text();
    }
  }
  return null;
}

async function importAsNewDocument(state, text) {
  // Create a new file with the dropped content
  await state.newFile();
  if (state.editor) {
    state.editor.setContent(text);
    state.markDirty();
    // Let the name auto-derive from content
    await state.saveCurrentFile();
  }
}

function appendToEditor(state, text) {
  if (!state.editor) return;
  const view = state.editor.view;
  const end = view.state.doc.length;
  // Add a newline separator if the document isn't empty
  const prefix = end > 0 ? "\n\n" : "";
  view.dispatch({
    changes: { from: end, insert: prefix + text },
  });
  state.markDirty();
}
