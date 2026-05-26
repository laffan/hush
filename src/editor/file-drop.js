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
const NOTEBOOK_EXTENSIONS = [".hushnote"];
const PDF_EXTENSIONS = [".pdf"];

function getExtension(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.includes(getExtension(file.name)) || file.type.startsWith("text/");
}

function isNotebookFile(file) {
  return NOTEBOOK_EXTENSIONS.includes(getExtension(file.name));
}

function isPdfFile(file) {
  return PDF_EXTENSIONS.includes(getExtension(file.name)) || file.type === "application/pdf";
}

function isImportableFile(file) {
  return isTextFile(file) || isNotebookFile(file) || isPdfFile(file);
}

function isImageFile(file) {
  return IMAGE_EXTENSIONS.includes(getExtension(file.name)) || (file.type || "").startsWith("image/");
}

function findTextFile(e) {
  const files = e.dataTransfer?.types;
  if (!files) return null;
  const list = e.dataTransfer?.files;
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    if (isTextFile(list[i])) return list[i];
  }
  return null;
}

function findImportableFiles(e) {
  const list = e.dataTransfer?.files;
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (isImportableFile(list[i])) out.push(list[i]);
  }
  return out;
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
  // The overlay is a non-blocking visual hint — the actual drop is handled
  // at the panel level so the row under the cursor can route the file
  // into the right folder/project/desk. Pointer events fall through to
  // the rows so they can highlight individually as the cursor moves.
  const panelOverlay = document.getElementById("panel-overlay");
  const importOverlay = document.createElement("div");
  importOverlay.className = "drop-import-overlay hidden";
  importOverlay.innerHTML = `<span class="drop-zone-label">Import file</span>`;
  panelOverlay.appendChild(importOverlay);

  let lastDropTargetRow = null;
  function clearRowHighlight() {
    if (lastDropTargetRow) {
      lastDropTargetRow.classList.remove("drop-target");
      lastDropTargetRow = null;
    }
  }
  function filesPanelMounted() {
    // Files panel mounts a SortableList root into the body — use its
    // presence as the "panel is open" signal.
    return !!panelOverlay.querySelector(".tree-list-root");
  }
  // Images is reserved for image attachments and Trash is reserved for
  // deletion — neither should accept imported docs / notebooks. Match
  // the same id convention the files-panel uses (`__images__` /
  // `__trash__`, with optional per-desk `:<deskId>` suffixes).
  const isImagesId = (id) => id === "__images__" || id?.startsWith?.("__images__:");
  const isTrashId = (id) => id === "__trash__" || id?.startsWith?.("__trash__:");
  function isInsideReserved(nodeId) {
    if (!nodeId) return false;
    if (isImagesId(nodeId) || isTrashId(nodeId)) return true;
    let cur = findParent(state.fileTree, nodeId);
    while (cur) {
      if (isImagesId(cur.id) || isTrashId(cur.id)) return true;
      cur = findParent(state.fileTree, cur.id);
    }
    return false;
  }
  /** Resolve the target row under the pointer to a tree-node id that
   *  accepts new children (folder / project / desk / Inbox). Returns the
   *  active desk's Inbox when the pointer is over an empty area, a
   *  non-container row, or a row inside the reserved Images / Trash
   *  subtrees. */
  function resolveDropParent(e) {
    const row = e.target?.closest?.(".sl-item");
    if (!row) return state.getInboxId();
    const id = row.dataset.id;
    const node = id ? findTreeNode(state.fileTree, id) : null;
    if (!node) return state.getInboxId();
    // Reject the row outright when it's Images, Trash, or anything
    // nested within them — fall back to Inbox so the user still gets
    // a sensible landing spot.
    if (isInsideReserved(node.id)) return state.getInboxId();
    if (node.type === "folder" || node.type === "project" || node.type === "desk") return node.id;
    // Document / notebook / image rows → fall back to their parent.
    const parent = findParent(state.fileTree, node.id);
    if (parent && !isInsideReserved(parent.id) &&
        (parent.type === "folder" || parent.type === "project" || parent.type === "desk")) {
      return parent.id;
    }
    return state.getInboxId();
  }
  function findTreeNode(nodes, id) {
    for (const n of nodes || []) {
      if (n.id === id) return n;
      const r = findTreeNode(n.children, id);
      if (r) return r;
    }
    return null;
  }
  function findParent(nodes, id) {
    for (const n of nodes || []) {
      if (Array.isArray(n.children)) {
        if (n.children.some((c) => c?.id === id)) return n;
        const deeper = findParent(n.children, id);
        if (deeper) return deeper;
      }
    }
    return null;
  }
  function highlightTargetRow(parentId) {
    clearRowHighlight();
    if (!parentId) return;
    const row = panelOverlay.querySelector(`.sl-item[data-id="${parentId}"]`);
    if (row) {
      row.classList.add("drop-target");
      lastDropTargetRow = row;
    }
  }

  panelOverlay.addEventListener("dragover", (e) => {
    if (!filesPanelMounted()) return;
    if (!e.dataTransfer?.types?.includes?.("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const parentId = resolveDropParent(e);
    highlightTargetRow(parentId);
  });
  panelOverlay.addEventListener("dragleave", (e) => {
    // Only clear when the pointer actually leaves the overlay element.
    if (e.target === panelOverlay) clearRowHighlight();
  });
  panelOverlay.addEventListener("drop", async (e) => {
    if (!filesPanelMounted()) return;
    const importable = findImportableFiles(e);
    if (importable.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const parentId = resolveDropParent(e);
    clearRowHighlight();
    hideImport();
    for (const file of importable) {
      try { await importFileIntoTree(state, file, parentId); }
      catch (err) { console.error("Sidebar import failed:", err); }
    }
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
    if (dragCounter === 1 && !panelOverlay.classList.contains("hidden") && filesPanelMounted()) {
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

/** Import a single dropped file into the tree under `parentId`. Handles
 *  both plain-text docs (`.md`, `.txt`) and notebooks (`.hushnote` —
 *  unpacked via the same sync helper Dropbox uses). */
async function importFileIntoTree(state, file, parentId) {
  const baseName = file.name.replace(/\.[^.]+$/, "") || "Imported";
  if (isPdfFile(file)) {
    const buf = await file.arrayBuffer();
    return state.importPdf(baseName, new Uint8Array(buf), parentId, { openImmediately: false });
  }
  if (isNotebookFile(file)) {
    const buf = await file.arrayBuffer();
    const { unpackNotebook } = await import("../sync/notebook-sync.js");
    const content = await unpackNotebook(new Uint8Array(buf));
    return state.createNotebook(baseName, parentId, { openImmediately: false, initialContent: content });
  }
  if (isTextFile(file)) {
    const text = await file.text();
    return state.newFile(parentId, { openImmediately: false, initialContent: text, initialName: baseName });
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
  // Pick the insertion point — the coordinate under the cursor, or the
  // selection head if the coord lies between lines.
  let pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos == null) pos = view.posAtCoords({ x: clientX, y: clientY }, false);
  if (pos == null) pos = view.state.selection.main.head;
  await insertImagesAtPos(state, view, files, pos, state.currentLocalSync);
}

/** Save each File to the Images folder (or sibling folder for Local Sync)
 *  and insert markdown refs at `pos` in the given CodeMirror view. Shared
 *  by drag-drop (drop coords) and the paste handler (cursor head).
 *  `localSync` accepts either `{ folderId, relPath }` (whole file path —
 *  baseDir is derived from it) or `{ folderId, baseDir }` (already
 *  derived). */
export async function insertImagesAtPos(state, view, files, pos, localSync) {
  if (!view) return;
  const { buildImageMarkdown } = await import("../state/state-images.js");
  const chunks = [];
  if (localSync?.folderId && (localSync.relPath || typeof localSync.baseDir === "string")) {
    let baseDir;
    if (typeof localSync.baseDir === "string") {
      baseDir = localSync.baseDir;
    } else {
      const slash = localSync.relPath.lastIndexOf("/");
      baseDir = slash >= 0 ? localSync.relPath.slice(0, slash) : "";
    }
    const { writeFileBytes } = await import("../sync/local-sync.js");
    const { isImageFile } = await import("../state/state-images.js");
    for (const file of files) {
      if (!isImageFile(file)) continue;
      try {
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const target = baseDir ? `${baseDir}/${file.name}` : file.name;
        const finalRel = await writeFileBytes(localSync.folderId, target, bytes);
        const finalName = (finalRel || target).split("/").pop();
        const altSrc = finalName.replace(/\.[^.]+$/, "") || "image";
        chunks.push(buildImageMarkdown(altSrc, finalName));
      } catch (e) {
        console.error("Local Sync image insert failed:", e);
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
