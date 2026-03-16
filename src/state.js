/**
 * Central application state management
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export class AppState {
  constructor() {
    this.settings = {
      theme: "dark",
      fontSize: 20,
      fontFamily: "EB Garamond",
      padding: 50,
      autosaveFolder: null,
      obsidianIntegration: false,
      alwaysOnTop: false,
      showInDock: false,
      shortcutOpenEditor: "CmdOrCtrl+Shift+H",
      shortcutTogglePrivate: "CmdOrCtrl+Shift+P",
      columnWidth: 700,
    };

    this.currentFileId = null;
    this.files = [];
    this.editor = null;

    // Mode states
    this.ratchetMode = false;
    this.ratchetEndTime = null;
    this.ratchetTimer = null;
    this.privateMode = false;
    this.typewriterMode = false;
    this.typewriterPosition = 0.6; // fraction of window height
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
        const { invoke } = await import("@tauri-apps/api/core");
        this.settings = await invoke("get_settings");
        this.files = await invoke("list_files");
        if (this.files.length > 0) {
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

  async saveCurrentFile() {
    if (!this.currentFileId || !this.editor) return;
    const content = this.editor.getContent();
    this.dirty = false;

    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_file", { id: this.currentFileId, content });
        this.files = await invoke("list_files");
      } catch (e) {
        console.error("Save failed:", e);
      }
    } else {
      const file = this.files.find((f) => f.id === this.currentFileId);
      if (file) {
        file.content = content;
        file.modified = Math.floor(Date.now() / 1000);
        file.name = this._deriveName(content);
        this._saveFilesLocal();
      }
    }
    this.emit("files-changed");
  }

  async newFile() {
    // Save current before switching
    if (this.dirty) await this.saveCurrentFile();

    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const file = await invoke("create_file");
        this.currentFileId = file.id;
        this.files = await invoke("list_files");
        if (this.editor) this.editor.setContent("");
      } catch (e) {
        console.error("Create file failed:", e);
      }
    } else {
      const file = this._createLocalFile();
      this.currentFileId = file.id;
      if (this.editor) this.editor.setContent("");
    }
    this.emit("files-changed");
    this.emit("file-opened");
  }

  async openFile(id) {
    if (this.dirty) await this.saveCurrentFile();

    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const file = await invoke("load_file", { id });
        this.currentFileId = file.id;
        if (this.editor) this.editor.setContent(file.content);
      } catch (e) {
        console.error("Load file failed:", e);
      }
    } else {
      const file = this.files.find((f) => f.id === id);
      if (file) {
        this.currentFileId = file.id;
        if (this.editor) this.editor.setContent(file.content);
      }
    }
    this.emit("file-opened");
  }

  async deleteFile(id) {
    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("delete_file", { id });
        this.files = await invoke("list_files");
      } catch (e) {
        console.error("Delete failed:", e);
      }
    } else {
      this.files = this.files.filter((f) => f.id !== id);
      this._saveFilesLocal();
    }

    if (this.currentFileId === id) {
      if (this.files.length > 0) {
        await this.openFile(this.files[0].id);
      } else {
        await this.newFile();
      }
    }
    this.emit("files-changed");
  }

  async updateSettings(partial) {
    Object.assign(this.settings, partial);
    if (IS_TAURI) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_settings", { settings: this.settings });
      } catch (e) {
        console.error("Settings save failed:", e);
      }
    } else {
      localStorage.setItem("hush_settings", JSON.stringify(this.settings));
    }
    this.emit("settings-changed");
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
    if (this.ratchetMode) return; // unavailable during ratchet
    this.typewriterMode = !this.typewriterMode;
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
