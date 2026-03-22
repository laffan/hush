/**
 * Central application state management
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export class AppState {
  constructor() {
    this.settings = {
      // General
      visibility: "menubar", // menubar | dock | both

      // Editor > Appearance
      appearance: "dark", // light | dark | auto

      // Editor > Themes
      lightTheme: "ayuLight",
      darkTheme: "dracula",

      // Editor > Text
      fontSize: 20,
      lineHeight: 1.6,
      fontFamily: "EB Garamond",
      normalizeHeaders: false,
      padding: 50,

      // File management
      autosaveFolder: null,
      obsidianIntegration: false,

      // Window
      alwaysOnTop: false,
      columnWidth: 600,

      // Shortcuts — General
      shortcutOpenEditor: "CmdOrCtrl+Shift+H",
      shortcutOpenFullscreen: "CmdOrCtrl+Shift+F",
      shortcutTogglePrivate: "CmdOrCtrl+Shift+P",
      shortcutToggleSidebar: "Mod+\\",
      shortcutTypewriter: "Mod+T",
      shortcutNewFile: "Mod+N",
      shortcutToggleDry: "Mod+Shift+R",
      shortcutFind: "Mod+F",
      shortcutFindAll: "Mod+Shift+F",

      // Shortcuts — Editing (sentence navigation)
      shortcutSelectSentence: "Mod+L",
      shortcutReduceSentence: "Mod+Shift+L",
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

      // Styles
      styles: [],
      activeStyleId: null,

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
    this.isFullscreen = false;

    // Autosave interval
    this.autosaveInterval = null;
    this.dirty = false;

    // Listeners
    this._listeners = {};
  }

  async init() {
    if (IS_TAURI) {
      try {
        Object.assign(this.settings, await tauriInvoke("get_settings"));
        this.files = await tauriInvoke("list_files");
        this.fileTree = await tauriInvoke("get_file_tree");

        // Restore session state from settings
        this.typewriterMode = !!this.settings.typewriterMode;
        this.dryMode = !!this.settings.dryMode;
        this._pendingScrollPosition = this.settings.scrollPosition || null;

        // Restore last open file/project
        const lastProjectId = this.settings.lastProjectId;
        const lastFileId = this.settings.lastFileId;
        if (lastProjectId && this._findNode(this.fileTree, lastProjectId)) {
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
    if (savedFiles) {
      this.files = JSON.parse(savedFiles);
    }

    const savedTree = localStorage.getItem("hush_file_tree");
    if (savedTree) {
      this.fileTree = JSON.parse(savedTree);
    } else if (this.files.length > 0) {
      // Migrate flat files to tree
      this.fileTree = this.files.map((f) => ({
        id: crypto.randomUUID(),
        type: "document",
        name: f.name,
        fileId: f.id,
        children: [],
      }));
      this._saveTreeLocal();
    }

    if (this.files.length > 0) {
      this.currentFileId = this.files[0].id;
    } else {
      this._createLocalFile();
    }

    const savedSettings = localStorage.getItem("hush_settings");
    if (savedSettings) {
      Object.assign(this.settings, JSON.parse(savedSettings));
    }
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

  // ===== File Tree Operations =====

  async saveFileTree() {
    if (IS_TAURI) {
      try { await tauriInvoke("save_file_tree", { tree: this.fileTree }); }
      catch (e) { console.error("Save tree failed:", e); }
    } else { this._saveTreeLocal(); }
    this.emit("files-changed");
  }

  async createFolder(name, parentId = null) {
    if (IS_TAURI) {
      try {
        const created = await tauriInvoke("create_folder", { name, parentId });
        this.fileTree = await tauriInvoke("get_file_tree");
        this.emit("files-changed");
        return created;
      } catch (e) { console.error("Create folder failed:", e); }
    } else {
      const node = { id: crypto.randomUUID(), type: "folder", name, children: [] };
      this._insertNode(node, parentId);
      this._saveTreeLocal();
      this.emit("files-changed");
      return node;
    }
  }

  async createProject(name, parentId = null) {
    if (IS_TAURI) {
      try {
        const created = await tauriInvoke("create_project", { name, parentId });
        this.fileTree = await tauriInvoke("get_file_tree");
        this.emit("files-changed");
        return created;
      } catch (e) { console.error("Create project failed:", e); }
    } else {
      const node = { id: crypto.randomUUID(), type: "project", name, children: [] };
      this._insertNode(node, parentId);
      this._saveTreeLocal();
      this.emit("files-changed");
      return node;
    }
  }

  _insertNode(node, parentId) {
    if (!parentId) {
      this.fileTree.push(node);
      return;
    }
    const parent = this._findNode(this.fileTree, parentId);
    if (parent) {
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else {
      this.fileTree.push(node);
    }
  }

  _findNode(nodes, id) {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = this._findNode(n.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  _removeNode(nodes, id) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) {
        return nodes.splice(i, 1)[0];
      }
      if (nodes[i].children) {
        const removed = this._removeNode(nodes[i].children, id);
        if (removed) return removed;
      }
    }
    return null;
  }

  _collectDocumentIds(nodes) {
    const ids = [];
    for (const n of nodes) {
      if (n.type === "document" && n.fileId) {
        ids.push(n.fileId);
      }
      if (n.children) {
        ids.push(...this._collectDocumentIds(n.children));
      }
    }
    return ids;
  }

  async deleteTreeNode(nodeId) {
    const node = this._findNode(this.fileTree, nodeId);
    if (!node) return;
    const fileIds = [];
    if (node.type === "document" && node.fileId) fileIds.push(node.fileId);
    if (node.children) fileIds.push(...this._collectDocumentIds(node.children));

    for (const fid of fileIds) {
      if (IS_TAURI) {
        try { await tauriInvoke("delete_file", { id: fid }); }
        catch (e) { console.error("Delete file failed:", e); }
      } else { this.files = this.files.filter((f) => f.id !== fid); }
    }

    this._removeNode(this.fileTree, nodeId);
    await this.saveFileTree();
    if (IS_TAURI) { this.files = await tauriInvoke("list_files"); }
    else { this._saveFilesLocal(); }

    if (fileIds.includes(this.currentFileId)) {
      this.currentProjectId = null;
      this.projectDocIds = [];
      if (this.files.length > 0) await this.openFile(this.files[0].id);
      else await this.newFile();
    }
    this.emit("files-changed");
  }

  async renameTreeNode(nodeId, newName) {
    const node = this._findNode(this.fileTree, nodeId);
    if (!node) return;
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
  }

  async duplicateTreeNode(nodeId) {
    const node = this._findNode(this.fileTree, nodeId);
    if (!node || node.type !== "document" || !node.fileId) return;
    const newFileId = await this.duplicateFile(node.fileId);
    if (!newFileId) return;
    const newNode = { id: crypto.randomUUID(), type: "document", name: node.name + " copy", fileId: newFileId, children: [] };
    this._insertAfter(this.fileTree, nodeId, newNode);
    await this.saveFileTree();
  }

  _insertAfter(nodes, afterId, newNode) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === afterId) {
        nodes.splice(i + 1, 0, newNode);
        return true;
      }
      if (nodes[i].children && this._insertAfter(nodes[i].children, afterId, newNode)) {
        return true;
      }
    }
    return false;
  }

  // ===== Project View =====

  async openProject(projectId) {
    if (this.dirty) await this.saveCurrentFile();
    const node = this._findNode(this.fileTree, projectId);
    console.log("[openProject] node:", node);
    if (!node || node.type !== "project") return;
    this.currentProjectId = projectId;
    this.currentFileId = null;
    this.projectDocIds = this._collectDocumentIds(node.children || []);
    console.log("[openProject] projectDocIds:", this.projectDocIds);

    let ordered = [];
    if (IS_TAURI) {
      for (const fid of this.projectDocIds) {
        try { ordered.push(await tauriInvoke("load_file", { id: fid })); }
        catch (e) { console.error("[openProject] Failed to load file:", fid, e); }
      }
    } else {
      ordered = this.projectDocIds.map((fid) => this.files.find((e) => e.id === fid)).filter(Boolean);
    }
    console.log("[openProject] ordered count:", ordered.length, "docIds:", this.projectDocIds);
    const combined = ordered.map((e) => e.content).join("\n\n---hush-separator---\n\n");
    console.log("[openProject] combined length:", combined.length, "preview:", combined.slice(0, 200));
    if (this.editor) {
      this.editor.setContent(combined);
      console.log("[openProject] setContent called");
    } else {
      console.log("[openProject] NO EDITOR");
    }
    this.emit("file-opened");
    this.updateSettings({ lastProjectId: projectId, lastFileId: null });
  }

  async saveProjectContent() {
    if (!this.currentProjectId || !this.editor || this.projectDocIds.length === 0) return;
    const parts = this.editor.getContent().split("\n\n---hush-separator---\n\n");
    for (let i = 0; i < this.projectDocIds.length && i < parts.length; i++) {
      const fileId = this.projectDocIds[i];
      if (IS_TAURI) {
        try { await tauriInvoke("save_file", { id: fileId, content: parts[i] || "" }); }
        catch (e) { console.error("Save project part failed:", e); }
      } else {
        const file = this.files.find((f) => f.id === fileId);
        if (file) { file.content = parts[i] || ""; file.modified = Math.floor(Date.now() / 1000); file.name = this._deriveName(file.content); }
      }
    }
    this.dirty = false;
    if (IS_TAURI) { this.files = await tauriInvoke("list_files"); }
    else { this._saveFilesLocal(); }
    this.emit("files-changed");
  }

  // ===== File Operations =====

  async saveCurrentFile() {
    if (this.currentProjectId) return this.saveProjectContent();
    if (!this.currentFileId || !this.editor) return;
    const content = this.editor.getContent();
    this.dirty = false;
    if (IS_TAURI) {
      try { await tauriInvoke("save_file", { id: this.currentFileId, content }); this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Save failed:", e); }
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
    const node = this._findNodeByFileId(this.fileTree, fileId);
    if (node && node.name !== file.name) {
      node.name = file.name;
      return true;
    }
    return false;
  }

  _findNodeByFileId(nodes, fileId) {
    for (const n of nodes) {
      if (n.type === "document" && n.fileId === fileId) return n;
      if (n.children) {
        const found = this._findNodeByFileId(n.children, fileId);
        if (found) return found;
      }
    }
    return null;
  }

  async newFile(parentId = null) {
    if (this.dirty) await this.saveCurrentFile();
    let fileId;
    if (IS_TAURI) {
      try { const file = await tauriInvoke("create_file"); fileId = file.id; this.files = await tauriInvoke("list_files"); }
      catch (e) { console.error("Create file failed:", e); return; }
    } else { fileId = this._createLocalFile().id; }
    const treeNode = { id: crypto.randomUUID(), type: "document", name: "Untitled", fileId, children: [] };
    this._insertNode(treeNode, parentId);
    await this.saveFileTree();
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
