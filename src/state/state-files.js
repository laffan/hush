/**
 * File and notebook open/create/save/delete/rename/duplicate operations
 * — extracted from state.js to keep under 700 lines. Each fn takes the
 * AppState instance as the first argument.
 */

import { findNode, findNodeByFileId, insertNode, removeNode, uniqueChildName } from "./tree-helpers.js";
import { stashActiveEditorState } from "./editor-cache-key.js";
import * as _naming from "./state-naming.js";

/** A doc is "empty Untitled" when it carries the placeholder name and
 *  has no actual content. Such docs are user noise — created when the
 *  app spins up a fresh slot but the user never typed into it — so we
 *  skip saving / syncing them and prune any survivors at boot. */
function isEmptyUntitled(name, content) {
  if (name && name !== "Untitled") return false;
  return !content || !content.trim();
}

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function saveCurrentFile(state) {
  if (state.currentProjectId) return state.saveProjectContent();
  if (state.currentLocalSync) {
    const m = await import("../sync/local-sync.js");
    return m.saveCurrentLocalSync(state);
  }
  if (!state.currentFileId || !state.editor) return;
  // A pull is in flight for the current file: don't upload the editor's
  // pre-pull buffer over the just-arriving remote content. The pull
  // releases the lock and clears `dirty`, so we'll resume normally.
  if (state._isPullLockedForCurrent()) return;
  const content = state.editor.getContent();
  state.dirty = false;
  // Empty Untitled docs aren't worth saving or syncing — the user never
  // gave them a title or content, so writing them to disk just produces
  // ghost files that haunt the next session.
  const node = findNodeByFileId(state.fileTree, state.currentFileId);
  if (isEmptyUntitled(node?.name, content)) return;
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_file", { id: state.currentFileId, content });
      // Patch just this file's entry in place rather than re-reading the
      // whole library. `list_files` loads and re-parses every file (and
      // every desk index, once per file) — an O(N²) whole-library scan
      // that ran on every 2 s autosave and stalled typing on large
      // libraries. A content save only changes this one file's content +
      // mtime, so update that entry directly. (Local Folder and notebook
      // saves take other paths that never called list_files — which is
      // why they never lagged.)
      const cached = state.files.find((f) => f.id === state.currentFileId);
      if (cached) {
        cached.content = content;
        cached.modified = Math.floor(Date.now() / 1000);
      } else {
        // A freshly-created file not yet in the cache — one full refresh
        // to pick it up. Rare, and off the steady-state typing hot path.
        state.files = await tauriInvoke("list_files");
      }
      state.syncFileToExternal(state.currentFileId, content);
    } catch (e) { console.error("Save failed:", e); }
  } else {
    const file = state.files.find((f) => f.id === state.currentFileId);
    if (file) {
      file.content = content;
      file.modified = Math.floor(Date.now() / 1000);
      // Seed name from first line on the very first save. Subsequent
      // renames go through maybeRenameFromFirstLine() which fires at
      // stable moments (cursor off line 1, editor blur).
      if (!file.name || file.name === "Untitled") file.name = _naming.deriveName(content);
      state._saveFilesLocal();
    }
  }
  if (_naming.updateTreeNodeNameByFileId(state, state.currentFileId)) {
    state.emit("files-changed");
  }
  // Autosave-path rename: update the filename to track the first line,
  // but only when the cursor has moved off it. While the user is still
  // typing in the title, we deliberately skip — preserves the old
  // behavior's "name follows first line" feel without per-keystroke
  // rename churn.
  if (!_naming.cursorOnFirstLine(state)) {
    await state.maybeRenameFromFirstLine();
  }
}

export async function newFile(state, parentId = null, opts = {}) {
  const openImmediately = opts.openImmediately !== false;
  if (openImmediately && state.dirty) await state.saveCurrentFile();
  // Unmount any active notebook/stack (only when actually switching to the new file)
  if (openImmediately && state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (openImmediately && state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  if (openImmediately) state.currentLocalSync = null;
  // Default new files go into the Inbox (active desk's Inbox when desks on)
  const targetParent = parentId || state.getInboxId();
  let fileId;
  if (IS_TAURI) {
    try { const file = await tauriInvoke("create_file"); fileId = file.id; state.files = await tauriInvoke("list_files"); }
    catch (e) { console.error("Create file failed:", e); return; }
  } else { fileId = state._createLocalFile().id; }
  // Imported docs ship with their original basename via `opts.initialName`;
  // brand-new docs fall back to "Untitled" and get uniquified.
  const baseName = (typeof opts.initialName === "string" && opts.initialName.trim()) ? opts.initialName.trim() : "Untitled";
  const initialName = uniqueChildName(findNode(state.fileTree, targetParent), baseName, "document");
  if (initialName !== "Untitled" && IS_TAURI) try { await tauriInvoke("rename_file", { id: fileId, name: initialName }); state.files = await tauriInvoke("list_files"); } catch (_) {}
  const initialContent = (typeof opts.initialContent === "string") ? opts.initialContent : "";
  if (initialContent && IS_TAURI) {
    try { await tauriInvoke("save_file", { id: fileId, content: initialContent }); }
    catch (e) { console.error("Save initial content failed:", e); }
  }
  const treeNode = { id: crypto.randomUUID(), type: "document", name: initialName, fileId, children: [], flagged: false };
  // New files land at the *top* of the Inbox (newest-first); elsewhere
  // they keep the tail position so project/folder ordering is untouched.
  insertNode(state.fileTree, treeNode, targetParent, findNode, targetParent === state.getInboxId());
  await state.saveFileTree();
  // Report through the external-store creation hook (no-op today; the
  // desk-folder write-through re-attaches here). Brand-new empty
  // Untitled docs are skipped — the first non-empty save reports via
  // syncFileToExternal instead.
  if (!isEmptyUntitled(initialName, initialContent)) {
    state.syncCreateFile(treeNode.id, fileId, initialContent);
  }
  if (openImmediately) {
    // Park the outgoing doc's undo history before pointing the editor
    // at the new file (which starts with a fresh, empty history).
    stashActiveEditorState(state);
    state.currentFileId = fileId;
    state.currentProjectId = null;
    state.projectDocIds = [];
    if (state.editor) {
      state.editor.loadDocState(`doc:${fileId}`, initialContent);
      state.editor.focus();
    }
  }
  state.emit("files-changed");
  if (openImmediately) {
    state.emit("file-opened");
    // Record into the active desk so a desk switch round-trips back
    // to this brand-new doc (matches the openFile path).
    state.recordActiveDeskLastFile(fileId, "document");
  }
  return { fileId, name: treeNode.name };
}

export async function openFile(state, id) {
  if (state.ratchetMode) return;
  // Guard: if the fileId belongs to a non-document type, redirect to
  // the correct opener so stack/notebook/PDF JSON never shows as text.
  const { findNodeByFileId } = await import("./tree-helpers.js");
  const node = findNodeByFileId(state.fileTree, id);
  if (node) {
    if (node.type === "stack") return openStack(state, id);
    if (node.type === "notebook") return openNotebook(state, id);
    if (node.type === "pdf") return openPdf(state, id);
  }
  if (state.dirty) await state.saveCurrentFile();
  // Park the outgoing doc's EditorState (undo history, selection, folds)
  // so revisiting it restores its own history — and the incoming doc
  // starts from its stashed state or a fresh one, never inheriting the
  // outgoing doc's undo entries.
  stashActiveEditorState(state);
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentLocalSync = null;
  if (IS_TAURI) {
    try { const file = await tauriInvoke("load_file", { id }); state.currentFileId = file.id; if (state.editor) state.editor.loadDocState(`doc:${file.id}`, file.content); }
    catch (e) { console.error("Load file failed:", e); }
  } else {
    const file = state.files.find((f) => f.id === id);
    if (file) { state.currentFileId = file.id; if (state.editor) state.editor.loadDocState(`doc:${file.id}`, file.content); }
  }
  // Restore the saved per-doc scroll. setContent above resets scrollTop
  // to 0, so we re-apply after CodeMirror has laid out the new buffer.
  const savedScroll = state.settings.docScrollPositions?.[state.currentFileId];
  if (typeof savedScroll === "number" && savedScroll > 0 && state.editor) {
    requestAnimationFrame(() => {
      try { state.editor.view.scrollDOM.scrollTop = savedScroll; } catch (_) {}
    });
  }
  state.emit("file-opened");
  // Clear the notebook + project pointers so the "restore last file"
  // branch on next launch picks the doc, not whichever notebook the
  // user happened to have open before they switched away. (init reads
  // lastNotebookId first; without this clear, a stale id wins.)
  state.updateSettings({ lastFileId: state.currentFileId, lastProjectId: null, lastNotebookId: null, lastPdfId: null, lastStackId: null });
  // Per-desk last-file: switching back to this desk later should land
  // here, not on the desk's first inbox item. Synced via desks.json.
  state.recordActiveDeskLastFile(state.currentFileId, "document");
}

/** Walk the loaded files + tree and drop any empty Untitled docs that
 *  survived a previous session. Called once during init() after the tree
 *  has been hydrated so the next "restore last file" branch never lands
 *  on a placeholder doc the user never used. */
export async function pruneEmptyUntitled(state) {
  if (!Array.isArray(state.files) || state.files.length === 0) return;
  const targets = [];
  for (const file of state.files) {
    if (!isEmptyUntitled(file?.name, file?.content)) continue;
    const node = findNodeByFileId(state.fileTree, file.id);
    targets.push({ fileId: file.id, nodeId: node?.id || null });
  }
  if (!targets.length) return;
  for (const { fileId, nodeId } of targets) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fileId }); }
      catch (e) { console.warn("prune empty Untitled failed:", e); }
    }
    if (nodeId) removeNode(state.fileTree, nodeId);
  }
  if (IS_TAURI) {
    try { state.files = await tauriInvoke("list_files"); }
    catch (_) {}
  } else {
    state.files = state.files.filter((f) => !targets.some((t) => t.fileId === f.id));
    state._saveFilesLocal();
  }
  try { await state.saveFileTree(); } catch (_) {}
}

export async function deleteFile(state, id) {
  if (IS_TAURI) {
    try { await tauriInvoke("delete_file", { id }); state.files = await tauriInvoke("list_files"); }
    catch (e) { console.error("Delete failed:", e); }
  } else { state.files = state.files.filter((f) => f.id !== id); state._saveFilesLocal(); }
  if (state.currentFileId === id) {
    // Don't jump to an arbitrary file in the DB (often in another desk) —
    // drop to the "no file selected" pane instead. The deleted doc's
    // editor state must not be stashed for a revisit.
    await clearActiveFile(state, { stash: false });
  }
  state.emit("files-changed");
}

/** Tear down whatever surface is currently active and drop the editor
 *  into the "no file selected" empty state. Used when the open file is
 *  deleted, when a desk has nothing to restore, or when there are no
 *  files at all. Clears the persisted last-file slots so a restart lands
 *  on the empty pane too rather than resurrecting a deleted file. Safe
 *  to call during init() (before the editor exists): it just leaves the
 *  current* pointers null and emits the event the mode-switcher consumes
 *  once it's wired. */
export async function clearActiveFile(state, opts = {}) {
  // `stash: false` is the deleted-file path — the doc is gone, so its
  // editor state (undo history) must not be parked for a revisit.
  if (opts.stash !== false) stashActiveEditorState(state);
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentLocalSync = null;
  state.dirty = false;
  if (state.editor) state.editor.loadDocState(null, "");
  await state.updateSettings({
    lastFileId: null, lastProjectId: null, lastNotebookId: null,
    lastPdfId: null, lastStackId: null, lastLocalSync: null,
  });
  // Clear the active desk's saved last-file slot so switching away and
  // back doesn't try to reopen the file we just left.
  state.recordActiveDeskLastFile(null, null);
  state.emit("no-file-state");
}

export async function renameFile(state, id, newName) {
  if (IS_TAURI) {
    try { await tauriInvoke("rename_file", { id, name: newName }); state.files = await tauriInvoke("list_files"); }
    catch (e) { console.error("Rename failed:", e); }
  } else {
    const file = state.files.find((f) => f.id === id);
    if (file) { file.name = newName; state._saveFilesLocal(); }
  }
  state.emit("files-changed");
}

export async function duplicateFile(state, id) {
  if (IS_TAURI) {
    try {
      const source = await tauriInvoke("load_file", { id });
      const newFile = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: newFile.id, content: source.content });
      state.files = await tauriInvoke("list_files");
      state.emit("files-changed");
      return newFile.id;
    } catch (e) { console.error("Duplicate failed:", e); }
  } else {
    const source = state.files.find((f) => f.id === id);
    if (source) {
      const newId = crypto.randomUUID();
      state.files.unshift({ id: newId, name: source.name + " copy", content: source.content, modified: Math.floor(Date.now() / 1000) });
      state._saveFilesLocal();
      state.emit("files-changed");
      return newId;
    }
  }
}

/** Move a freshly-created Inbox child to the top of the Inbox so new
 *  files read newest-first. Notebooks and stacks are inserted tree-side
 *  by the Rust `create_*` commands (which append), so after the JS tree
 *  is re-read we hoist the new node and persist. No-op when the node
 *  isn't a direct Inbox child or is already first. */
async function hoistInboxChildToTop(state, fileId) {
  const inbox = findNode(state.fileTree, state.getInboxId());
  if (!inbox || !Array.isArray(inbox.children)) return;
  const idx = inbox.children.findIndex((c) => c.fileId === fileId);
  if (idx <= 0) return;
  const [node] = inbox.children.splice(idx, 1);
  inbox.children.unshift(node);
  await state.saveFileTree();
}

export async function createNotebook(state, name, parentId = null, opts = {}) {
  const openImmediately = opts.openImmediately !== false;
  if (openImmediately && state.dirty) await state.saveCurrentFile();
  const targetParent = parentId || state.getInboxId();
  const finalName = uniqueChildName(findNode(state.fileTree, targetParent), name, "notebook");
  if (IS_TAURI) {
    try {
      const result = await tauriInvoke("create_notebook", { name: finalName, parentId: targetParent });
      // Imported notebooks pass `initialContent` (the unpacked .hushnote
      // JSON envelope). Overwrite the empty default before syncing so
      // the imported shapes are what propagate.
      let initialContent = result.file.content || "[]";
      if (typeof opts.initialContent === "string" && opts.initialContent.length > 0) {
        initialContent = opts.initialContent;
        try { await tauriInvoke("save_file", { id: result.file.id, content: initialContent }); }
        catch (e) { console.error("Save imported notebook content failed:", e); }
      }
      state.files = await tauriInvoke("list_files");
      state.fileTree = await tauriInvoke("get_file_tree");
      // New notebooks land at the top of the Inbox (newest-first).
      if (targetParent === state.getInboxId()) await hoistInboxChildToTop(state, result.file.id);
      state.emit("files-changed");
      // Report through the external-store creation hook (no-op today;
      // the desk-folder write-through re-attaches here).
      const nbNode = findNodeByFileId(state.fileTree, result.file.id);
      if (nbNode) state.syncCreateFile(nbNode.id, result.file.id, initialContent);
      if (openImmediately) await state.openNotebook(result.file.id);
      // openNotebook records via recordActiveDeskLastFile; nothing to
      // do here when openImmediately is false (the notebook isn't the
      // user's "current" file in that case).
      return { fileId: result.file.id, name: result.node?.name || finalName };
    } catch (e) { console.error("Create notebook failed:", e); }
  }
}

export async function openPdf(state, fileId) {
  if (state.ratchetMode) return;
  try {
    const mod = await import("../sync/pdf-sync.js");
    const exists = await mod.checkPdfExists(fileId);
    if (!exists) return;
    // Stamp "last opened" for the shelf's open-date sort.
    mod.touchPdfOpened(fileId);
  } catch {}

  if (state.dirty) await state.saveCurrentFile();
  // The PDF surface hides the editor without touching its buffer — park
  // the outgoing doc's state under its key so its undo history is
  // restored when the user comes back to it.
  stashActiveEditorState(state);
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }

  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentNotebookFileId = null;
  state.currentPdfFileId = fileId;
  state.currentStackFileId = null;
  state.currentLocalSync = null;

  state.emit("pdf-open", fileId);
  state.updateSettings({ lastFileId: null, lastProjectId: null, lastNotebookId: null, lastPdfId: fileId, lastStackId: null });
  state.recordActiveDeskLastFile(fileId, "pdf");
}

export async function importPdf(state, name, bytes, parentId = null, opts = {}) {
  const openImmediately = opts.openImmediately !== false;
  if (openImmediately && state.dirty) await state.saveCurrentFile();

  const fileId = crypto.randomUUID();
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_pdf", { fileId, bytes: Array.from(bytes) });
    } catch (e) { console.error("Save PDF failed:", e); return; }
  }

  // Standard for every import: render the first-page cover for the PDF
  // Shelf. Fire-and-forget — a failed cover never blocks the save (the
  // shelf backfills missing covers lazily).
  import("../pdf/pdf-covers.js")
    .then(({ ensurePdfCover }) => ensurePdfCover(fileId, { bytes }))
    .then(() => state.emit("pdf-cover-ready", fileId))
    .catch(() => {});

  const { addPdfEntry } = await import("../sync/pdf-sync.js");
  await addPdfEntry(fileId, {
    title: opts.zoteroTitle || name,
    authors: opts.zoteroAuthors || "",
    firstAuthor: opts.zoteroFirstAuthor || "",
    year: opts.zoteroYear || "",
    citekey: opts.zoteroCitekey || "",
    zoteroItemKey: opts.zoteroItemKey || "",
    zoteroAttKey: opts.zoteroAttKey || "",
  });

  await state.ensurePdfsFolder();
  const pdfsId = state.getPdfsId();
  const displayName = opts.zoteroTitle || name;
  const finalName = uniqueChildName(findNode(state.fileTree, pdfsId), displayName, "pdf");
  const treeNode = {
    id: crypto.randomUUID(), type: "pdf", name: finalName, fileId,
    children: [], flagged: false,
  };
  if (opts.zoteroAttKey) treeNode.zoteroAttKey = opts.zoteroAttKey;
  insertNode(state.fileTree, treeNode, pdfsId, findNode);
  await state.saveFileTree();
  // Pre-warm the Zotero annotation cache so annotations appear on the
  // first viewer mount instead of requiring a manual "Update
  // Annotations" pass. The fetch is awaited before openPdf so the
  // viewer's own lazy lookup hits a populated cache; failures are
  // swallowed so a flaky annotation call never blocks the save.
  if (opts.zoteroAttKey) {
    const userId = state.settings?.zoteroUserId;
    const apiKey = state.settings?.zoteroApiKey;
    if (userId && apiKey) {
      try {
        const { getAnnotations } = await import("../zotero-annotations.js");
        await getAnnotations(opts.zoteroAttKey, userId, apiKey);
        // The cover rendered at save time predates both the registry
        // entry and this prefetch — re-bake it with the page-1 marks.
        const { refreshPdfCoverIfStale } = await import("../pdf/pdf-covers.js");
        const res = await refreshPdfCoverIfStale(fileId);
        if (res.changed) state.emit("pdf-cover-ready", fileId);
      } catch (e) {
        console.error("Annotation prefetch failed:", e);
      }
    }
  }
  if (openImmediately) {
    await openPdf(state, fileId);
  }
  state.emit("files-changed");
  return { fileId, name: finalName };
}

export async function registerPdfPlaceholder(state, name, opts = {}) {
  const fileId = crypto.randomUUID();
  const { addPdfEntry } = await import("../sync/pdf-sync.js");
  await addPdfEntry(fileId, {
    title: opts.zoteroTitle || name,
    authors: opts.zoteroAuthors || "",
    firstAuthor: opts.zoteroFirstAuthor || "",
    year: opts.zoteroYear || "",
    citekey: opts.zoteroCitekey || "",
    zoteroItemKey: opts.zoteroItemKey || "",
    zoteroAttKey: opts.zoteroAttKey || "",
  });
  await state.ensurePdfsFolder();
  const pdfsId = state.getPdfsId();
  const displayName = opts.zoteroTitle || name;
  const finalName = uniqueChildName(findNode(state.fileTree, pdfsId), displayName, "pdf");
  const treeNode = {
    id: crypto.randomUUID(), type: "pdf", name: finalName, fileId,
    children: [], flagged: false,
  };
  if (opts.zoteroAttKey) treeNode.zoteroAttKey = opts.zoteroAttKey;
  insertNode(state.fileTree, treeNode, pdfsId, findNode);
  await state.saveFileTree();
  state.emit("files-changed");
  return { fileId, name: finalName };
}

export async function openNotebook(state, fileId) {
  if (state.ratchetMode) return;
  if (state.dirty) await state.saveCurrentFile();
  // Park the outgoing doc's editor state (see openPdf).
  stashActiveEditorState(state);
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }

  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentNotebookFileId = fileId;
  state.currentLocalSync = null;

  state.emit("notebook-open", fileId);
  state.updateSettings({ lastFileId: null, lastProjectId: null, lastNotebookId: fileId, lastPdfId: null, lastStackId: null });
  state.recordActiveDeskLastFile(fileId, "notebook");
}

export async function openStack(state, fileId) {
  if (state.ratchetMode) return;
  if (state.dirty) await state.saveCurrentFile();
  // Park the outgoing doc's editor state (see openPdf).
  stashActiveEditorState(state);
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
  }

  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentNotebookFileId = null;
  state.currentPdfFileId = null;
  state.currentStackFileId = fileId;
  state.currentLocalSync = null;

  state.emit("stack-open", fileId);
  state.updateSettings({ lastFileId: null, lastProjectId: null, lastNotebookId: null, lastPdfId: null, lastStackId: fileId });
  state.recordActiveDeskLastFile(fileId, "stack");
}

export async function createStack(state, name, parentId = null, opts = {}) {
  const openImmediately = opts.openImmediately !== false;
  if (openImmediately && state.dirty) await state.saveCurrentFile();
  const targetParent = parentId || state.getInboxId();
  const finalName = uniqueChildName(findNode(state.fileTree, targetParent), name, "stack");
  if (IS_TAURI) {
    try {
      const result = await tauriInvoke("create_stack", { name: finalName, parentId: targetParent });
      let initialContent = result.file.content;
      if (typeof opts.initialContent === "string" && opts.initialContent.length > 0) {
        initialContent = opts.initialContent;
        try { await tauriInvoke("save_file", { id: result.file.id, content: initialContent }); }
        catch (e) { console.error("Save imported stack content failed:", e); }
      }
      state.files = await tauriInvoke("list_files");
      state.fileTree = await tauriInvoke("get_file_tree");
      // New stacks land at the top of the Inbox (newest-first).
      if (targetParent === state.getInboxId()) await hoistInboxChildToTop(state, result.file.id);
      state.emit("files-changed");
      const stNode = findNodeByFileId(state.fileTree, result.file.id);
      if (stNode) state.syncCreateFile(stNode.id, result.file.id, initialContent);
      if (openImmediately) await openStack(state, result.file.id);
      return { fileId: result.file.id, name: result.node?.name || finalName };
    } catch (e) { console.error("Create stack failed:", e); }
  }
}
