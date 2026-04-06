/**
 * Central application state management
 */

import { findNode, removeNode, collectDocumentIds, findNodeByFileId, insertAfter, insertNode } from "./tree-helpers.js";
import { openProject as _openProject, saveProjectContent as _saveProjectContent } from "./state-project.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export class AppState {
  constructor() {
    this.settings = {
      visibility: "menubar",
      appearance: "dark",
      lightTheme: "ayuLight",
      darkTheme: "dracula",
      fontSize: 20,
      lineHeight: 1.6,
      fontFamily: "Source Sans Pro",
      normalizeHeaders: false,
      normalizeHeaderColor: false,
      stickyHeaders: false,
      blockCursor: false,
      typewriterLineOpacity: 0.08,
      padding: 50,
      syncFolders: [],
      dropboxToken: null,
      alwaysOnTop: false,
      columnWidth: 600,
      // Shortcuts — General
      shortcutOpenEditor: "CmdOrCtrl+Shift+H",
      shortcutOpenFullscreen: "CmdOrCtrl+Shift+F",
      shortcutTogglePrivate: "CmdOrCtrl+Shift+P",
      shortcutToggleSidebar: "CmdOrCtrl+\\",
      shortcutToggleOutline: "CmdOrCtrl+Shift+\\",
      shortcutTypewriter: "Mod+Shift+T",
      shortcutNewFile: "Mod+N",
      shortcutToggleDry: "Mod+Shift+R",
      shortcutToggleFocus: "Mod+Shift+Y",
      shortcutFind: "Mod+F",
      shortcutFindAll: "Mod+Shift+F",

      // Shortcuts — Editing (sentence navigation)
      shortcutSelectSentence: "Mod+L",
      shortcutReduceSentence: "Alt+Shift+L",
      shortcutSelectNext: "Mod+D",
      shortcutJumpNextSentence: "Mod+ArrowRight",
      shortcutJumpPrevSentence: "Mod+ArrowLeft",
      shortcutNextSentence: "Mod+Shift+ArrowRight",
      shortcutPrevSentence: "Mod+Shift+ArrowLeft",
      shortcutMoveSentenceForward: "Alt+Mod+ArrowRight",
      shortcutMoveSentenceBack: "Alt+Mod+ArrowLeft",
      shortcutSelectPrevious: "Mod+Shift+D",
      shortcutDeleteToSentenceEnd: "Alt+Shift+Backspace",

      // Shortcuts — Formatting
      shortcutBold: "Mod+B",
      shortcutItalic: "Mod+I",
      shortcutHighlight: "Mod+=",
      shortcutComment: "Mod+/",
      shortcutInsertFootnote: "Mod+Shift+M",

      // D.R.Y. highlighting
      dryRange: "paragraph",
      dryStopwords: [],
      dryIgnoreProperNouns: false,
      dryIncludeBaseWords: false,

      // Footnotes
      footnoteFontSize: 100,
      footnoteFontFamily: "sans-serif",
      footnoteUseColors: true,
      footnoteBothMargins: true,
      footnoteMarginSide: "closest",

      // Styles
      styles: [],
      activeStyleId: null,

      // Outline View (right sidebar)
      longviewShowParagraphs: true,
      longviewShowNumbers: true,
      longviewShowComments: false,
      longviewShowFlags: true,
      longviewShowFlagTypes: false,
      longviewWrapFlagText: true,
      longviewBodyFontSize: 3,
      longviewHeadingFontSize: 12,
      longviewFlagFontSize: 12,
      longviewLineGap: 2,
      longviewCurrentPositionColor: "#ff0000",

      // Flags (custom flag types and colors)
      flagColors: {
        TODO: "#ffd700",
        MISSING: "#ff4444",
        COMMENT: "#888888",
        REWRITE: "#ff66aa",
        RESEARCH: "#66aaff",
      },
      customFlags: [
        { name: "REWRITE", color: "#ff66aa" },
        { name: "RESEARCH", color: "#66aaff" },
      ],

      // Ratchet
      ratchetEncourageTyping: false,

      // Zotero
      zoteroApiKey: null,
      zoteroUserId: null,
      zoteroLastUpdate: null,
      zoteroReferenceCount: 0,
      zoteroFileSize: null,
      shortcutZotero: "Mod+Shift+L",

      // Session state
      lastFileId: null,
      lastProjectId: null,
      typewriterMode: false,
      dryMode: false,
      scrollPosition: null,
    };

    this.currentFileId = null;
    this.currentProjectId = null; // When viewing a project
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
    this.isFullscreen = false;

    // Autosave interval
    this.autosaveInterval = null;
    this.dirty = false;

    // Snapshot keystroke tracking
    this._keystrokeCount = 0;
    this._snapshotPending = false;

    // Listeners
    this._listeners = {};
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
        this._pendingScrollPosition = this.settings.scrollPosition || null;

        // Restore last open file/project
        const lastProjectId = this.settings.lastProjectId;
        const lastFileId = this.settings.lastFileId;
        if (lastProjectId && findNode(this.fileTree, lastProjectId)) {
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
    }, 2000);
  }

  setEditor(editor) {
    this.editor = editor;
  }

  markDirty() {
    this.dirty = true;
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
  static TRASH_ID = "__trash__";

  ensureSpecialNodes() {
    if (!this.fileTree.some(n => n.id === AppState.INBOX_ID))
      this.fileTree.unshift({ id: AppState.INBOX_ID, type: "project", name: "Inbox", children: [], flagged: false });
    if (!this.fileTree.some(n => n.id === AppState.TRASH_ID))
      this.fileTree.push({ id: AppState.TRASH_ID, type: "folder", name: "Trash", children: [], flagged: false });
    // Enforce positions: Inbox first, Trash last
    const iIdx = this.fileTree.findIndex(n => n.id === AppState.INBOX_ID);
    if (iIdx > 0) { const [n] = this.fileTree.splice(iIdx, 1); this.fileTree.unshift(n); }
    const tIdx = this.fileTree.findIndex(n => n.id === AppState.TRASH_ID);
    if (tIdx >= 0 && tIdx < this.fileTree.length - 1) { const [n] = this.fileTree.splice(tIdx, 1); this.fileTree.push(n); }
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

  async createFolder(name, parentId = null) {
    return this._createTreeNode("create_folder", "folder", name, parentId);
  }

  async createProject(name, parentId = null) {
    return this._createTreeNode("create_project", "project", name, parentId);
  }

  async _createTreeNode(command, type, name, parentId) {
    if (IS_TAURI) {
      try {
        const created = await tauriInvoke(command, { name, parentId });
        this.fileTree = await tauriInvoke("get_file_tree");
        this.emit("files-changed");
        // Propagate folder/project creation to external filesystem
        this.syncCreateNode(created.id, type);
        return created;
      } catch (e) { console.error(`Create ${type} failed:`, e); }
    } else {
      const node = { id: crypto.randomUUID(), type, name, children: [], flagged: false };
      insertNode(this.fileTree, node, parentId, findNode);
      this._saveTreeLocal();
      this.emit("files-changed");
      return node;
    }
  }

  async deleteTreeNode(nodeId) {
    if (nodeId === AppState.INBOX_ID || nodeId === AppState.TRASH_ID) return;
    const node = findNode(this.fileTree, nodeId);
    if (!node) return;
    if (this.isInTrash(nodeId)) return this._permanentDeleteNode(nodeId);
    // Propagate deletion to external filesystem BEFORE removing from tree
    await this.syncDeleteNode(nodeId);
    const removed = removeNode(this.fileTree, nodeId);
    if (removed) {
      // Clear flagged status when moving to trash
      this._clearFlaggedRecursive(removed);
      const trash = findNode(this.fileTree, AppState.TRASH_ID);
      if (trash) (trash.children || (trash.children = [])).push(removed);
    }
    await this.saveFileTree();
    const fileIds = this._collectNodeFileIds(node);
    if (fileIds.includes(this.currentFileId) || nodeId === this.currentProjectId) {
      this.currentProjectId = null; this.projectDocIds = [];
      if (this.files.length > 0) await this.openFile(this.files[0].id);
      else await this.newFile();
    }
    this.emit("files-changed");
  }

  async _permanentDeleteNode(nodeId) {
    const node = findNode(this.fileTree, nodeId);
    if (!node) return;
    const fileIds = this._collectNodeFileIds(node);
    await this._deleteFilesByIds(fileIds);
    removeNode(this.fileTree, nodeId);
    await this._finalizeFileDeletion(fileIds);
  }

  async emptyTrash() {
    const trash = findNode(this.fileTree, AppState.TRASH_ID);
    if (!trash?.children?.length) return;
    const fileIds = collectDocumentIds(trash.children);
    await this._deleteFilesByIds(fileIds);
    trash.children = [];
    await this._finalizeFileDeletion(fileIds);
  }

  _clearFlaggedRecursive(node) {
    node.flagged = false;
    if (node.children) node.children.forEach(c => this._clearFlaggedRecursive(c));
  }

  _collectNodeFileIds(node) {
    const ids = [];
    if (node.type === "document" && node.fileId) ids.push(node.fileId);
    if (node.children) ids.push(...collectDocumentIds(node.children));
    return ids;
  }

  async _deleteFilesByIds(fileIds) {
    for (const fid of fileIds) {
      if (IS_TAURI) {
        try { await tauriInvoke("delete_file", { id: fid }); } catch (e) { console.error("Delete file:", e); }
        try { await tauriInvoke("delete_document_snapshots", { documentId: fid }); } catch (e) { console.error("Delete snapshots:", e); }
      } else { this.files = this.files.filter(f => f.id !== fid); }
    }
  }

  async _finalizeFileDeletion(fileIds) {
    await this.saveFileTree();
    if (IS_TAURI) this.files = await tauriInvoke("list_files");
    else this._saveFilesLocal();
    if (fileIds.includes(this.currentFileId)) {
      this.currentProjectId = null; this.projectDocIds = [];
      if (this.files.length > 0) await this.openFile(this.files[0].id);
      else await this.newFile();
    }
    this.emit("files-changed");
  }

  async renameTreeNode(nodeId, newName) {
    const node = findNode(this.fileTree, nodeId);
    if (!node) return;
    const oldName = node.name;
    node.name = newName;
    if (node.type === "document" && node.fileId) {
      if (IS_TAURI) {
        try { await tauriInvoke("rename_file", { id: node.fileId, name: newName }); this.files = await tauriInvoke("list_files"); }
        catch (e) { console.error("Rename failed:", e); }
      } else {
        const file = this.files.find((f) => f.id === node.fileId);
        if (file) file.name = newName;
        this._saveFilesLocal();
      }
    }
    await this.saveFileTree();
    // Propagate rename to external filesystem
    if (oldName !== newName) {
      this.syncRenameNode(nodeId, oldName, node.type);
    }
  }

  async toggleFlagged(nodeId) {
    const node = findNode(this.fileTree, nodeId);
    if (!node) return;
    node.flagged = !node.flagged;
    await this.saveFileTree();
  }

  async duplicateTreeNode(nodeId) {
    const node = findNode(this.fileTree, nodeId);
    if (!node || node.type !== "document" || !node.fileId) return;
    const newFileId = await this.duplicateFile(node.fileId);
    if (!newFileId) return;
    const newNode = { id: crypto.randomUUID(), type: "document", name: node.name + " copy", fileId: newFileId, children: [], flagged: false };
    insertAfter(this.fileTree, nodeId, newNode);
    await this.saveFileTree();
  }

  // ===== Project View (delegated to state-project.js) =====

  async openProject(projectId) { return _openProject(this, projectId); }
  async saveProjectContent() { return _saveProjectContent(this); }

  // ===== File Operations =====

  async saveCurrentFile() {
    if (this.currentProjectId) return this.saveProjectContent();
    if (!this.currentFileId || !this.editor) return;
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
      if (file) { file.content = content; file.modified = Math.floor(Date.now() / 1000); file.name = this._deriveName(content); this._saveFilesLocal(); }
    }
    if (this._updateTreeNodeNameByFileId(this.currentFileId)) {
      this.emit("files-changed");
    }
  }

  _updateTreeNodeNameByFileId(fileId) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return false;
    const node = findNodeByFileId(this.fileTree, fileId);
    if (node && node.name !== file.name) {
      node.name = file.name;
      return true;
    }
    return false;
  }

  async newFile(parentId = null) {
    if (this.dirty) await this.saveCurrentFile();
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
    this.currentFileId = fileId;
    this.currentProjectId = null;
    this.projectDocIds = [];
    if (this.editor) this.editor.setContent("");
    this.emit("files-changed");
    this.emit("file-opened");
  }

  async openFile(id) {
    if (this.dirty) await this.saveCurrentFile();
    this.currentProjectId = null;
    this.projectDocIds = [];
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

  // ===== Sync Operations (delegated to sync-state.js) =====
  async _syncOp(fn, ...args) { const m = await import("../sync/sync-state.js"); return m[fn](this, ...args); }
  async importSyncFolder(f) { return this._syncOp("importSyncFolder", f); }
  async syncFileToExternal(fid, c) { return this._syncOp("syncFileToExternal", fid, c); }
  async syncRenameNode(nid, old, t) { return this._syncOp("syncRenameNode", nid, old, t); }
  async syncDeleteNode(nid) { return this._syncOp("syncDeleteNode", nid); }
  async syncCreateNode(nid, t) { return this._syncOp("syncCreateNode", nid, t); }
  async syncCreateFile(nid, fid, c) { return this._syncOp("syncCreateFile", nid, fid, c); }
  async syncProjectOrdering(pid) { return this._syncOp("syncProjectOrdering", pid); }
  async reconcileSync() { return this._syncOp("reconcileSync"); }

  async updateSettings(partial) {
    Object.assign(this.settings, partial);
    if (IS_TAURI) {
      try { await tauriInvoke("save_settings", { settings: this.settings }); }
      catch (e) { console.error("Settings save failed:", e); }
    } else { localStorage.setItem("hush_settings", JSON.stringify(this.settings)); }
    this.emit("settings-changed");
  }

  // Session state persistence
  async saveSessionState() {
    const scrollTop = this.editor
      ? this.editor.view.scrollDOM.scrollTop
      : null;
    await this.updateSettings({
      lastFileId: this.currentFileId || null,
      lastProjectId: this.currentProjectId || null,
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

  toggleFullscreen() {
    this.isFullscreen = !this.isFullscreen;
    this.emit("fullscreen-changed");
  }

  _deriveName(content) {
    const trimmed = content.trim();
    if (!trimmed) return "Untitled";
    const firstLine = trimmed.split("\n")[0].replace(/^#+\s*/, "").trim();
    return firstLine.length <= 20 ? firstLine : firstLine.slice(0, 20) + "...";
  }

  // Event system
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
  }

  emit(event, data) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach((fn) => fn(data));
  }
}
