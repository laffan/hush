/**
 * Local Folder → Hush import — the shared "bring an on-disk entry into
 * the VC store" layer used by both drag-and-drop (move semantics, see
 * files-panel-local-sync-dnd.js) and the row menu's "Copy to Hush"
 * (copy semantics, destination picked in a modal).
 *
 * Files import one-to-one (doc / notebook / stack / image); directories
 * import recursively as a folder (or a nested project when the
 * destination is a project, since projects can't contain folders).
 * With `deleteOriginal` the imported files are removed from disk
 * one-by-one and each emptied directory is removed only when nothing
 * unimported remains inside (`deleteLocalDirIfClean`) — the sidebar
 * listing hides unsupported extensions and dotfiles, and a blind
 * recursive delete would destroy files the import never saw.
 */
import {
  readDir, readFile, readFileBytes, localKindForName, deleteLocalEntry,
  deleteLocalDirIfClean,
} from "../sync/local-sync.js";
import { findNode } from "../state/tree-helpers.js";
import { escHtml, typeIcons } from "./files-panel-shared.js";

function baseName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Import a single on-disk file into the VC store under `vcParentId`.
 * Returns `{ created, kind }` (created is null for images — they land
 * in the global Images store, not the tree parent). With
 * `deleteOriginal` the on-disk file is removed after the import.
 */
export async function importLocalFileToVc(state, folderId, relPath, name, vcParentId, { deleteOriginal = false } = {}) {
  const kind = localKindForName(name);
  const base = baseName(name);
  const parent = vcParentId || state.getInboxId();

  let created = null;
  if (kind === "notebook") {
    const bytes = await readFileBytes(folderId, relPath);
    const { unpackNotebook } = await import("../sync/notebook-sync.js");
    const json = await unpackNotebook(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    created = await state.createNotebook(base, parent, { openImmediately: false, initialContent: json });
  } else if (kind === "stack") {
    const text = await readFile(folderId, relPath);
    created = await state.createStack(base, parent, { openImmediately: false, initialContent: text });
  } else if (kind === "image") {
    const bytes = await readFileBytes(folderId, relPath);
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const file = new File([arr], name, { type: "application/octet-stream" });
    await state.createImageFromFile(file);
  } else {
    created = await state.newFile(parent, { openImmediately: false, initialContent: await readFile(folderId, relPath), initialName: base });
  }

  if (deleteOriginal) await deleteLocalEntry(folderId, relPath);
  return { created, kind };
}

/**
 * Recursively import an on-disk directory into the VC store as a folder
 * (or a nested project when the destination container is a project —
 * projects can't hold folders). Returns the created container node.
 *
 * `onFileImported(relPath, created, kind)` fires for every imported
 * file so the caller can e.g. re-point the editor when the currently
 * open Local Sync file was part of the move.
 */
export async function importLocalDirToVc(state, folderId, relPath, name, vcParentId, opts = {}) {
  const { deleteOriginal = false, onFileImported = null } = opts;
  const parentId = vcParentId || state.getInboxId();
  const parentNode = findNode(state.fileTree, parentId);
  const containerType = parentNode?.type === "project" ? "project" : "folder";
  const container = containerType === "project"
    ? await state.createProject(name, parentId)
    : await state.createFolder(name, parentId);
  if (!container) throw new Error(`Failed to create ${containerType} "${name}"`);

  const entries = await readDir(folderId, relPath);
  for (const entry of entries) {
    const childRel = entry.relPath || entry.rel_path;
    if (entry.isDir || entry.is_dir) {
      await importLocalDirToVc(state, folderId, childRel, entry.name, container.id, opts);
    } else {
      const { created, kind } = await importLocalFileToVc(state, folderId, childRel, entry.name, container.id, { deleteOriginal });
      if (onFileImported) onFileImported(childRel, created, kind);
    }
  }

  // Remove the (now hollow) directory only when nothing unimported is
  // left inside — otherwise it stays behind with its remaining files.
  if (deleteOriginal) {
    try { await deleteLocalDirIfClean(folderId, relPath); }
    catch (e) { console.warn("Local Sync: dir cleanup after move failed:", e); }
  }
  return container;
}

// ── "Copy to Hush" destination picker ────────────────────────────────

let _overlayEl = null;
function closeModal() {
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
  document.removeEventListener("keydown", onKey, true);
}
function onKey(e) { if (e.key === "Escape") { closeModal(); e.stopPropagation(); } }

/** Walk the active desk for containers that can receive an import:
 *  the Inbox first, then every folder / project in tree order (Images /
 *  Trash and Local Folder mounts excluded). Returns [{ id, name, type,
 *  depth }]. */
function collectDestinations(state) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === state.settings?.activeDeskId)
    || (state.fileTree || []).find((n) => n.type === "desk");
  const out = [];
  const inboxId = state.getInboxId();
  const inbox = findNode(state.fileTree, inboxId);
  if (inbox) out.push({ id: inboxId, name: "Inbox", type: "inbox", depth: 0 });
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      if (!n || state.isSpecialNodeId(n.id)) continue;
      if (n.type === "folder" || n.type === "project") {
        out.push({ id: n.id, name: n.name || "Untitled", type: n.type, depth });
        walk(n.children, depth + 1);
      }
    }
  };
  walk(desk?.children, 0);
  return out;
}

/**
 * Open the destination picker and copy `targets` (array of
 * `{ folder, relPath, name, isDir }`) into the chosen container.
 * Copy semantics — nothing on disk is touched.
 */
export function openCopyToHushModal(state, targets, { onDone = null } = {}) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (!list.length) return;
  const destinations = collectDestinations(state);
  if (!destinations.length) return;

  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "send-to-desk-overlay";
  const title = list.length === 1 ? "Copy to Hush" : `Copy ${list.length} items to Hush`;
  const first = list[0];
  const nameLabel = list.length === 1 ? first.name : `${first.name} +${list.length - 1} more`;
  const iconFor = (d) => d.type === "inbox" ? typeIcons.inbox
    : d.type === "project" ? typeIcons.project : typeIcons.folder;
  const rows = destinations.map((d, i) => `
    <button class="send-to-desk-row" type="button" data-dest-index="${i}"
            style="padding-left:${10 + d.depth * 16}px">
      <span class="send-to-desk-row-icon">${iconFor(d)}</span>
      <span class="send-to-desk-row-label">${escHtml(d.name)}</span>
    </button>
  `).join("");
  overlay.innerHTML = `
    <div class="send-to-desk-modal">
      <div class="send-to-desk-title">${escHtml(title)}</div>
      <div class="send-to-desk-name">
        <span class="send-to-desk-name-icon">${first.isDir ? typeIcons.folder : typeIcons.document}</span>
        <span class="send-to-desk-name-label">${escHtml(nameLabel)}</span>
      </div>
      <div class="send-to-desk-list">${rows}</div>
      <div class="send-to-desk-actions">
        <button class="send-to-desk-cancel" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlayEl = overlay;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector(".send-to-desk-cancel").addEventListener("click", closeModal);
  overlay.querySelectorAll(".send-to-desk-row").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dest = destinations[Number(btn.dataset.destIndex)];
      closeModal();
      if (!dest) return;
      try {
        for (const t of list) {
          if (t.isDir) await importLocalDirToVc(state, t.folder.id, t.relPath, t.name, dest.id, { deleteOriginal: false });
          else await importLocalFileToVc(state, t.folder.id, t.relPath, t.name, dest.id, { deleteOriginal: false });
        }
        state.emit("files-changed");
        if (onDone) onDone(dest);
      } catch (e) {
        console.error("Copy to Hush failed:", e);
      }
    });
  });
  document.addEventListener("keydown", onKey, true);
}
