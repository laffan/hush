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
  readFile, readFileBytes, writeFileBytes, createLocalFile, moveLocalEntry,
  deleteLocalEntry, localKindForName,
} from "../sync/local-sync.js";
import {
  invalidateLocalSyncCache, refreshLocalSyncSection,
} from "./files-panel-local-sync.js";
import { findNode } from "../state/tree-helpers.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function baseName(name, isDir) {
  if (isDir) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
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
  if (node && node.type === "desk") return { kind: "vc", nodeId: state.getInboxId(nodeId) || state.getInboxId() };
  if (nodeId && (nodeId === "__inbox__" || nodeId.startsWith("__inbox__"))) return { kind: "vc", nodeId };
  return { kind: "vc", nodeId: state.getInboxId() };
}

/** Move a Local Sync entry into the VC store under `vcParentId`, then
 *  delete it from disk. */
export async function moveLocalToVc(state, folderId, relPath, name, vcParentId) {
  const kind = localKindForName(name);
  const base = baseName(name, false);
  let parent = vcParentId || state.getInboxId();
  const pNode = findNode(state.fileTree, parent);
  if (pNode && pNode.type === "desk") parent = state.getInboxId(parent) || state.getInboxId();

  if (kind === "notebook") {
    const bytes = await readFileBytes(folderId, relPath);
    const { unpackNotebook } = await import("../sync/notebook-sync.js");
    const json = await unpackNotebook(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    await state.createNotebook(base, parent, { openImmediately: false, initialContent: json });
  } else if (kind === "stack") {
    const text = await readFile(folderId, relPath);
    await state.createStack(base, parent, { openImmediately: false, initialContent: text });
  } else if (kind === "image") {
    const bytes = await readFileBytes(folderId, relPath);
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const file = new File([arr], name, { type: "application/octet-stream" });
    await state.createImageFromFile(file);
  } else {
    const content = await readFile(folderId, relPath);
    await state.newFile(parent, { openImmediately: false, initialContent: content, initialName: base });
  }

  // The original now lives in the VC store — remove it from disk (move).
  await deleteLocalEntry(folderId, relPath);
  // If the moved file was the open Local Sync file, drop the editor back
  // so it doesn't keep autosaving to a path that's gone.
  const cur = state.currentLocalSync;
  if (cur && cur.folderId === folderId && cur.relPath === relPath) {
    state.currentLocalSync = null;
  }
  invalidateLocalSyncCache();
  state.emit("files-changed");
}

/** Move a VC tree node onto disk inside a Local Sync mount, then move the
 *  VC original to Trash. Returns false for types that can't be reflected
 *  to a single on-disk file (folders / projects / pdfs). */
export async function moveVcToLocal(state, node, folderId, dirRel) {
  if (!node || !node.fileId) return false;
  const dir = dirRel || "";
  if (node.type === "document") {
    const content = await loadVcContent(node.fileId, state);
    await createLocalFile(folderId, joinRel(dir, `${node.name}.md`), content);
  } else if (node.type === "notebook") {
    const content = await loadVcContent(node.fileId, state);
    const { packNotebook } = await import("../sync/notebook-sync.js");
    const bytes = await packNotebook(content || '{"format":"hushnote","version":1,"shapes":[]}');
    await writeFileBytes(folderId, joinRel(dir, `${node.name}.hushnote`), Array.from(bytes), false);
  } else if (node.type === "stack") {
    const content = await loadVcContent(node.fileId, state);
    await createLocalFile(folderId, joinRel(dir, `${node.name}.hushstack`), content);
  } else if (node.type === "image") {
    const dataUrl = await state.loadImageDataUrl(node.fileId);
    if (!dataUrl) return false;
    const arr = dataUrlToBytes(dataUrl);
    await writeFileBytes(folderId, joinRel(dir, node.name), Array.from(arr), false);
  } else {
    return false; // folders / projects / pdfs aren't single-file reflections
  }

  // Move the VC original to Trash (recoverable) — disk now owns the file.
  await state.deleteTreeNode(node.id);
  invalidateLocalSyncCache();
  refreshLocalSyncSection();
  state.emit("files-changed");
  return true;
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
