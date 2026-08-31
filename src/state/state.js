/**
 * Central application state management
 */

import { findNode, findNodeByFileId } from "./tree-helpers.js";
import { openProject as _openProject, saveProjectContent as _saveProjectContent, markGutterForDoc as _markGutterForDoc, unmarkGutterForDoc as _unmarkGutterForDoc } from "./state-project.js";
import { createDefaultSettings } from "./state-defaults.js";
import { migrateShortcutDefaults } from "./state-migrations.js";
import * as _modes from "./state-modes.js";
import * as _snapshots from "./state-snapshots.js";
import * as _naming from "./state-naming.js";
import * as _desks from "./state-desks.js";
import * as _files from "./state-files.js";
import { phase, phaseSync } from "../startup-trace.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Settings keys that belong to whichever window the user is currently
// looking at, not to the shared app config. Disk holds the MAIN window's
// session, so secondary windows keep these in memory and never write
// them — otherwise opening a file in a child window would clobber the
// session the main window restores from.
const _PER_WINDOW_SETTINGS_KEYS = new Set([
  "lastFileId",
  "lastNotebookId",
  "lastProjectId",
  "lastStackId",
  "lastLocalSync",
  "scrollPosition",
  "typewriterMode",
  "dryMode",
  // Each window operates its own desk: switching desks in a secondary
  // window must not drag the main window (or any sibling) along with it,
  // and only the main window's choice persists as the app's "last desk".
  "activeDeskId",
  // Sidebar panel state — which panel was open and whether it was pinned
  // when the session ended. Per-window so each window remembers its own
  // chrome layout.
  "sidebarOpenPanel",
  "sidebarPinned",
]);

export class AppState {
  constructor() {
    this.settings = createDefaultSettings();

    this.currentFileId = null;
    this.currentProjectId = null; // When viewing a project
    this.currentNotebookFileId = null; // When viewing a notebook
    this.currentPdfFileId = null; // When viewing a PDF
    this.currentStackFileId = null; // When viewing a stack
    this.currentLocalSync = null; // When viewing a Local Sync file
    this.files = [];
    this.fileTree = []; // Tree of TreeNode objects
    this.editor = null;
    // Files-panel multi-select: when populated, the editor area swaps
    // to a "selected docs" listing view instead of an open doc. Driven
    // by shift/cmd-click and drag-select in the sidebar. Cleared by
    // opening any single doc / notebook / project, by Esc, or by an
    // empty-area click in the sidebar.
    this.selectedDocIds = [];

    // Multi-window — `isSecondaryWindow` flips on for any non-"main"
    // window so per-window settings (lastFileId, scrollPosition, mode
    // toggles) skip the disk write that would clobber the main window's
    // session.
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
    // Selection Focus — a lightweight "show me only this text" overlay,
    // fired by the Focus-mode shortcut when an active editor selection
    // is non-empty. Stays at the editor's font size (unlike Zen) but
    // hides every other piece of chrome (like Zen).
    this.selectionFocus = false;
    // Shuffle Editor — a fullscreen revision mode that breaks the active
    // selection into draggable sentence chips. Transient like Selection
    // Focus (payload staged on `_shuffleEditorPayload`); not persisted yet.
    this.shuffleEditor = false;
    this.isFullscreen = false;
    // Doc-only Proofread mode (harper-core via the `check_grammar`
    // Tauri command). Intentionally NOT persisted between sessions —
    // the first lint after enabling it has to build harper's curated
    // dictionary, which adds a noticeable startup pause. Each session
    // starts off; the user re-enables when they want it.
    this.proofreadMode = false;
    // Doc-only Spellcheck (spellbook crate via `check_spelling`). Fast
    // enough to persist between sessions — seeded from settings in
    // state-defaults.js / loadSettings().
    this.spellcheckMode = false;

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
     *  - `syncPulling`         — true while a sync layer (Local Sync
     *    watcher, multi-window broadcast) is pulling external content for the
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
    // `lastFileId` happens to be. `initialDesk` seeds this window's
    // active desk the same way (desks are per-window; the hash carries
    // the opener's desk so the new window starts where the user was).
    const initialFile = opts.initialFile || null;
    const initialDesk = opts.initialDesk || null;
    if (IS_TAURI) {
      try {
        Object.assign(this.settings, await phase("get_settings", () => tauriInvoke("get_settings")));
        // In-memory only: activeDeskId is a per-window key, so a
        // secondary window never writes it back to disk.
        if (initialDesk) this.settings.activeDeskId = initialDesk;
        const migrated = migrateShortcutDefaults(this.settings);
        if (Object.keys(migrated).length) {
          try { await tauriInvoke("patch_settings", { patch: migrated }); } catch (_) {}
        }
        this.files = await phase("list_files — index every desk, read the documents", () => tauriInvoke("list_files"));
        this.fileTree = await phase("get_file_tree", () => tauriInvoke("get_file_tree"));
        await phase("migrate legacy tree", () => _desks.migrateLegacyTreeIfNeeded(this));
        const specialsChanged = phaseSync("ensure special nodes", () => this.ensureSpecialNodes());
        // Boot-time PDF layout cleanup (strays + orphaned aliases) —
        // guarded inside the helper against a short tree read.
        let pdfLayoutChanged = false;
        try {
          const { normalizePdfLayoutAtBoot } = await import("./state-pdf-aliases.js");
          pdfLayoutChanged = phaseSync("normalize PDF layout", () => normalizePdfLayoutAtBoot(this));
        } catch (_) { /* best-effort */ }
        await phase("PDF registry", () => this.initPdfRegistry());
        // Drop any empty Untitled docs that survived the last session
        // (created by `newFile` but never typed into). Runs before the
        // "restore last file" branch so we don't land on a ghost.
        await phase("prune empty Untitled docs", () => _files.pruneEmptyUntitled(this));
        // Persist only when a boot repair actually changed the tree.
        // The old unconditional save made every window boot write the
        // whole forest — so a deep-link carrier scene (or a relaunch)
        // stomped desks that a sibling window had just changed, which is
        // how content "moved" between desks across a restart.
        if (specialsChanged || pdfLayoutChanged) await phase("save repaired tree", () => this.saveFileTree());

        // Restore session state from settings
        this.typewriterMode = !!this.settings.typewriterMode;
        this.dryMode = !!this.settings.dryMode;
        this.spellcheckMode = !!this.settings.spellcheckMode;
        this.runtime.pendingScrollPosition = this.settings.scrollPosition || null;

        if (initialFile && initialFile.fileId && initialFile.fileType) {
          // New-window startup path — main.js will mount the notebook /
          // project surface based on the seeded fields below; we don't
          // touch persisted lastFileId so the main window's session is
          // unaffected when this window closes.
          // Notebooks, stacks and PDFs are surfaces main.js mounts off
          // these seed fields — the same three the "restore last file"
          // branch below sets. Only docs go through `openFile`; routing
          // a stack or a PDF there opened its raw bytes as markdown.
          if (initialFile.fileType === "notebook"
              && this.files.some(f => f.id === initialFile.fileId)) {
            this.currentNotebookFileId = initialFile.fileId;
          } else if (initialFile.fileType === "stack"
              && findNodeByFileId(this.fileTree, initialFile.fileId)) {
            this.currentStackFileId = initialFile.fileId;
          } else if (initialFile.fileType === "pdf"
              && findNodeByFileId(this.fileTree, initialFile.fileId)) {
            this.currentPdfFileId = initialFile.fileId;
          } else if (initialFile.fileType === "project"
              && findNode(this.fileTree, initialFile.fileId)) {
            await phase("open project (new window)", () => this.openProject(initialFile.fileId));
          } else if (this.files.some(f => f.id === initialFile.fileId)) {
            await phase("open file (new window)", () => this.openFile(initialFile.fileId));
          } else if (this.files.length > 0) {
            await phase("open first file (fallback)", () => this.openFile(this.files[0].id));
          } else {
            await phase("create first file", () => this.newFile());
          }
        } else {
          // Restore last open file/project/notebook
          const lastProjectId = this.settings.lastProjectId;
          const lastFileId = this.settings.lastFileId;
          const lastNotebookId = this.settings.lastNotebookId;
          const lastPdfId = this.settings.lastPdfId;
          const lastStackId = this.settings.lastStackId;
          if (lastStackId && findNodeByFileId(this.fileTree, lastStackId)) {
            this.currentStackFileId = lastStackId;
          } else if (lastPdfId && findNodeByFileId(this.fileTree, lastPdfId)) {
            this.currentPdfFileId = lastPdfId;
          } else if (lastNotebookId && this.files.some(f => f.id === lastNotebookId)) {
            this.currentNotebookFileId = lastNotebookId;
          } else if (lastProjectId && findNode(this.fileTree, lastProjectId)) {
            await phase("restore last project", () => this.openProject(lastProjectId));
          } else if (lastFileId && this.files.some(f => f.id === lastFileId)) {
            await phase("restore last file", () => this.openFile(lastFileId));
          } else if (this.settings.lastLocalSync?.folderId) {
            // A Local Folder file was the last thing open. Defer the
            // actual open to main-modes (it needs a live editor); just
            // stash the descriptor here.
            this.runtime.pendingLocalSync = { ...this.settings.lastLocalSync };
          } else {
            // Nothing to restore — leave every current* pointer null so
            // main-modes drops to the "no file selected" pane rather than
            // opening an unrelated DB file or spawning an Untitled doc.
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
    if (Object.keys(migrateShortcutDefaults(this.settings)).length) {
      localStorage.setItem("hush_settings", JSON.stringify(this.settings));
    }
    _desks.migrateLegacyTreeIfNeeded(this).catch(() => {});
    this.ensureSpecialNodes();
    // Drop any empty Untitled docs that survived the last session.
    _files.pruneEmptyUntitled(this).catch(() => {});
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
      // Notebook autosave is handled via the "notebook-autosave" event.
      // Skip when a pull lock is held for this notebook — the canvas
      // is mid-reload and an autosave between save_file and the reload
      // would race the just-arrived remote content back over the wire.
      if (this.currentNotebookFileId && !this._isPullLockedForCurrent()) {
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
    // Notebooks autosave every 2 s via a separate event; without this
    // arm, a remote pull mid-stroke can race the autosave and erase
    // the user's in-progress shapes from both sides.
    if (key && key === this.currentNotebookFileId) return true;
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
  static PDFS_ID = "__pdfs__";
  static ARCHIVE_ID = "__archive__";
  static TRASH_ID = "__trash__";

  /** Resolve the special-node id for the active context. With desks
   *  off, returns the legacy id; with desks on, the active desk's
   *  namespaced id. */
  getInboxId() { return _desks.activeSpecialId(this, AppState.INBOX_ID); }
  getImagesId() { return _desks.activeSpecialId(this, AppState.IMAGES_ID); }
  getPdfsId() { return _desks.activeSpecialId(this, AppState.PDFS_ID); }
  getArchiveId() { return _desks.activeSpecialId(this, AppState.ARCHIVE_ID); }
  getTrashId() { return _desks.activeSpecialId(this, AppState.TRASH_ID); }
  isSpecialNodeId(id) { return _desks.isSpecialNodeId(id); }

  /** Ensure per-desk specials + fold stragglers. Returns true when the
   *  pass changed the tree (callers persist only then — see init). */
  ensureSpecialNodes() {
    const { created, changed } = _desks.ensureDesksTreeSpecials(this, this.fileTree);
    _desks.seedNewArchivesCollapsed(this, created);
    return changed;
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

  async saveFileTree() { return _files.saveFileTree(this); }

  // ===== Tree Operations (delegated to state-tree.js) =====
  _activeDeskParent(parentId) { return parentId || _desks.getActiveDesk(this)?.id || null; }
  async createFolder(name, parentId = null) { const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_folder", "folder", name, this._activeDeskParent(parentId)); }
  async createProject(name, parentId = null) { const m = await import("./state-tree.js"); return m.createTreeNode(this, "create_project", "project", name, this._activeDeskParent(parentId)); }
  /** Import a .hushproject — `data` is the zip bytes (Uint8Array/ArrayBuffer)
   *  or an already-unpacked envelope descriptor. */
  async importProject(data, parentId = null, opts = {}) {
    let envelope = data;
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      const { unpackProject } = await import("../project/project-pack.js");
      envelope = await unpackProject(data);
    }
    const m = await import("./state-project-import.js");
    return m.createProjectFromEnvelope(this, envelope, parentId, opts);
  }
  async deleteTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.deleteTreeNode(this, nodeId); }
  async emptyTrash() { const m = await import("./state-tree.js"); return m.emptyTrash(this); }
  async renameTreeNode(nodeId, newName) { const m = await import("./state-tree.js"); return m.renameTreeNode(this, nodeId, newName); }
  async toggleFlagged(nodeId) { const m = await import("./state-tree.js"); return m.toggleFlagged(this, nodeId); }
  async toggleUseAsNote(nodeId) { const m = await import("./state-tree.js"); return m.toggleUseAsNote(this, nodeId); }
  async duplicateTreeNode(nodeId) { const m = await import("./state-tree.js"); return m.duplicateTreeNode(this, nodeId); }
  async convertContainerType(nodeId, targetType) { const m = await import("./state-tree.js"); return m.convertContainerType(this, nodeId, targetType); }
  async convertProjectToDoc(nodeId) { const m = await import("./state-convert.js"); return m.convertProjectToDoc(this, nodeId); }
  async convertDocToProject(nodeId) { const m = await import("./state-convert.js"); return m.convertDocToProject(this, nodeId); }
  async splitDocAtHeadings(nodeId, opts) { const m = await import("./state-split-combine.js"); return m.splitDocAtHeadings(this, nodeId, opts); }
  async convertHeadingsToTabs(nodeId, opts) { const m = await import("./state-split-combine.js"); return m.convertHeadingsToTabs(this, nodeId, opts); }
  async combineDocsIntoDoc(fileIds, opts) { const m = await import("./state-split-combine.js"); return m.combineDocsIntoDoc(this, fileIds, opts); }

  async createImageFromFile(file) { const m = await import("./state-images.js"); return m.createImageFromFile(this, file); }
  async createImageFromDataUrl(dataUrl, name) { const m = await import("./state-images.js"); return m.createImageFromDataUrl(this, dataUrl, name); }
  async loadImageDataUrl(fileId) { const m = await import("./state-images.js"); return m.getImageDataUrl(fileId); }

  // ===== Project View (delegated to state-project.js) =====

  async openProject(projectId) {
    if (this.ratchetMode) return;
    return _openProject(this, projectId);
  }
  async saveProjectContent() { return _saveProjectContent(this); }
  async markGutterForDoc(docFileId, notebookFileId) { return _markGutterForDoc(this, docFileId, notebookFileId); }
  async unmarkGutterForDoc(docFileId) { return _unmarkGutterForDoc(this, docFileId); }

  // ===== Notebook Operations (delegated to state-files.js) =====

  /** Create a new notebook.
   *  @param {string} name           Display name for the new notebook.
   *  @param {string|null} parentId  Tree node to insert under (defaults to Inbox).
   *  @param {object} [opts]
   *  @param {boolean} [opts.openImmediately=true]  When false, the notebook
   *    is created + tree-added + synced but isn't opened in the main view
   *    (used by the "New Notebook as Pane" command palette entry).
   *  @returns {Promise<{ fileId: string, name: string } | undefined>}
   */
  createNotebook(name, parentId = null, opts = {}) { return _files.createNotebook(this, name, parentId, opts); }
  openNotebook(fileId) { return _files.openNotebook(this, fileId); }

  // ===== File Operations (delegated to state-files.js) =====

  saveCurrentFile() { return _files.saveCurrentFile(this); }
  /** Create a new document.
   *  @param {string|null} parentId  Tree node to insert under (defaults to Inbox).
   *  @param {object} [opts]
   *  @param {boolean} [opts.openImmediately=true]  When false, the new file
   *    is created + tree-added + synced but the main editor doesn't switch
   *    to it (used by the "New Doc as Pane" command palette entry).
   *  @returns {Promise<{ fileId: string, name: string } | undefined>}
   */
  newFile(parentId = null, opts = {}) { return _files.newFile(this, parentId, opts); }
  openFile(id) { return _files.openFile(this, id); }
  openPdf(fileId) { return _files.openPdf(this, fileId); }
  importPdf(name, bytes, parentId, opts = {}) { return _files.importPdf(this, name, bytes, parentId, opts); }
  registerPdfPlaceholder(name, opts = {}) { return _files.registerPdfPlaceholder(this, name, opts); }

  async ensurePdfsFolder() {
    const pdfsId = this.getPdfsId();
    if (findNode(this.fileTree, pdfsId)) return;
    const deskId = this.settings?.activeDeskId;
    const desk = this.fileTree.find(n => n.type === "desk" && n.id === deskId) || this.fileTree.find(n => n.type === "desk");
    if (!desk) return;
    const pdfsNode = { id: pdfsId, type: "folder", name: "PDFs", children: [], flagged: false };
    desk.children.push(pdfsNode);
    const { pinSpecialsInList } = await import("./tree-helpers.js");
    pinSpecialsInList(desk.children);
    await this.saveFileTree();
  }

  async initPdfRegistry() {
    const { initPdfRegistry } = await import("../sync/pdf-sync.js");
    await initPdfRegistry(this);
  }
  createStack(name, parentId = null, opts = {}) { return _files.createStack(this, name, parentId, opts); }
  openStack(fileId) { return _files.openStack(this, fileId); }

  // ===== Multi-select =====
  /** Replace the current selection with the given list of doc fileIds.
   *  Dedupes and ignores non-strings; emits `multi-select-changed` so
   *  the sidebar + editor area can repaint. */
  setSelectedDocs(ids) {
    const next = Array.from(new Set((ids || []).filter((x) => typeof x === "string")));
    const prev = this.selectedDocIds;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) return;
    this.selectedDocIds = next;
    this.emit("multi-select-changed");
  }
  /** Clear the multi-select. No-op when already empty. */
  clearSelectedDocs() {
    if (!this.selectedDocIds.length) return;
    this.selectedDocIds = [];
    this.emit("multi-select-changed");
  }

  deleteFile(id) { return _files.deleteFile(this, id); }
  clearActiveFile() { return _files.clearActiveFile(this); }
  renameFile(id, newName) { return _files.renameFile(this, id, newName); }
  duplicateFile(id) { return _files.duplicateFile(this, id); }

  maybeRenameFromFirstLine() { return _naming.maybeRenameFromFirstLine(this); }
  maybeRenameFileFromContent(fileId, content) { return _naming.maybeRenameFileFromContent(this, fileId, content); }
  _deriveName(content) { return _naming.deriveName(content); }

  // ===== Sync Operations (delegated to sibling modules) =====
  // Desks (delegated to state-desks.js)
  enableDesks(name) { return _desks.enableDesks(this, name); }
  createDesk(name) { return _desks.createDesk(this, name); }
  renameDesk(id, name, opts) { return _desks.renameDesk(this, id, name, opts); }
  deleteDesk(id, opts) { return _desks.deleteDesk(this, id, opts); }
  setActiveDesk(id) { return _desks.setActiveDesk(this, id); }
  async reorderDesks(orderedIds) { const m = await import("./state-desks-ops.js"); return m.reorderDesks(this, orderedIds); }
  getActiveDesk() { return _desks.getActiveDesk(this); }
  getDeskGlobalStyleId() { return _desks.getDeskGlobalStyleId(this); }
  setDeskGlobalStyleId(id) { return _desks.setDeskGlobalStyleId(this, id); }
  // Per-desk "last opened file" — see state-desks.js. Each open path
  // (openFile / openNotebook) records into the active desk; switching
  // desks restores the matching file via main.js's active-desk-changed
  // handler.
  getDeskLastFile(deskId) { return _desks.getDeskLastFile(this, deskId); }
  recordActiveDeskLastFile(fileId, type) { return _desks.recordActiveDeskLastFile(this, fileId, type); }
  recordLocalSyncOpen(folderId, relPath, name) { return _desks.recordLocalSyncOpen(this, folderId, relPath, name); }
  async toggleMinimap() { const n = !this.settings?.minimapVisible; await this.updateSettings({ minimapVisible: n }); this.emit("minimap-visibility-changed", n); }

  // ===== Pane visibility (delegated to state-panes.js) =====
  async hidePanesForActive() { const m = await import("./state-panes.js"); return m.hidePanesForActive(this); }
  async showPanesForActive() { const m = await import("./state-panes.js"); return m.showPanesForActive(this); }
  // ===== External-store mutation hooks =====
  // Dropbox sync is gone (see LOCAL-DESKS-PLANNING.md). These hooks are
  // intentionally kept as no-ops: every mutation path in the app already
  // reports through them, and the desk-folder write-through (Phase 1 of
  // the Local Desks plan) re-attaches here rather than re-plumbing every
  // call site.
  async syncFileToExternal() {}
  async syncRenameNode() {}
  async syncDeleteNode() {}
  async syncCreateNode() {}
  async syncCreateFile() {}
  async syncProjectOrdering() {}
  async reconcileSync() {}

  /**
   * Write settings.
   *
   * **Every write is key-scoped.** `partial` is sent to Rust's
   * `patch_settings`, which merges those keys into the live settings
   * under its own mutex and writes the result. Nothing else this window
   * happens to be holding travels to disk.
   *
   * That matters because a window's in-memory copy is stale the moment
   * anything else writes: a sibling window, the Settings panel's own
   * snapshot from when it was opened, or simply another write from this
   * window that hasn't come back yet. Sending the whole object means
   * asserting a value for every setting in the app, and the last write
   * to land wins — which is how a closed floating pane came back on the
   * next launch, and, before that, how the YOUAREHERE registry
   * vanished. Intermittently, both times, because it turned on which
   * write happened to land last.
   *
   * Per-window keys (`_PER_WINDOW_SETTINGS_KEYS`) are the one exception
   * and they run the other way: disk holds the MAIN window's session, so
   * a secondary window keeps them in memory only and never writes them.
   * A secondary window's write of shared keys therefore carries no
   * per-window keys at all, rather than needing them stripped afterwards.
   */
  async updateSettings(partial, opts = {}) {
    Object.assign(this.settings, partial);
    let toWrite = partial;
    if (this.isSecondaryWindow) {
      toWrite = {};
      for (const [k, v] of Object.entries(partial || {})) {
        if (!_PER_WINDOW_SETTINGS_KEYS.has(k)) toWrite[k] = v;
      }
      // Nothing shared to write — this window's session stays in memory.
      if (Object.keys(toWrite).length === 0) {
        this.emit("settings-changed");
        return;
      }
    }
    if (IS_TAURI) {
      try { await tauriInvoke("patch_settings", { patch: toWrite }); }
      catch (e) { console.error("Settings save failed:", e); }
    } else { localStorage.setItem("hush_settings", JSON.stringify(this.settings)); }
    this._broadcastCrossWindow("settings");
    this.emit("settings-changed");
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
    // A Local Sync notebook rides on an `ls:` sentinel id; it isn't a VC
    // file, so don't persist it as the cross-session last notebook (the
    // restore path would call load_file on a non-existent id).
    const nbId = typeof this.currentNotebookFileId === "string"
      && this.currentNotebookFileId.startsWith("ls:") ? null : (this.currentNotebookFileId || null);
    await this.updateSettings({
      lastFileId: this.currentFileId || null,
      lastProjectId: this.currentProjectId || null,
      lastNotebookId: nbId,
      typewriterMode: this.typewriterMode,
      dryMode: this.dryMode,
      spellcheckMode: this.spellcheckMode,
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
  toggleSpellcheck() { _modes.toggleSpellcheck(this); }
  toggleFocus() { _modes.toggleFocus(this); }
  toggleZenFocus() { _modes.toggleZenFocus(this); }
  toggleSelectionFocus(payload) { _modes.toggleSelectionFocus(this, payload); }
  toggleShuffleEditor(payload) { _modes.toggleShuffleEditor(this, payload); }
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
