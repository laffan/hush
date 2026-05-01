/**
 * Central application state management
 */

import { findNode, removeNode, collectDocumentIds, findNodeByFileId, insertAfter, insertNode } from "./tree-helpers.js";
import { openProject as _openProject, saveProjectContent as _saveProjectContent } from "./state-project.js";
import { createDefaultSettings } from "./state-defaults.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const _STYLE_SYNCED_KEYS = new Set(["styles", "activeStyleId", "globalStyleId"]);
function _isStyleRelevant(partial) {
  if (!partial) return false;
  for (const k of Object.keys(partial)) if (_STYLE_SYNCED_KEYS.has(k)) return true;
  return false;
}

export class AppState {
  constructor() {
    this.settings = createDefaultSettings();

    this.currentFileId = null;
    this.currentProjectId = null; // When viewing a project
    this.currentNotebookFileId = null; // When viewing a notebook
    this.currentLocalSync = null; // When viewing a Local Sync file
    this.files = [];
    this.fileTree = []; // Tree of TreeNode objects
    this.editor = null;

    // Project view state
    this.projectDocIds = []; // Ordered doc fileIds when viewing a project

    // Mode states
    this.ratchetMode = false;
    this.ratchetEndTime = null;
    this.privateMode = false;
    this.typewriterMode = false;
    this.typewriterPosition = 0.6;
    this.dryMode = false;
    this.focusMode = false;
    this.zenFocus = false;
    this.isFullscreen = false;

    // Autosave interval
    this.autosaveInterval = null;
    this.dirty = false;

    // Snapshot keystroke tracking
    this._keystrokeCount = 0;
    this._snapshotPending = false;

    // Listeners
    this._listeners = {};

    /**
     * Cross-module runtime side-channel — values written by one module
     * and read by another that don't belong on `settings` (not persisted)
     * and aren't first-class state (no event emissions). Formalised here
     * to replace the prior `state._foo` convention where any module
     * could quietly stamp a fresh underscore field on AppState.
     *
     *  - `columnResizeHandler` — set by editor/modes.js; called by sidebar,
     *    panel-resizer, right-panel-setup, pane-manager, main.js whenever
     *    sidebar/pane geometry changes so the editor column re-centers.
     *  - `hasVisibleDocPane`   — written by pane-manager when pane visibility
     *    changes; read by editor/modes.js to decide whether to leave the
     *    right gutter free for panes.
     *  - `pendingScrollPosition` — set during init() from the persisted
     *    `scrollPosition` setting; consumed once by main.js after the
     *    editor mounts, then nulled.
     *  - `localSyncWriteFlag`  — short-lived timestamp set when Hush writes
     *    to a Local Sync file; the watcher uses it to suppress its own
     *    echo within ~500ms.
     *  - `syncPulling`         — true while a sync layer (Dropbox poll,
     *    Local Sync watcher, pane sync) is pulling remote content for the
     *    file in `syncPullingFileId`. Blocks both `markDirty` *and*
     *    `saveCurrentFile` for that file so a keystroke or autosave
     *    during the pull window can't upload the editor's pre-pull
     *    buffer over the just-arrived remote content. Held across the
     *    entire pull (download + persist + setContent), not just the
     *    final synchronous edit.
     *  - `syncPullingFileId`   — internal id of the file being pulled,
     *    or null. Other files can still save freely while one file is
     *    being pulled.
     */
    this.runtime = {
      columnResizeHandler: null,
      hasVisibleDocPane: false,
      pendingScrollPosition: null,
      localSyncWriteFlag: 0,
      syncPulling: false,
      syncPullingFileId: null,
    };
  }

  async init() {
    if (IS_TAURI) {
      try {
        Object.assign(this.settings, await tauriInvoke("get_settings"));
        this.files = await tauriInvoke("list_files");
        this.fileTree = await tauriInvoke("get_file_tree");
        this.ensureSpecialNodes();
        await this.saveFileTree();

        // Restore session state from settings
        this.typewriterMode = !!this.settings.typewriterMode;
        this.dryMode = !!this.settings.dryMode;
        this.runtime.pendingScrollPosition = this.settings.scrollPosition || null;

        // Restore last open file/project/notebook
        const lastProjectId = this.settings.lastProjectId;
        const lastFileId = this.settings.lastFileId;
        const lastNotebookId = this.settings.lastNotebookId;
        if (lastNotebookId && this.files.some(f => f.id === lastNotebookId)) {
          // Notebook restore is deferred to main.js via "notebook-open" event
          this.currentNotebookFileId = lastNotebookId;
        } else if (lastProjectId && findNode(this.fileTree, lastProjectId)) {
          await this.openProject(lastProjectId);
        } else if (lastFileId && this.files.some(f => f.id === lastFileId)) {
          await this.openFile(lastFileId);
        } else if (this.files.length > 0) {
          await this.openFile(this.files[0].id);
        } else {
          await this.newFile();
        }
      } catch (e) {
        console.error("Failed to init from Tauri:", e);
        this._initLocal();
      }
    } else {
      this._initLocal();
    }

    // Check for active ratchet timer
    const ratchetEnd = localStorage.getItem("hush_ratchet_end");
    if (ratchetEnd) {
      const endTime = parseInt(ratchetEnd, 10);
      if (Date.now() < endTime) {
        this.ratchetEndTime = endTime;
        this.ratchetMode = true;
      } else {
        localStorage.removeItem("hush_ratchet_end");
      }
    }

    this._startAutosave();
  }

  _initLocal() {
    const savedFiles = localStorage.getItem("hush_files");
    if (savedFiles) this.files = JSON.parse(savedFiles);
    const savedTree = localStorage.getItem("hush_file_tree");
    if (savedTree) this.fileTree = JSON.parse(savedTree);
    else if (this.files.length > 0) {
      this.fileTree = this.files.map(f => ({ id: crypto.randomUUID(), type: "document", name: f.name, fileId: f.id, children: [], flagged: false }));
      this._saveTreeLocal();
    }
    this.ensureSpecialNodes();
    this._saveTreeLocal();
    if (this.files.length > 0) this.currentFileId = this.files[0].id;
    else this._createLocalFile();
    const savedSettings = localStorage.getItem("hush_settings");
    if (savedSettings) Object.assign(this.settings, JSON.parse(savedSettings));
  }

  _createLocalFile() {
    const id = crypto.randomUUID();
    const file = {
      id,
      name: "Untitled",
      content: "",
      modified: Math.floor(Date.now() / 1000),
    };
    this.files.unshift(file);
    this.currentFileId = id;
    this._saveFilesLocal();
    return file;
  }

  _saveFilesLocal() {
    localStorage.setItem("hush_files", JSON.stringify(this.files));
  }

  _saveTreeLocal() {
    localStorage.setItem("hush_file_tree", JSON.stringify(this.fileTree));
  }

  _startAutosave() {
    this.autosaveInterval = setInterval(() => {
      if (this.dirty) {
        this.saveCurrentFile();
      }
      // Notebook autosave is handled via the "notebook-autosave" event
      if (this.currentNotebookFileId) {
        this.emit("notebook-autosave");
      }
    }, 2000);
  }

  setEditor(editor) {
    this.editor = editor;
  }

  markDirty() {
    if (this._isPullLockedForCurrent()) return;
    this.dirty = true;
  }

  _isPullLockedForCurrent() {
    if (!this.runtime.syncPulling) return false;
    const key = this.runtime.syncPullingFileId;
    if (key === this.currentFileId) return true;
    // Local-sync uses a synthetic key since those files don't have a
    // Hush fileId.
    if (this.currentLocalSync) {
      const localKey = `localsync:${this.currentLocalSync.folderId}:${this.currentLocalSync.relPath}`;
      if (key === localKey) return true;
    }
    return false;
  }

  /// Acquire a pull lock for `fileId`. Held by the caller across the full
  /// async pull (download → persist → setContent) so saves and dirty-marks
  /// for this file can't race the in-flight remote write.
  acquirePullLock(fileId) {
    this.runtime.syncPulling = true;
    this.runtime.syncPullingFileId = fileId;
  }

  releasePullLock() {
    this.runtime.syncPulling = false;
    this.runtime.syncPullingFileId = null;
  }

  trackKeystroke() {
    this._keystrokeCount++;
    if (this._keystrokeCount >= 30 && this.dirty) {
      this._keystrokeCount = 0;
      this._createSnapshot();
    }
  }

  async _createSnapshot() {
    const docId = this.currentProjectId ? null : this.currentFileId;
    if (!docId || !this.editor || this._snapshotPending) return;
    this._snapshotPending = true;
    try {
      if (IS_TAURI) await tauriInvoke("create_snapshot", { documentId: docId, content: this.editor.getContent() });
    } catch (e) { console.error("Snapshot failed:", e); }
    finally { this._snapshotPending = false; }
  }

  async createManualSnapshot() {
    const docId = this.currentProjectId ? null : this.currentFileId;
    if (!docId || !this.editor) return;
    if (IS_TAURI) {
      try { await tauriInvoke("create_snapshot", { documentId: docId, content: this.editor.getContent() }); }
      catch (e) { console.error("Manual snapshot failed:", e); }
    }
  }

  // ===== Special Nodes =====

  static INBOX_ID = "__inbox__";
  static IMAGES_ID = "__images__";
  static TRASH_ID = "__trash__";

  ensureSpecialNodes() {
    const t = this.fileTree;
    if (!t.some(n => n.id === AppState.INBOX_ID)) t.unshift({ id: AppState.INBOX_ID, type: "project", name: "Inbox", children: [], flagged: false });
    if (!t.some(n => n.id === AppState.IMAGES_ID)) t.push({ id: AppState.IMAGES_ID, type: "folder", name: "Images", children: [], flagged: false });
    if (!t.some(n => n.id === AppState.TRASH_ID)) t.push({ id: AppState.TRASH_ID, type: "folder", name: "Trash", children: [], flagged: false });
    // Enforce ordering: Inbox first, Images then Trash pinned to the tail.
    const moveTo = (id, idx) => { const i = t.findIndex(n => n.id === id); if (i >= 0 && i !== idx) { const [n] = t.splice(i, 1); t.splice(idx, 0, n); } };
    moveTo(AppState.INBOX_ID, 0);
    moveTo(AppState.TRASH_ID, t.length - 1);
    moveTo(AppState.IMAGES_ID, t.length - 2);
  }

  isInTrash(nodeId) {
    const trash = findNode(this.fileTree, AppState.TRASH_ID);
    if (!trash || !trash.children) return false;
    return !!findNode(trash.children, nodeId);
  }

  // ===== File Tree Operations =====

  async saveFileTree() {
    if (IS_TAURI) {
      try { await tauriInvoke("save_file_tree", { tree: this.fileTree }); }
      catch (e) { console.error("Save tree failed:", e); }
    } else { this._saveTreeLocal(); }
    this.emit("files-changed");
  }

  // ===== Tree Operations (delegated to state-tree.js) =====
  async createFolder(name, parentId = null) {
    const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_folder", "folder", name, parentId);
  }
  async createProject(name, parentId = null) {
    const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_project", "project", name, parentId);
  }
  async deleteTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.deleteTreeNode(this, nodeId); }
  async emptyTrash() { const m = await import("./state-tree.js"); return m.emptyTrash(this); }
  async renameTreeNode(nodeId, newName) { const m = await import("./state-tree.js"); return m.renameTreeNode(this, nodeId, newName); }
  async toggleFlagged(nodeId) { const m = await import("./state-tree.js"); return m.toggleFlagged(this, nodeId); }
  async duplicateTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.duplicateTreeNode(this, nodeId); }

  async createImageFromFile(file) { const m = await import("./state-images.js"); return m.createImageFromFile(this, file); }
  async createImageFromDataUrl(dataUrl, name) { const m = await import("./state-images.js"); return m.createImageFromDataUrl(this, dataUrl, name); }
  async loadImageDataUrl(fileId) { const m = await import("./state-images.js"); return m.getImageDataUrl(fileId); }

  // ===== Project View (delegated to state-project.js) =====

  async openProject(projectId) {
    if (this.ratchetMode) return;
    return _openProject(this, projectId);
  }
  async saveProjectContent() { return _saveProjectContent(this); }

  // ===== Notebook Operations =====

  /** Create a new notebook.
   *  @param {string} name           Display name for the new notebook.
   *  @param {string|null} parentId  Tree node to insert under (defaults to Inbox).
   *  @param {object} [opts]
   *  @param {boolean} [opts.openImmediately=true]  When false, the notebook
   *    is created + tree-added + synced but isn't opened in the main view
   *    (used by the "New Notebook as Pane" command palette entry).
   *  @returns {Promise<{ fileId: string, name: string } | undefined>}
   */
  async createNotebook(name, parentId = null, opts = {}) {
    const openImmediately = opts.openImmediately !== false;
    if (openImmediately && this.dirty) await this.saveCurrentFile();
    const targetParent = parentId || AppState.INBOX_ID;
    if (IS_TAURI) {
      try {
        const result = await tauriInvoke("create_notebook", { name, parentId: targetParent });
        this.files = await tauriInvoke("list_files");
        this.fileTree = await tauriInvoke("get_file_tree");
        this.emit("files-changed");
        // Propagate new notebook to Dropbox sync
        const nbNode = findNodeByFileId(this.fileTree, result.file.id);
        if (nbNode) this.syncCreateFile(nbNode.id, result.file.id, result.file.content || "[]");
        if (openImmediately) await this.openNotebook(result.file.id);
        return { fileId: result.file.id, name: result.node?.name || name };
      } catch (e) { console.error("Create notebook failed:", e); }
    }
  }

  async openNotebook(fileId) {
    if (this.ratchetMode) return;
    // Save current file/notebook before switching
    if (this.dirty) await this.saveCurrentFile();
    if (this.currentNotebookFileId) {
      // Unmount the current notebook (save handled by notebook-bridge)
      this.emit("notebook-unmount");
    }

    this.currentFileId = null;
    this.currentProjectId = null;
    this.projectDocIds = [];
    this.currentNotebookFileId = fileId;
    this.currentLocalSync = null;

    this.emit("notebook-open", fileId);
    this.updateSettings({ lastFileId: null, lastProjectId: null, lastNotebookId: fileId });
  }

  // ===== File Operations =====

  async saveCurrentFile() {
    if (this.currentProjectId) return this.saveProjectContent();
    if (this.currentLocalSync) {
      const m = await import("../sync/local-sync.js");
      return m.saveCurrentLocalSync(this);
    }
    if (!this.currentFileId || !this.editor) return;
    // A pull is in flight for the current file: don't upload the editor's
    // pre-pull buffer over the just-arriving remote content. The pull
    // releases the lock and clears `dirty`, so we'll resume normally.
    if (this._isPullLockedForCurrent()) return;
    const content = this.editor.getContent();
    this.dirty = false;
    if (IS_TAURI) {
      try {
        await tauriInvoke("save_file", { id: this.currentFileId, content });
        this.files = await tauriInvoke("list_files");
        this.syncFileToExternal(this.currentFileId, content);
      } catch (e) { console.error("Save failed:", e); }
    } else {
      const file = this.files.find((f) => f.id === this.currentFileId);
      if (file) {
        file.content = content;
        file.modified = Math.floor(Date.now() / 1000);
        // Seed name from first line on the very first save. Subsequent
        // renames go through maybeRenameFromFirstLine() which fires at
        // stable moments (cursor off line 1, editor blur).
        if (!file.name || file.name === "Untitled") file.name = this._deriveName(content);
        this._saveFilesLocal();
      }
    }
    if (this._updateTreeNodeNameByFileId(this.currentFileId)) {
      this.emit("files-changed");
    }
    // Autosave-path rename: update the filename to track the first line,
    // but only when the cursor has moved off it. While the user is still
    // typing in the title, we deliberately skip — preserves the old
    // behavior's "name follows first line" feel without the per-keystroke
    // sync churn that made Dropbox see phantom new files.
    if (!this._cursorOnFirstLine()) {
      await this.maybeRenameFromFirstLine();
    }
  }

  /**
   * If the content's derived first-line name differs from the current
   * tree node's name, rename the file + tree node. Routes through the
   * regular renameTreeNode path so Dropbox sync sees a rename (stable
   * internal id → new path), not a delete+create.
   *
   * Called on three triggers — see editor.js:
   *   1. cursor leaves line 1
   *   2. editor blur
   *   3. autosave when cursor is not on line 1
   */
  async maybeRenameFromFirstLine() {
    if (this.currentProjectId || this.currentNotebookFileId || this.currentLocalSync) return;
    if (!this.currentFileId || !this.editor) return;
    const content = this.editor.getContent();
    const derived = this._deriveName(content);
    if (!derived || derived === "Untitled") return;
    const node = findNodeByFileId(this.fileTree, this.currentFileId);
    if (!node || node.name === derived) return;
    const { renameTreeNode } = await import("./state-tree.js");
    await renameTreeNode(this, node.id, derived);
    this.emit("files-changed");
  }

  /** True when the main editor's primary cursor sits on line 1. Used to
   *  gate the autosave rename path. */
  _cursorOnFirstLine() {
    if (!this.editor) return false;
    const view = this.editor.view;
    if (!view) return false;
    try {
      const head = view.state.selection.main.head;
      return view.state.doc.lineAt(head).number === 1;
    } catch { return false; }
  }

  _updateTreeNodeNameByFileId(fileId) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return false;
    const node = findNodeByFileId(this.fileTree, fileId);
    if (node && node.name !== file.name) {
      const oldName = node.name;
      node.name = file.name;
      // Propagate rename to Dropbox sync
      this.syncRenameNode(node.id, oldName, node.type);
      return true;
    }
    return false;
  }

  /** Create a new document.
   *  @param {string|null} parentId  Tree node to insert under (defaults to Inbox).
   *  @param {object} [opts]
   *  @param {boolean} [opts.openImmediately=true]  When false, the new file
   *    is created + tree-added + synced but the main editor doesn't switch
   *    to it (used by the "New Doc as Pane" command palette entry).
   *  @returns {Promise<{ fileId: string, name: string } | undefined>}
   */
  async newFile(parentId = null, opts = {}) {
    const openImmediately = opts.openImmediately !== false;
    if (openImmediately && this.dirty) await this.saveCurrentFile();
    // Unmount any active notebook (only when actually switching to the new file)
    if (openImmediately && this.currentNotebookFileId) {
      this.emit("notebook-unmount");
      this.currentNotebookFileId = null;
    }
    if (openImmediately) this.currentLocalSync = null;
    // Default new files go into the Inbox
    const targetParent = parentId || AppState.INBOX_ID;
    let fileId;
    if (IS_TAURI) {
      try { const file = await tauriInvoke("create_file"); fileId = file.id; this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Create file failed:", e); return; }
    } else { fileId = this._createLocalFile().id; }
    const treeNode = { id: crypto.randomUUID(), type: "document", name: "Untitled", fileId, children: [], flagged: false };
    insertNode(this.fileTree, treeNode, targetParent, findNode);
    await this.saveFileTree();
    // Propagate new file to external filesystem if inside a synced folder
    this.syncCreateFile(treeNode.id, fileId, "");
    if (openImmediately) {
      this.currentFileId = fileId;
      this.currentProjectId = null;
      this.projectDocIds = [];
      if (this.editor) {
        this.editor.setContent("");
        this.editor.focus();
      }
    }
    this.emit("files-changed");
    if (openImmediately) this.emit("file-opened");
    return { fileId, name: treeNode.name };
  }

  async openFile(id) {
    // Ratchet mode pins the user to the active file — opening another
    // would let them step around the forward-only lock.
    if (this.ratchetMode) return;
    if (this.dirty) await this.saveCurrentFile();
    // Unmount any active notebook
    if (this.currentNotebookFileId) {
      this.emit("notebook-unmount");
      this.currentNotebookFileId = null;
    }
    this.currentProjectId = null;
    this.projectDocIds = [];
    this.currentLocalSync = null;
    if (IS_TAURI) {
      try { const file = await tauriInvoke("load_file", { id }); this.currentFileId = file.id; if (this.editor) this.editor.setContent(file.content); }
      catch (e) { console.error("Load file failed:", e); }
    } else {
      const file = this.files.find((f) => f.id === id);
      if (file) { this.currentFileId = file.id; if (this.editor) this.editor.setContent(file.content); }
    }
    this.emit("file-opened");
    this.updateSettings({ lastFileId: this.currentFileId, lastProjectId: null });
  }

  async deleteFile(id) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id }); this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Delete failed:", e); }
    } else { this.files = this.files.filter((f) => f.id !== id); this._saveFilesLocal(); }
    if (this.currentFileId === id) {
      if (this.files.length > 0) await this.openFile(this.files[0].id);
      else await this.newFile();
    }
    this.emit("files-changed");
  }

  async renameFile(id, newName) {
    if (IS_TAURI) {
      try { await tauriInvoke("rename_file", { id, name: newName }); this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Rename failed:", e); }
    } else {
      const file = this.files.find((f) => f.id === id);
      if (file) { file.name = newName; this._saveFilesLocal(); }
    }
    this.emit("files-changed");
  }

  async duplicateFile(id) {
    if (IS_TAURI) {
      try {
        const source = await tauriInvoke("load_file", { id });
        const newFile = await tauriInvoke("create_file");
        await tauriInvoke("save_file", { id: newFile.id, content: source.content });
        this.files = await tauriInvoke("list_files");
        this.emit("files-changed");
        return newFile.id;
      } catch (e) { console.error("Duplicate failed:", e); }
    } else {
      const source = this.files.find((f) => f.id === id);
      if (source) {
        const newId = crypto.randomUUID();
        this.files.unshift({ id: newId, name: source.name + " copy", content: source.content, modified: Math.floor(Date.now() / 1000) });
        this._saveFilesLocal();
        this.emit("files-changed");
        return newId;
      }
    }
  }

  // ===== Desk + Sync Operations (delegated to sibling modules) =====
  async setDesk(fileId) { const m = await import("./state-desk.js"); return m.setDesk(this, fileId); }
  async _syncOp(fn, ...a) { const m = await import("../sync/sync-state.js"); return m[fn](this, ...a); }
  async syncFileToExternal(fid, c) { return this._syncOp("syncFileToExternal", fid, c); }
  async syncRenameNode(nid, old, t) { return this._syncOp("syncRenameNode", nid, old, t); }
  async syncDeleteNode(nid) { return this._syncOp("syncDeleteNode", nid); }
  async syncCreateNode(nid, t) { return this._syncOp("syncCreateNode", nid, t); }
  async syncCreateFile(nid, fid, c) { return this._syncOp("syncCreateFile", nid, fid, c); }
  async syncProjectOrdering(pid) { return this._syncOp("syncProjectOrdering", pid); }
  async reconcileSync() { return this._syncOp("reconcileSync"); }

  async updateSettings(partial, opts = {}) {
    Object.assign(this.settings, partial);
    if (IS_TAURI) {
      try { await tauriInvoke("save_settings", { settings: this.settings }); }
      catch (e) { console.error("Settings save failed:", e); }
    } else { localStorage.setItem("hush_settings", JSON.stringify(this.settings)); }
    this.emit("settings-changed");

    // Push style changes to `.hush/styles.json` when style-relevant fields
    // changed and this update didn't originate from a sync apply (which
    // would loop). Fire-and-forget — the op-log handles retry.
    if (!opts.fromSync && IS_TAURI && this.settings?.dropboxEnabled
        && this.settings?.dropboxSyncPath
        && _isStyleRelevant(partial)) {
      import("../sync/style-sync.js")
        .then(m => m.pushStylesToDropbox(this))
        .catch(e => console.warn("style sync upload failed:", e));
    }
  }

  // Session state persistence
  async saveSessionState() {
    const scrollTop = this.editor
      ? this.editor.view.scrollDOM.scrollTop
      : null;
    await this.updateSettings({
      lastFileId: this.currentFileId || null,
      lastProjectId: this.currentProjectId || null,
      lastNotebookId: this.currentNotebookFileId || null,
      typewriterMode: this.typewriterMode,
      dryMode: this.dryMode,
      scrollPosition: scrollTop,
    });
  }

  // Ratchet mode
  startRatchet(minutes) {
    const endTime = Date.now() + minutes * 60 * 1000;
    this.ratchetEndTime = endTime;
    this.ratchetMode = true;
    localStorage.setItem("hush_ratchet_end", endTime.toString());
    this.emit("mode-changed");
  }

  stopRatchet() {
    this.ratchetMode = false;
    this.ratchetEndTime = null;
    localStorage.removeItem("hush_ratchet_end");
    this.emit("mode-changed");
  }

  togglePrivate() {
    this.privateMode = !this.privateMode;
    this.emit("mode-changed");
  }

  toggleTypewriter() {
    if (this.ratchetMode) return;
    this.typewriterMode = !this.typewriterMode;
    this.emit("mode-changed");
    this.updateSettings({ typewriterMode: this.typewriterMode });
  }

  toggleDry() {
    this.dryMode = !this.dryMode;
    this.emit("mode-changed");
    this.updateSettings({ dryMode: this.dryMode });
  }

  toggleFocus() {
    this.focusMode = !this.focusMode;
    this.emit("mode-changed");
  }

  toggleZenFocus() {
    this.zenFocus = !this.zenFocus;
    this.emit("mode-changed");
    this.emit("zen-focus-changed");
  }

  toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;
    this.emit("fullscreen-changed");
  }

  _deriveName(content) {
    const trimmed = content.trim();
    if (!trimmed) return "Untitled";
    const firstLine = trimmed.split("\n")[0].replace(/^#+\s*/, "").replace(/[<>:"/\\|?*]/g, "").trim();
    return firstLine.length <= 50 ? firstLine : firstLine.slice(0, 50);
  }

  // Event system
  on(event, fn) { (this._listeners[event] ||= []).push(fn); }
  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
  }
  emit(event, data) {
    if (this._listeners[event]) this._listeners[event].forEach((fn) => fn(data));
  }
}
