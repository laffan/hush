/**
 * Central application state management
 */

import { findNode, removeNode, collectDocumentIds, findNodeByFileId, insertAfter, insertNode, uniqueChildName } from "./tree-helpers.js";
import { openProject as _openProject, saveProjectContent as _saveProjectContent } from "./state-project.js";
import { createDefaultSettings } from "./state-defaults.js";
import * as _modes from "./state-modes.js";
import * as _snapshots from "./state-snapshots.js";
import * as _naming from "./state-naming.js";
import * as _desks from "./state-desks.js";

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

// Settings keys that belong to whichever window the user is currently
// looking at, not to the shared app config. Secondary windows skip
// disk-writing these (and the main window's on-disk values are
// re-overlaid on every cross-window save) so opening a file in a child
// window can't clobber the main window's restored session.
const _PER_WINDOW_SETTINGS_KEYS = new Set([
  "lastFileId",
  "lastNotebookId",
  "lastProjectId",
  "scrollPosition",
  "typewriterMode",
  "dryMode",
]);
function _allKeysPerWindow(partial) {
  if (!partial) return false;
  const keys = Object.keys(partial);
  if (keys.length === 0) return false;
  return keys.every((k) => _PER_WINDOW_SETTINGS_KEYS.has(k));
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

    // Multi-window — populated by main.js after registering with the
    // Rust-side WindowRegistry. `windowList` is the full list of open
    // Hush windows (each entry: `{ label, number, fileId, fileType }`)
    // and refreshes whenever any window opens, closes, or switches file.
    // `currentWindowNumber` is this window's slot (1-indexed) — used by
    // the sidebar to pick the right "self" badge style.
    // `isSecondaryWindow` flips on for any non-"main" window so per-
    // window settings (lastFileId, scrollPosition, mode toggles) skip
    // the disk write that would clobber the main window's session.
    this.windowList = [];
    this.currentWindowNumber = 1;
    this.isSecondaryWindow = false;

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
    // Doc-only Proofread mode (harper-core via the `check_grammar`
    // Tauri command). Intentionally NOT persisted between sessions —
    // the first lint after enabling it has to build harper's curated
    // dictionary, which adds a noticeable startup pause. Each session
    // starts off; the user re-enables when they want it.
    this.proofreadMode = false;

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

  async init(opts = {}) {
    // `initialFile` overrides the usual "restore last file" branch — used
    // by secondary windows opened via "Open in new window" so the new
    // window lands on the file the user picked, not whatever the global
    // `lastFileId` happens to be.
    const initialFile = opts.initialFile || null;
    if (IS_TAURI) {
      try {
        Object.assign(this.settings, await tauriInvoke("get_settings"));
        this.files = await tauriInvoke("list_files");
        this.fileTree = await tauriInvoke("get_file_tree");
        await _desks.migrateLegacyTreeIfNeeded(this);
        this.ensureSpecialNodes();
        await this.saveFileTree();

        // Restore session state from settings
        this.typewriterMode = !!this.settings.typewriterMode;
        this.dryMode = !!this.settings.dryMode;
        this.runtime.pendingScrollPosition = this.settings.scrollPosition || null;

        if (initialFile && initialFile.fileId && initialFile.fileType) {
          // New-window startup path — main.js will mount the notebook /
          // project surface based on the seeded fields below; we don't
          // touch persisted lastFileId so the main window's session is
          // unaffected when this window closes.
          if (initialFile.fileType === "notebook"
              && this.files.some(f => f.id === initialFile.fileId)) {
            this.currentNotebookFileId = initialFile.fileId;
          } else if (initialFile.fileType === "project"
              && findNode(this.fileTree, initialFile.fileId)) {
            await this.openProject(initialFile.fileId);
          } else if (this.files.some(f => f.id === initialFile.fileId)) {
            await this.openFile(initialFile.fileId);
          } else if (this.files.length > 0) {
            await this.openFile(this.files[0].id);
          } else {
            await this.newFile();
          }
        } else {
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
    const savedSettings = localStorage.getItem("hush_settings");
    if (savedSettings) Object.assign(this.settings, JSON.parse(savedSettings));
    _desks.migrateLegacyTreeIfNeeded(this).catch(() => {});
    this.ensureSpecialNodes();
    this._saveTreeLocal();
    if (this.files.length > 0) this.currentFileId = this.files[0].id;
    else this._createLocalFile();
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

  trackKeystroke() { _snapshots.trackKeystroke(this); }
  createManualSnapshot() { return _snapshots.createManualSnapshot(this); }

  // ===== Special Nodes =====
  // Bare-id constants. Per-desk namespaced ids `<kind>:<deskId>` are
  // produced by `state-desks.js#specialNodeId`.
  static INBOX_ID = "__inbox__";
  static IMAGES_ID = "__images__";
  static TRASH_ID = "__trash__";

  /** Resolve the special-node id for the active context. With desks
   *  off, returns the legacy id; with desks on, the active desk's
   *  namespaced id. */
  getInboxId() { return _desks.activeSpecialId(this, AppState.INBOX_ID); }
  getImagesId() { return _desks.activeSpecialId(this, AppState.IMAGES_ID); }
  getTrashId() { return _desks.activeSpecialId(this, AppState.TRASH_ID); }
  isSpecialNodeId(id) { return _desks.isSpecialNodeId(id); }

  ensureSpecialNodes() {
    _desks.ensureDesksTreeSpecials(this, this.fileTree);
  }

  /** True if `nodeId` lives inside any Trash folder. */
  isInTrash(nodeId) {
    for (const trashId of _desks.allSpecialOfKind(this, AppState.TRASH_ID)) {
      const trash = findNode(this.fileTree, trashId);
      if (trash && trash.children && findNode(trash.children, nodeId)) return true;
    }
    return false;
  }

  // ===== File Tree Operations =====

  async saveFileTree() {
    if (IS_TAURI) {
      try { await tauriInvoke("save_file_tree", { tree: this.fileTree }); }
      catch (e) { console.error("Save tree failed:", e); }
    } else { this._saveTreeLocal(); }
    this._broadcastCrossWindow("files");
    this.emit("files-changed");
  }

  // ===== Tree Operations (delegated to state-tree.js) =====
  _activeDeskParent(parentId) { return parentId || _desks.getActiveDesk(this)?.id || null; }
  async createFolder(name, parentId = null) { const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_folder", "folder", name, this._activeDeskParent(parentId)); }
  async createProject(name, parentId = null) { const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_project", "project", name, this._activeDeskParent(parentId)); }
  async deleteTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.deleteTreeNode(this, nodeId); }
  async emptyTrash() { const m = await import("./state-tree.js"); return m.emptyTrash(this); }
  async renameTreeNode(nodeId, newName) { const m = await import("./state-tree.js"); return m.renameTreeNode(this, nodeId, newName); }
  async toggleFlagged(nodeId) { const m = await import("./state-tree.js"); return m.toggleFlagged(this, nodeId); }
  async duplicateTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.duplicateTreeNode(this, nodeId); }
  async convertContainerType(nodeId, targetType) { const m = await import("./state-tree.js"); return m.convertContainerType(this, nodeId, targetType); }

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
    const targetParent = parentId || this.getInboxId();
    const finalName = uniqueChildName(findNode(this.fileTree, targetParent), name, "notebook");
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
        this.files = await tauriInvoke("list_files");
        this.fileTree = await tauriInvoke("get_file_tree");
        this.emit("files-changed");
        // Propagate new notebook to Dropbox sync
        const nbNode = findNodeByFileId(this.fileTree, result.file.id);
        if (nbNode) this.syncCreateFile(nbNode.id, result.file.id, initialContent);
        if (openImmediately) await this.openNotebook(result.file.id);
        return { fileId: result.file.id, name: result.node?.name || finalName };
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
        if (!file.name || file.name === "Untitled") file.name = _naming.deriveName(content);
        this._saveFilesLocal();
      }
    }
    if (_naming.updateTreeNodeNameByFileId(this, this.currentFileId)) {
      this.emit("files-changed");
    }
    // Autosave-path rename: update the filename to track the first line,
    // but only when the cursor has moved off it. While the user is still
    // typing in the title, we deliberately skip — preserves the old
    // behavior's "name follows first line" feel without the per-keystroke
    // sync churn that made Dropbox see phantom new files.
    if (!_naming.cursorOnFirstLine(this)) {
      await this.maybeRenameFromFirstLine();
    }
  }

  maybeRenameFromFirstLine() { return _naming.maybeRenameFromFirstLine(this); }
  maybeRenameFileFromContent(fileId, content) { return _naming.maybeRenameFileFromContent(this, fileId, content); }
  _deriveName(content) { return _naming.deriveName(content); }

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
    // Default new files go into the Inbox (active desk's Inbox when desks on)
    const targetParent = parentId || this.getInboxId();
    let fileId;
    if (IS_TAURI) {
      try { const file = await tauriInvoke("create_file"); fileId = file.id; this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Create file failed:", e); return; }
    } else { fileId = this._createLocalFile().id; }
    // Imported docs ship with their original basename via `opts.initialName`;
    // brand-new docs fall back to "Untitled" and get uniquified.
    const baseName = (typeof opts.initialName === "string" && opts.initialName.trim()) ? opts.initialName.trim() : "Untitled";
    const initialName = uniqueChildName(findNode(this.fileTree, targetParent), baseName, "document");
    if (initialName !== "Untitled" && IS_TAURI) try { await tauriInvoke("rename_file", { id: fileId, name: initialName }); this.files = await tauriInvoke("list_files"); } catch (_) {}
    const initialContent = (typeof opts.initialContent === "string") ? opts.initialContent : "";
    if (initialContent && IS_TAURI) {
      try { await tauriInvoke("save_file", { id: fileId, content: initialContent }); }
      catch (e) { console.error("Save initial content failed:", e); }
    }
    const treeNode = { id: crypto.randomUUID(), type: "document", name: initialName, fileId, children: [], flagged: false };
    insertNode(this.fileTree, treeNode, targetParent, findNode);
    await this.saveFileTree();
    // Propagate new file to external filesystem if inside a synced folder
    this.syncCreateFile(treeNode.id, fileId, initialContent);
    if (openImmediately) {
      this.currentFileId = fileId;
      this.currentProjectId = null;
      this.projectDocIds = [];
      if (this.editor) {
        this.editor.setContent(initialContent);
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

  // ===== Desktop + Sync Operations (delegated to sibling modules) =====
  async setDesktop(fileId) { const m = await import("./state-desktop.js"); return m.setDesktop(this, fileId); }
  // Desks (delegated to state-desks.js)
  enableDesks(name) { return _desks.enableDesks(this, name); }
  createDesk(name) { return _desks.createDesk(this, name); }
  renameDesk(id, name) { return _desks.renameDesk(this, id, name); }
  deleteDesk(id) { return _desks.deleteDesk(this, id); }
  setActiveDesk(id) { return _desks.setActiveDesk(this, id); }
  getActiveDesk() { return _desks.getActiveDesk(this); }
  getDeskGlobalStyleId() { return _desks.getDeskGlobalStyleId(this); }
  setDeskGlobalStyleId(id) { return _desks.setDeskGlobalStyleId(this, id); }
  async toggleMinimap() { const n = !this.settings?.minimapVisible; await this.updateSettings({ minimapVisible: n }); this.emit("minimap-visibility-changed", n); }
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
    // Secondary windows: skip disk writes for purely per-window updates,
    // and on shared-key writes overlay the main window's per-window
    // values from disk so we don't clobber its session state.
    if (this.isSecondaryWindow) {
      if (_allKeysPerWindow(partial)) {
        this.emit("settings-changed");
        return;
      }
      if (IS_TAURI) {
        try {
          const fresh = await tauriInvoke("get_settings");
          const toSave = { ...this.settings };
          for (const k of _PER_WINDOW_SETTINGS_KEYS) {
            if (k in fresh) toSave[k] = fresh[k];
          }
          await tauriInvoke("save_settings", { settings: toSave });
        } catch (e) { console.error("Settings save failed:", e); }
      } else {
        localStorage.setItem("hush_settings", JSON.stringify(this.settings));
      }
      this._broadcastCrossWindow("settings");
      this.emit("settings-changed");
      return;
    }
    if (IS_TAURI) {
      try { await tauriInvoke("save_settings", { settings: this.settings }); }
      catch (e) { console.error("Settings save failed:", e); }
    } else { localStorage.setItem("hush_settings", JSON.stringify(this.settings)); }
    this._broadcastCrossWindow("settings");
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

  /** Fire-and-forget broadcast helper — tells sibling windows that
   *  cross-window state mutated. Soft-fails when the multi-window helper
   *  isn't available (browser dev / iOS). */
  _broadcastCrossWindow(kind) {
    if (!IS_TAURI) return;
    import("../multi-window.js")
      .then((m) => m.broadcastStateChange(kind))
      .catch(() => { /* multi-window unavailable */ });
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

  // Mode toggles (delegated to state-modes.js)
  startRatchet(minutes) { _modes.startRatchet(this, minutes); }
  stopRatchet() { _modes.stopRatchet(this); }
  togglePrivate() { _modes.togglePrivate(this); }
  toggleTypewriter() { _modes.toggleTypewriter(this); }
  toggleDry() { _modes.toggleDry(this); }
  toggleProofread() { _modes.toggleProofread(this); }
  toggleFocus() { _modes.toggleFocus(this); }
  toggleZenFocus() { _modes.toggleZenFocus(this); }
  toggleFullscreen() { _modes.toggleFullscreen(this); }

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
