/**
 * Local Sync drag-and-drop — moving files/folders across the
 * local↔normal divide (Finder-style move semantics) and within a mount.
 *
 *  - Local → normal tree folder: read the file, import it into the VC
 *    store under the target container, then delete it from disk.
 *  - Normal tree item → local folder: serialize the VC item to its
 *    on-disk form (.md / .hushnote / .hushstack / image bytes), write it
 *    into the mount, then move the VC original to Trash (recoverable).
 *  - Local → local: move the entry on disk within the same mount.
 *
 * The local-origin drag is owned here (own pointer pipeline); the
 * normal-origin drag is routed in via the SortableList `onDropExternal`
 * hook wired in files-panel.js.
 */
import {
  writeFileBytes, createLocalFile,
  localKindForName, openLocalEntry,
} from "../sync/local-sync.js";
import {
  invalidateLocalSyncCache, refreshLocalSyncSection,
} from "./files-panel-local-sync.js";
import { importLocalFileToVc, importLocalDirToVc } from "./files-panel-local-import.js";
import { findNode } from "../state/tree-helpers.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function parentDir(rel) {
  const i = String(rel).lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}
function joinRel(dir, name) { return dir ? `${dir}/${name}` : name; }

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  // A well-formed data URL always has a comma; bail rather than feed the
  // `data:...;base64` prefix into atob (which would throw).
  if (comma < 0) return new Uint8Array(0);
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Resolve a drop point to a destination, distinguishing a Local Sync
 * target from a normal-tree container. Returns one of:
 *   { kind: "local", folderId, dirRel }
 *   { kind: "vc", nodeId }
 *   null
 * `excludeEl` is the dragged row itself (skip it in the hit stack).
 */
export function hitTestDropTarget(state, clientX, clientY, excludeEl) {
  const stack = document.elementsFromPoint(clientX, clientY);
  const item = stack.find((n) =>
    n instanceof HTMLElement && n.classList.contains("sl-item") && n !== excludeEl
    && !(excludeEl && excludeEl.contains(n)));
  if (!item) return null;

  if (item.closest(".local-sync-root")) {
    // Local row: dataset.id = `${folderId}:${relPath}`.
    const id = item.dataset.id || "";
    const c = id.indexOf(":");
    if (c < 0) return null;
    const folderId = id.slice(0, c);
    const relPath = id.slice(c + 1);
    const isDir = item.classList.contains("has-children");
    return { kind: "local", folderId, dirRel: isDir ? relPath : parentDir(relPath) };
  }

  // Normal tree row. Containers accept the drop directly; anything else
  // falls back to the active desk's Inbox.
  const nodeId = item.dataset.id;
  const node = nodeId ? findNode(state.fileTree, nodeId) : null;
  if (node && (node.type === "folder" || node.type === "project")) return { kind: "vc", nodeId };
  if (node && node.type === "desk") return { kind: "vc", nodeId: deskInboxId(state, node.id) };
  if (nodeId && (nodeId === "__inbox__" || nodeId.startsWith("__inbox__"))) return { kind: "vc", nodeId };
  return { kind: "vc", nodeId: state.getInboxId() };
}

/** The Inbox id for a specific desk, falling back to the active desk's
 *  Inbox when that desk has no per-desk Inbox node. */
function deskInboxId(state, deskId) {
  const perDesk = `__inbox__:${deskId}`;
  return findNode(state.fileTree, perDesk) ? perDesk : state.getInboxId();
}

/** Move a Local Sync entry into the VC store under `vcParentId`, then
 *  delete it from disk. */
export async function moveLocalToVc(state, folderId, relPath, name, vcParentId) {
  let parent = vcParentId || state.getInboxId();
  const pNode = findNode(state.fileTree, parent);
  if (pNode && pNode.type === "desk") parent = deskInboxId(state, pNode.id);
  // Was this the file currently open on a Local Sync surface? If so we
  // re-open the freshly-imported VC copy after the move so the editor
  // doesn't keep showing the now-deleted on-disk file. Flush unsaved
  // keystrokes to disk first so the import reads the latest content.
  const cur = state.currentLocalSync;
  const wasOpen = !!cur && cur.folderId === folderId && cur.relPath === relPath;
  if (wasOpen && state.dirty) await state.saveCurrentFile();

  const { created, kind } = await importLocalFileToVc(state, folderId, relPath, name, parent, { deleteOriginal: true });
  if (wasOpen) {
    // Detach from the deleted on-disk file before opening so no autosave
    // recreates it, then open the VC copy on the right surface.
    state.currentLocalSync = null;
    state.dirty = false;
  }
  invalidateLocalSyncCache();
  state.emit("files-changed");
  if (wasOpen && created?.fileId) {
    if (kind === "notebook") await state.openNotebook(created.fileId);
    else if (kind === "stack") await state.openStack(created.fileId);
    else await state.openFile(created.fileId);
  }
}

/** Move a whole Local Sync directory into the VC store under
 *  `vcParentId` — recursive import as a folder (or nested project when
 *  the destination is a project), then per-file deletes plus a
 *  clean-only directory removal so unimported files survive. */
export async function moveLocalDirToVc(state, folderId, relPath, name, vcParentId) {
  let parent = vcParentId || state.getInboxId();
  const pNode = findNode(state.fileTree, parent);
  if (pNode && pNode.type === "desk") parent = deskInboxId(state, pNode.id);

  // If the open Local Sync file lives inside the moved directory, track
  // its imported copy so the editor can be re-pointed after the move.
  const cur = state.currentLocalSync;
  const openInside = !!cur && cur.folderId === folderId
    && (cur.relPath === relPath || cur.relPath.startsWith(relPath + "/"));
  if (openInside && state.dirty) await state.saveCurrentFile();
  let openImport = null;

  await importLocalDirToVc(state, folderId, relPath, name, parent, {
    deleteOriginal: true,
    onFileImported: (rel, created, kind) => {
      if (openInside && cur.relPath === rel) openImport = { created, kind };
    },
  });

  if (openInside) {
    state.currentLocalSync = null;
    state.dirty = false;
  }
  invalidateLocalSyncCache();
  state.emit("files-changed");
  if (openImport?.created?.fileId) {
    const { created, kind } = openImport;
    if (kind === "notebook") await state.openNotebook(created.fileId);
    else if (kind === "stack") await state.openStack(created.fileId);
    else await state.openFile(created.fileId);
  } else if (openInside) {
    await state.clearActiveFile();
  }
}

/** Move a VC tree node onto disk inside a Local Sync mount, then move the
 *  VC original to Trash. Returns false for types that can't be reflected
 *  to a single on-disk file (folders / projects / pdfs). */
export async function moveVcToLocal(state, node, folderId, dirRel) {
  if (!node || !node.fileId) return false;
  const dir = dirRel || "";
  // Was this VC item the open file? If so, re-open the on-disk copy after
  // the move so the editor doesn't get stranded on the trashed original
  // (which would otherwise flip to the read-only "In the Trash" banner).
  const wasOpen = state.currentFileId === node.fileId
    || state.currentNotebookFileId === node.fileId
    || state.currentStackFileId === node.fileId;
  let finalRel = null;
  if (node.type === "document") {
    const content = await loadVcContent(node.fileId, state);
    finalRel = await createLocalFile(folderId, joinRel(dir, `${node.name}.md`), content);
  } else if (node.type === "notebook") {
    const content = await loadVcContent(node.fileId, state);
    const { packNotebook } = await import("../sync/notebook-sync.js");
    const bytes = await packNotebook(content || '{"format":"hushnote","version":1,"shapes":[]}');
    finalRel = await writeFileBytes(folderId, joinRel(dir, `${node.name}.hushnote`), Array.from(bytes), false);
  } else if (node.type === "stack") {
    const content = await loadVcContent(node.fileId, state);
    finalRel = await createLocalFile(folderId, joinRel(dir, `${node.name}.hushstack`), content);
  } else if (node.type === "image") {
    const dataUrl = await state.loadImageDataUrl(node.fileId);
    if (!dataUrl) return false;
    const arr = dataUrlToBytes(dataUrl);
    finalRel = await writeFileBytes(folderId, joinRel(dir, node.name), Array.from(arr), false);
  } else {
    return false; // folders / projects / pdfs aren't single-file reflections
  }

  // Move the VC original to Trash (recoverable) — disk now owns the file.
  await state.deleteTreeNode(node.id);
  invalidateLocalSyncCache();
  refreshLocalSyncSection();
  state.emit("files-changed");
  if (wasOpen && finalRel && node.type !== "image") {
    await openLocalEntry(state, folderId, finalRel, finalRel.split("/").pop());
  }
  return true;
}

// ── Drop-target outline (for the local-origin pointer drag) ─────────
let _highlightedRow = null;
export function clearDropHighlight() {
  if (_highlightedRow) { _highlightedRow.classList.remove("sl-drop-target-item"); _highlightedRow = null; }
}
/** Outline the row under the pointer if it's a valid drop destination —
 *  a normal-tree container (folder/project/desk/inbox) or a Local Sync
 *  folder. Mirrors the SortableList's own `sl-drop-target-item` cue. */
export function highlightDropTargetAt(clientX, clientY, excludeEl) {
  const stack = document.elementsFromPoint(clientX, clientY);
  const item = stack.find((n) =>
    n instanceof HTMLElement && n.classList.contains("sl-item") && n !== excludeEl
    && !(excludeEl && excludeEl.contains(n)));
  let target = null;
  if (item) {
    if (item.closest(".local-sync-root")) {
      target = item.classList.contains("has-children") ? item : item.parentElement?.closest(".sl-item.has-children");
    } else if (item.hasAttribute("data-path")) {
      const t = item.dataset.type;
      if (t === "folder" || t === "project" || t === "desk") target = item;
    }
  }
  if (_highlightedRow && _highlightedRow !== target) _highlightedRow.classList.remove("sl-drop-target-item");
  if (target) target.classList.add("sl-drop-target-item");
  _highlightedRow = target || null;
}

const MOVABLE_TO_LOCAL = new Set(["document", "notebook", "stack", "image"]);

/**
 * SortableList `onDropExternal` hook — claims a normal-tree drop that
 * landed over a Local Sync folder row and moves the item onto disk.
 * Returns true (claim) only for types we can reflect to a single file.
 */
export function onLocalDropExternal(state, draggedItem, ev) {
  if (!draggedItem || !MOVABLE_TO_LOCAL.has(draggedItem.type)) return false;
  const hit = hitTestDropTarget(state, ev.clientX, ev.clientY, null);
  if (!hit || hit.kind !== "local") return false;
  moveVcToLocal(state, draggedItem, hit.folderId, hit.dirRel)
    .catch((e) => console.error("Move into Local Sync failed:", e));
  return true;
}

async function loadVcContent(fileId, state) {
  try {
    const file = await invoke("load_file", { id: fileId });
    return file?.content || "";
  } catch {
    const f = (state.files || []).find((x) => x.id === fileId);
    return f?.content || "";
  }
}
