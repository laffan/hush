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
const STACK_EXTENSIONS = [".hushstack"];
const PROJECT_EXTENSIONS = [".hushproject"];
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

function isStackFile(file) {
  return STACK_EXTENSIONS.includes(getExtension(file.name));
}

function isProjectFile(file) {
  return PROJECT_EXTENSIONS.includes(getExtension(file.name));
}

function isImportableFile(file) {
  return isTextFile(file) || isNotebookFile(file) || isStackFile(file) || isProjectFile(file);
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

/**
 * Pull every File off the drop event. iPadOS WKWebView often hands
 * external-app drops through `dataTransfer.items` (with `kind: "file"`)
 * while leaving `dataTransfer.files` empty, so we union both sources
 * and dedupe by name+size.
 */
function collectDroppedFiles(e) {
  const seen = new Set();
  const out = [];
  const push = (f) => {
    if (!f) return;
    const key = `${f.name}|${f.size}|${f.lastModified ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  const list = e.dataTransfer?.files;
  if (list) {
    for (let i = 0; i < list.length; i++) push(list[i]);
  }
  const items = e.dataTransfer?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === "file") {
        try { push(it.getAsFile()); } catch (_) { /* ignore */ }
      }
    }
  }
  return out;
}

function findImportableFiles(e) {
  return collectDroppedFiles(e).filter(isImportableFile);
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
    // Always clear the sidebar import overlay on any drop. This runs in
    // the capture phase so it fires even when a descendant target (the
    // editor / notebook canvas) handles the drop and calls
    // stopPropagation() before a bubble-phase listener could reset it —
    // otherwise the "Import file" outline lingers after dropping into a
    // doc.
    dragCounter = 0;
    hideImport();
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
  const isPdfsId = (id) => id === "__pdfs__" || id?.startsWith?.("__pdfs__:");
  const isTrashId = (id) => id === "__trash__" || id?.startsWith?.("__trash__:");
  function isInsideReserved(nodeId) {
    if (!nodeId) return false;
    if (isImagesId(nodeId) || isPdfsId(nodeId) || isTrashId(nodeId)) return true;
    let cur = findParent(state.fileTree, nodeId);
    while (cur) {
      if (isImagesId(cur.id) || isPdfsId(cur.id) || isTrashId(cur.id)) return true;
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
    const dropped = collectDroppedFiles(e);
    const importable = dropped.filter(isImportableFile);
    // Surface drops that landed on the sidebar but carried no usable
    // payload — saves the user staring at a green-plus cursor that did
    // nothing. iPadOS occasionally hands us file refs with empty names
    // when the source app didn't co-ordinate the UTI properly.
    if (importable.length === 0) {
      if (dropped.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        clearRowHighlight();
        hideImport();
        const { showImportToast } = await import("./import-toast.js");
        const names = dropped.map((f) => f.name || "(unnamed)").join(", ");
        showImportToast(`Couldn't import dropped file: ${names}`, "error");
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const parentId = resolveDropParent(e);
    clearRowHighlight();
    hideImport();
    const { showImportToast } = await import("./import-toast.js");
    let successes = 0;
    let failures = 0;
    for (const file of importable) {
      try {
        await importFileIntoTree(state, file, parentId);
        successes++;
      } catch (err) {
        console.error("Sidebar import failed:", err);
        failures++;
        showImportToast(`Import failed for ${file.name}: ${err?.message || err}`, "error");
      }
    }
    if (successes > 0 && failures === 0) {
      const label = successes === 1 ? importable[0].name : `${successes} files`;
      showImportToast(`Imported ${label}`, "success");
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
  // The drop-reset is handled by the capture-phase listener in the global
  // safety net above so it survives a descendant's stopPropagation().

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
  if (isNotebookFile(file)) {
    const buf = await file.arrayBuffer();
    const { unpackNotebook } = await import("../sync/notebook-sync.js");
    const content = await unpackNotebook(new Uint8Array(buf));
    return state.createNotebook(baseName, parentId, { openImmediately: false, initialContent: content });
  }
  if (isStackFile(file)) {
    // .hushstack is a plain JSON envelope — re-import it verbatim so the
    // items, widths, and scroll state ride along with the copy.
    const text = await file.text();
    return state.createStack(baseName, parentId, { openImmediately: false, initialContent: text });
  }
  if (isProjectFile(file)) {
    // .hushproject is a zip envelope bundling the project's docs, notebooks,
    // and stacks — unpack it into a real project subtree.
    const buf = await file.arrayBuffer();
    return state.importProject(new Uint8Array(buf), parentId, { openImmediately: false });
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
