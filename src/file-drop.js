/**
 * File drag-and-drop — handles .md and .txt files dragged into the app.
 * Shows a full-screen overlay with two drop zones:
 *   Left  → "Import file" (creates a new document)
 *   Right → "Copy file into current" (inserts text into active doc)
 *
 * IMPORTANT: We prevent the default browser drop behavior globally so that
 * a missed or mishandled drop never causes the webview to navigate away
 * (which looks like a crash — the window content is replaced by the file).
 */

const VALID_EXTENSIONS = [".md", ".txt"];

function fileHasValidExtension(file) {
  const name = file.name.toLowerCase();
  return VALID_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function setupFileDrop(state) {
  // ── Global safety net ────────────────────────────────────────────
  // Prevent the browser from ever navigating to a dropped file.
  document.addEventListener("dragover", (e) => e.preventDefault(), true);
  document.addEventListener("drop", (e) => e.preventDefault(), true);

  // ── Build overlay DOM ────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay hidden";

  const importZone = document.createElement("div");
  importZone.className = "drop-zone drop-zone-import";
  importZone.innerHTML = `<span class="drop-zone-label">Import file</span>`;

  const copyZone = document.createElement("div");
  copyZone.className = "drop-zone drop-zone-copy";
  copyZone.innerHTML = `<span class="drop-zone-label">Copy file into current</span>`;

  overlay.appendChild(importZone);
  overlay.appendChild(copyZone);

  // Append to body so we sit above everything (sidebar, panel-overlay, etc.)
  document.body.appendChild(overlay);

  // ── Drag enter / leave tracking ──────────────────────────────────
  let dragCounter = 0;

  document.addEventListener("dragenter", (e) => {
    // Only react to external files (not internal sortable drags)
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragCounter++;
    if (dragCounter === 1) {
      overlay.classList.remove("hidden");
    }
  });

  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      hideOverlay();
    }
  });

  // ── Zone hover highlights ────────────────────────────────────────
  importZone.addEventListener("dragenter", () => importZone.classList.add("drop-zone-active"));
  importZone.addEventListener("dragleave", () => importZone.classList.remove("drop-zone-active"));
  copyZone.addEventListener("dragenter", () => copyZone.classList.add("drop-zone-active"));
  copyZone.addEventListener("dragleave", () => copyZone.classList.remove("drop-zone-active"));

  // ── Drop handlers ────────────────────────────────────────────────
  importZone.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const text = readDroppedFile(e);
    if (text === null) return;
    const content = await text;
    if (content === null) return;
    await importAsNewDocument(state, content);
  });

  copyZone.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const text = readDroppedFile(e);
    if (text === null) return;
    const content = await text;
    if (content === null) return;
    appendToEditor(state, content);
  });

  // Fallback: drop on overlay background → copy into current
  overlay.addEventListener("drop", async (e) => {
    e.stopPropagation();
    hideOverlay();
    const text = readDroppedFile(e);
    if (text === null) return;
    const content = await text;
    if (content === null) return;
    appendToEditor(state, content);
  });

  function hideOverlay() {
    dragCounter = 0;
    overlay.classList.add("hidden");
    importZone.classList.remove("drop-zone-active");
    copyZone.classList.remove("drop-zone-active");
  }
}

function readDroppedFile(e) {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return null;

  for (let i = 0; i < files.length; i++) {
    if (fileHasValidExtension(files[i])) {
      return files[i].text();
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
  view.dispatch({
    changes: { from: end, insert: prefix + text },
  });
  state.markDirty();
}
