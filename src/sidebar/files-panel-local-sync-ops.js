/**
 * Local Sync row operations — the hamburger dropdown menu and the action
 * handlers behind it (New Doc / Notebook / Stack / Folder, Rename,
 * Duplicate, Delete, Reveal, Unlink). These bring a Local Sync mount to
 * parity with the regular file tree's row menu, operating directly on the
 * filesystem via the `sync/local-sync.js` wrappers.
 *
 * Split out of files-panel-local-sync.js to keep that file (subtree
 * rendering) under the 700-line cap.
 */
import { showPromptModal, showDeleteConfirmModal } from "./files-panel-shared.js";
import {
  createLocalFile, createLocalDir, renameLocalEntry, deleteLocalEntry,
  copyLocalEntry, writeFileBytes, localKindForName, openLocalEntry,
} from "../sync/local-sync.js";
import {
  invalidateLocalSyncCache, refreshLocalSyncSection, expandLocalSyncKey,
} from "./files-panel-local-sync.js";

const HAMBURGER_SVG = `<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

export function localRowMenuButtonHtml(label = "Menu") {
  return `<span class="tree-actions"><button class="tree-action-menu" data-local-sync-action="menu" data-tooltip="${label}" aria-label="${label}">${HAMBURGER_SVG}</button></span>`;
}

// ── Menu lifecycle ──────────────────────────────────────────────────
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  document.removeEventListener("mousedown", openMenu.onDown, true);
  document.removeEventListener("keydown", openMenu.onKey, true);
  window.removeEventListener("blur", closeMenu);
  openMenu.el.remove();
  openMenu = null;
}

/** Join a directory rel-path with a child name ("" dir → bare name). */
function joinRel(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

/** Directory that contains `relPath` ("" at the mount root). */
function parentDir(relPath) {
  const i = String(relPath).lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/** Split a filename into base + extension (extension empty for dirs). */
function splitName(name, isDir) {
  if (isDir) return { base: name, ext: "" };
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: "" };
}

/**
 * Open the dropdown for a Local Sync row.
 *   target = { folder, relPath, name, isDir, isRoot }
 *   ctx    = { state, refreshFilesPanel, hidePanel, onUnlink }
 */
export function openLocalEntryMenu(anchorBtn, target, ctx) {
  closeMenu();
  const { folder, relPath, name, isDir, isRoot } = target;
  const menu = document.createElement("div");
  menu.className = "tree-row-menu";

  const add = (label, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-row-menu-item";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      Promise.resolve(handler()).catch((err) => console.error("Local Sync action failed:", err));
    });
    menu.appendChild(b);
  };

  // The directory new entries land in: the folder itself for a container
  // row, or the file's parent dir for a file row.
  const dir = isDir ? relPath : parentDir(relPath);

  if (isDir) {
    add("New Doc", () => newDoc(folder, dir, ctx));
    add("New Notebook", () => newNotebook(folder, dir, ctx));
    add("New Stack", () => newStack(folder, dir, ctx));
    add("New Folder", () => newFolder(folder, dir, ctx));
  }

  // Rename / Duplicate / Delete apply to every nested row; the mount root
  // is renamed/removed via Unlink (renaming the on-disk root would move
  // the mount out from under its bookmark), so they're skipped there.
  if (!isRoot) {
    add("Rename", () => renameEntry(folder, relPath, name, isDir, ctx));
    add("Duplicate", () => duplicateEntry(folder, relPath, ctx));
  }
  if (isDir) {
    add(isRoot ? "View in Finder" : "Reveal", () => reveal(folder, relPath));
  }
  if (!isRoot) {
    add("Delete", () => deleteEntry(folder, relPath, name, isDir, ctx));
  }
  if (isRoot && ctx.onUnlink) {
    add("Unlink Folder", () => ctx.onUnlink());
  }

  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  const mW = menu.offsetWidth, mH = menu.offsetHeight;
  let top = rect.bottom + 4;
  if (top + mH > window.innerHeight - 6) top = Math.max(6, rect.top - mH - 4);
  let left = rect.right - mW;
  if (left < 6) left = 6;
  if (left + mW > window.innerWidth - 6) left = window.innerWidth - mW - 6;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
  openMenu = { el: menu, onDown, onKey };
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", closeMenu);
  });
}

// ── Action handlers ─────────────────────────────────────────────────

function afterMutation(folder, dir, ctx) {
  invalidateLocalSyncCache();
  if (dir != null) expandLocalSyncKey(`${folder.id}:${dir}`);
  refreshLocalSyncSection(ctx.refreshFilesPanel);
}

function newDoc(folder, dir, ctx) {
  showPromptModal({
    title: "New Doc", label: "Name", placeholder: "Untitled", confirmLabel: "Create",
    onConfirm: async (name) => {
      const base = (name || "Untitled").trim() || "Untitled";
      const rel = await createLocalFile(folder.id, joinRel(dir, `${base}.md`), `# ${base}\n`);
      afterMutation(folder, dir, ctx);
      if (rel) await openLocalEntry(ctx.state, folder.id, rel, rel.split("/").pop());
    },
  });
}

function newNotebook(folder, dir, ctx) {
  showPromptModal({
    title: "New Notebook", label: "Name", placeholder: "Untitled", confirmLabel: "Create",
    onConfirm: async (name) => {
      const base = (name || "Untitled").trim() || "Untitled";
      const { packNotebook } = await import("../sync/notebook-sync.js");
      const bytes = await packNotebook('{"format":"hushnote","version":1,"shapes":[]}');
      const rel = await writeFileBytes(folder.id, joinRel(dir, `${base}.hushnote`), Array.from(bytes), false);
      afterMutation(folder, dir, ctx);
      if (rel) await openLocalEntry(ctx.state, folder.id, rel, rel.split("/").pop());
    },
  });
}

function newStack(folder, dir, ctx) {
  showPromptModal({
    title: "New Stack", label: "Name", placeholder: "Untitled", confirmLabel: "Create",
    onConfirm: async (name) => {
      const base = (name || "Untitled").trim() || "Untitled";
      const { encodeStackContent } = await import("../stack/stack-content.js");
      const content = encodeStackContent([], 0, {});
      const rel = await createLocalFile(folder.id, joinRel(dir, `${base}.hushstack`), content);
      afterMutation(folder, dir, ctx);
      if (rel) await openLocalEntry(ctx.state, folder.id, rel, rel.split("/").pop());
    },
  });
}

function newFolder(folder, dir, ctx) {
  showPromptModal({
    title: "New Folder", label: "Name", placeholder: "Folder", confirmLabel: "Create",
    onConfirm: async (name) => {
      const base = (name || "Folder").trim() || "Folder";
      await createLocalDir(folder.id, joinRel(dir, base));
      afterMutation(folder, dir, ctx);
    },
  });
}

function renameEntry(folder, relPath, name, isDir, ctx) {
  const { base, ext } = splitName(name, isDir);
  const dir = parentDir(relPath);
  showPromptModal({
    title: "Rename", label: "Name", initialValue: base, confirmLabel: "Rename",
    onConfirm: async (next) => {
      const trimmed = (next || "").trim();
      if (!trimmed || trimmed === base) return;
      const newRel = await renameLocalEntry(folder.id, relPath, `${trimmed}${ext}`);
      afterMutation(folder, dir, ctx);
      // If the renamed entry — or, for a folder rename, a file *inside* it
      // — is currently open, re-open it at its new path so the editor /
      // canvas keeps tracking the right file on disk (otherwise the next
      // autosave writes to the now-stale path).
      const cur = ctx.state.currentLocalSync;
      if (newRel && cur && cur.folderId === folder.id) {
        let target = null;
        if (cur.relPath === relPath) target = newRel;
        else if (isDir && cur.relPath.startsWith(relPath + "/")) target = newRel + cur.relPath.slice(relPath.length);
        if (target) await openLocalEntry(ctx.state, folder.id, target, target.split("/").pop());
      }
    },
  });
}

async function duplicateEntry(folder, relPath, ctx) {
  await copyLocalEntry(folder.id, relPath);
  afterMutation(folder, parentDir(relPath), ctx);
}

function deleteEntry(folder, relPath, name, isDir, ctx) {
  showDeleteConfirmModal(
    `Delete ${isDir ? "folder" : "file"}`,
    `Permanently delete "${name}" from disk? This can't be undone.`,
    async () => {
      await deleteLocalEntry(folder.id, relPath);
      // If the deleted file (or a file under the deleted folder) is open,
      // drop the editor back to an empty buffer so it doesn't keep saving
      // to a path that no longer exists.
      const cur = ctx.state.currentLocalSync;
      const hit = cur && cur.folderId === folder.id
        && (cur.relPath === relPath || (isDir && cur.relPath.startsWith(relPath + "/")));
      if (hit) {
        if (ctx.state.currentNotebookFileId) { ctx.state.emit("notebook-unmount"); ctx.state.currentNotebookFileId = null; }
        if (ctx.state.currentStackFileId) { ctx.state.emit("stack-unmount"); ctx.state.currentStackFileId = null; }
        ctx.state.currentLocalSync = null;
        if (ctx.state.editor) { ctx.state.editor.setContent(""); ctx.state.dirty = false; }
        ctx.state.emit("file-opened");
      }
      afterMutation(folder, parentDir(relPath), ctx);
    }
  );
}

async function reveal(folder, relPath) {
  const { revealLocalSyncFolder } = await import("../sync/local-sync.js");
  // Reveal the actual row: the mount root for the root folder, or the
  // nested subfolder (relPath) for a nested one.
  await revealLocalSyncFolder(folder.id, folder.path, relPath || "");
}

export { localKindForName };
