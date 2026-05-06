/**
 * Sync polling — drives Dropbox change detection via the cursor consumer
 * (`dropbox-cursor.js`) and applies events to local state.
 *
 * Replaces the older two-step poll (per-file `getMetadata` loop +
 * full-folder path-set diff). Now a single `pullDropboxCursor` call asks
 * Dropbox "what's changed since the last cursor?" and returns typed
 * events. Identity is tracked by Dropbox's per-file `id` and `rev`, so:
 *   * Renames are reported with the same id and a new path → we update
 *     the path in the sync map. No duplicate created.
 *   * Our own writes (we record `rev` after every upload) are skipped
 *     by rev match, so we never pull back content we just pushed.
 *   * The cursor returns *only* deltas, so polling is cheap regardless
 *     of folder size.
 */

import { pullDropboxCursor } from "./dropbox-cursor.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

let syncPollTimer = null;
let syncing = false;
let _state = null;

let _dropboxConnected = true;
let _healthCheckCounter = 0;
const HEALTH_CHECK_INTERVAL = 6; // every 60s (6 × 10s ticks)
let _startupReconcileDone = false;

export function isDropboxConnected() {
  return _dropboxConnected;
}

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  _state = state;
  _startupReconcileDone = false;
  syncPollTimer = setInterval(() => runSyncCycle(state), 10000);
  setTimeout(() => runSyncCycle(state), 500);
  // Drain any ops queued while sync was paused (or by a previous session).
  import("./op-log.js").then(({ startDrainWorker }) => startDrainWorker(state));
}

export function triggerImmediateSync() {
  if (_state) runSyncCycle(_state);
}

export function triggerFullReconcile() {
  if (!_state) return;
  runSyncCycle(_state);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  import("./op-log.js").then(({ stopDrainWorker }) => stopDrainWorker());
}

async function runSyncCycle(state) {
  if (syncing) return;
  if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return;
  syncing = true;
  try {
    if (!_startupReconcileDone) {
      _startupReconcileDone = true;
      const { reconcileSync } = await import("./sync-state.js");
      await reconcileSync(state);
    }

    await syncDropboxCursor(state);

    _healthCheckCounter++;
    if (_healthCheckCounter >= HEALTH_CHECK_INTERVAL) {
      _healthCheckCounter = 0;
      await checkDropboxHealth(state);
    }
  } catch (e) {
    console.error("Sync poll error:", e);
  } finally {
    syncing = false;
  }
}

// ===== Cursor-driven sync =====

async function syncDropboxCursor(state) {
  const dbx = await import("./dropbox.js");
  const { findNodeByFileId, removeNode } = await import("../state/tree-helpers.js");
  const { invoke } = await import("@tauri-apps/api/core");
  const { downloadImage } = await import("./sync-images.js");

  const summary = { created: [], renamed: 0, content: [], deleted: 0 };
  let treeChanged = false;

  const handlers = {
    onCreated: async (ev) => {
      const created = await applyCreated(state, ev, dbx, invoke, downloadImage);
      if (created) {
        treeChanged = true;
        summary.created.push(ev.name);
      }
    },
    onRenamed: async (ev) => {
      await applyRenamed(state, ev, invoke, findNodeByFileId);
      treeChanged = true;
      summary.renamed++;
    },
    onContentChanged: async (ev) => {
      const node = findNodeByFileId(state.fileTree, ev.internalId);
      const name = node?.name || ev.relativePath;
      const applied = await applyContentChanged(state, ev, dbx, invoke);
      if (applied) summary.content.push(name);
    },
    onDeleted: async (ev) => {
      const node = findNodeByFileId(state.fileTree, ev.internalId);
      if (node) {
        removeNode(state.fileTree, node.id);
        treeChanged = true;
        summary.deleted++;
      }
      await invoke("delete_sync_file", { folderPath: "__dropbox__", internalId: ev.internalId })
        .catch(() => {});
    },
    onMeta: async (ev) => {
      try {
        const { isOurRev } = await import("./meta-sync.js");
        if (isOurRev(ev.rev)) return; // our own upload echoing back

        const filename = ev.relativePath.split("/").pop();
        const dispatcher = await getMetaDispatcher(filename);
        if (!dispatcher) return; // unknown meta file — ignore for forward-compat

        const payload = await dbx.downloadFile(ev.dropboxPath);
        const result = await dispatcher(state, payload);
        if (result && (result.matched || result.added || result.applied)) {
          showSyncIndicator("pulled", `${filename} (${result.matched || 0}/${result.added || 0})`);
        }
      } catch (e) {
        console.warn("cursor: meta apply failed:", e);
      }
    },
  };

  try {
    await pullDropboxCursor(state, handlers);
    if (treeChanged) {
      await state.saveFileTree();
      state.files = await invoke("list_files");
      state.emit("files-changed");
    }
    if (summary.created.length || summary.renamed || summary.content.length || summary.deleted) {
      const parts = [];
      if (summary.created.length) parts.push(summary.created.join(", "));
      if (summary.content.length) parts.push(summary.content.join(", "));
      if (summary.renamed) parts.push(`${summary.renamed} renamed`);
      if (summary.deleted) parts.push(`${summary.deleted} deleted`);
      showSyncIndicator("pulled", parts.join(" / "));
    }
    updateDropboxStatus(state, true);
  } catch (e) {
    console.error("Dropbox cursor sync failed:", e);
    updateDropboxStatus(state, false);
  }
}

async function applyCreated(state, ev, dbx, invoke, downloadImage) {
  if (ev.kind === "image") {
    try {
      const finalName = await downloadImage(dbx, ev.dropboxPath, ev.name);
      await invoke("register_synced_image", {
        filename: finalName, syncFolderId: SYNC_FOLDER_ID, relativePath: ev.relativePath,
      });
      insertImageNode(state, finalName);
      return true;
    } catch (e) {
      console.error("cursor: image create failed:", e);
      return false;
    }
  }

  let content;
  if (ev.kind === "hushnote") {
    const buf = await dbx.downloadBinary(ev.dropboxPath);
    const { unpackNotebook } = await import("./notebook-sync.js");
    content = await unpackNotebook(new Uint8Array(buf));
  } else {
    content = await dbx.downloadFile(ev.dropboxPath);
  }

  const file = await invoke("create_file");
  await invoke("save_file", { id: file.id, content });
  await invoke("register_synced_file_full", {
    internalId: file.id,
    syncFolderId: SYNC_FOLDER_ID,
    relativePath: ev.relativePath,
    content,
    remoteId: ev.remoteId,
    rev: ev.rev,
    syncedAt: ev.serverModified || Math.floor(Date.now() / 1000),
  });

  insertDocumentNode(state, ev.relativePath, file.id, ev.kind === "hushnote", ev.name);
  return true;
}

async function applyRenamed(state, ev, invoke, findNodeByFileId) {
  // Update the sync map to reflect the new path. We don't move the file
  // on Dropbox — Dropbox already reported the rename; we're just catching
  // up locally. The Rust side would also try fs::rename, but Rust's
  // `rename_external_file` is gated on "if old path exists" so it's a no-op
  // here. Use update_sync_state to refresh path + rev atomically.
  const node = findNodeByFileId(state.fileTree, ev.internalId);
  // Walk the tree to put the node under the right parent if depth changed.
  // Rather than reparenting (complex; deferred), we update name + path-only.
  // If the user wants moves across folders to reflect on iPad → Mac, that's
  // a follow-up after this stage.
  await invoke("rename_sync_file", {
    folderPath: "__dropbox__",
    oldRelative: ev.oldRelativePath,
    newRelative: ev.newRelativePath,
    internalId: ev.internalId,
  });
  // Refresh rev so a later cursor delta with the same rev is recognized
  // as our own state, not a remote change.
  const file = await invoke("load_file", { id: ev.internalId }).catch(() => null);
  if (file) {
    await invoke("update_sync_state", {
      internalId: ev.internalId,
      content: file.content,
      rev: ev.rev,
      syncedAt: ev.serverModified || Math.floor(Date.now() / 1000),
    });
  }
  if (node) {
    const newName = ev.newRelativePath.split("/").pop().replace(/\.(md|hushnote)$/, "");
    if (node.name !== newName) node.name = newName;
  }
}

async function applyContentChanged(state, ev, dbx, invoke) {
  if (ev.kind === "image") return false; // images are content-immutable on rename

  // If the file is currently open in the editor, hold the pull lock
  // across the full pull (download + persist + setContent) so any
  // in-flight save / keystroke for this file is suppressed for the whole
  // window. Without this, the user's pre-pull buffer can ride out the
  // download via autosave and overwrite what we just pulled.
  const isOpen = state.currentFileId === ev.internalId && state.editor;
  if (isOpen) state.acquirePullLock(ev.internalId);

  try {
    let content;
    try {
      if (ev.kind === "hushnote") {
        const buf = await dbx.downloadBinary(ev.dropboxPath);
        const { unpackNotebook } = await import("./notebook-sync.js");
        content = await unpackNotebook(new Uint8Array(buf));
      } else {
        content = await dbx.downloadFile(ev.dropboxPath);
      }
    } catch (e) {
      console.error("cursor: content download failed:", e);
      return false;
    }

    await invoke("accept_external_change", {
      internalId: ev.internalId,
      content,
      syncedAt: ev.serverModified || null,
    });
    await invoke("update_sync_state", {
      internalId: ev.internalId,
      content,
      rev: ev.rev,
      syncedAt: ev.serverModified || Math.floor(Date.now() / 1000),
    });

    if (isOpen) {
      state.editor.setContent(content);
      // We just synced the editor's content with the remote. Clear dirty
      // so the next autosave doesn't push the same content right back.
      state.dirty = false;
    }
    // Notebooks have their own canvas; the open-editor branch above
    // wouldn't fire since `state.currentFileId` is null while a notebook
    // is open. Emit `notebook-sync-reload` so notebook-bridge can swap
    // shapes in place if the changed file is the open notebook.
    if (ev.kind === "hushnote" && state.currentNotebookFileId === ev.internalId) {
      state.emit("notebook-sync-reload", content);
    }
    state.files = await invoke("list_files");
    return true;
  } finally {
    if (isOpen) state.releasePullLock();
  }
}

/** Resolve the dispatcher for a `.hush/<file>` payload. Each meta-file
 *  module owns its applier; this just maps filename → loader. New meta
 *  files (workspace.json, etc.) join here. Unknown filenames return null
 *  for forward-compat: a future device's writes don't crash older clients. */
async function getMetaDispatcher(filename) {
  switch (filename) {
    case "panes.json":
      return (await import("./pane-sync.js")).applyPanesFile;
    case "projects.json":
      return (await import("./project-sync.js")).applyProjectsFile;
    case "styles.json":
      return (await import("./style-sync.js")).applyStylesFile;
    case "desktop.json":
    case "desk.json": // legacy filename — applier accepts both formats
      return (await import("./desktop-sync.js")).applyDesktopFile;
    case "desks.json":
      return (await import("./desks-sync.js")).applyDesksFile;
    default:
      return null;
  }
}

// ===== Tree insertion helpers =====

function insertDocumentNode(state, relativePath, fileId, isNotebook, name) {
  const parts = relativePath.split("/");
  const rawFileName = parts.pop();
  const fileName = (rawFileName || name || "Untitled").replace(/\.(md|hushnote)$/, "");
  let current = state.fileTree;
  for (const dirName of parts) {
    if (!dirName) continue;
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(n => n.id === "__inbox__" || n.id?.startsWith("__inbox__:")))
      || (dirName === "Trash" && current.find(n => n.id === "__trash__" || n.id?.startsWith("__trash__:")));
    if (!folder) {
      folder = { id: crypto.randomUUID(), type: "folder", name: dirName, children: [], flagged: false };
      const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
      if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
      else current.push(folder);
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }
  if (current.some(n => n.fileId === fileId)) return;
  const trashIdx = current.findIndex(n => n.id === "__trash__" || n.id?.startsWith("__trash__:") || n.name === "Trash");
  const node = {
    id: crypto.randomUUID(),
    type: isNotebook ? "notebook" : "document",
    name: fileName,
    fileId,
    children: [],
    flagged: false,
  };
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}

function insertImageNode(state, filename) {
  const images = state.fileTree.find(n => n.id === "__images__");
  if (!images) return;
  if (!Array.isArray(images.children)) images.children = [];
  if (images.children.some(c => c.type === "image" && c.fileId === filename)) return;
  images.children.push({
    id: crypto.randomUUID(), type: "image", name: filename,
    fileId: filename, children: [], flagged: false,
  });
}

// ===== Health + indicator =====

async function checkDropboxHealth(state) {
  if (!state.settings.dropboxEnabled) return;
  try {
    const dbx = await import("./dropbox.js");
    const result = await dbx.testConnection();
    updateDropboxStatus(state, result.ok);
  } catch (_) {
    updateDropboxStatus(state, false);
  }
}

function updateDropboxStatus(state, connected) {
  if (_dropboxConnected !== connected) {
    _dropboxConnected = connected;
    state.emit("dropbox-status-changed", { connected });
  }
}

function showSyncIndicator(direction, detail) {
  const existing = document.querySelector(".sync-indicator");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "sync-indicator";
  el.textContent = direction === "pulled" ? "Synced ↓" : "Synced ↑";
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);

  appendSyncLog(direction === "pulled" ? `Downloaded ${detail || "changes"}` : `Uploaded ${detail || "changes"}`);
}

let _pendingLogMessages = [];
let _logFlushTimer = null;

function appendSyncLog(message) {
  _pendingLogMessages.push(message);
  if (_logFlushTimer) clearTimeout(_logFlushTimer);
  _logFlushTimer = setTimeout(flushSyncLog, 2000);
}

async function flushSyncLog() {
  _logFlushTimer = null;
  if (!IS_TAURI || _pendingLogMessages.length === 0) return;
  const messages = _pendingLogMessages.splice(0);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const s = await invoke("get_settings");
    const log = s.dropboxSyncLog || [];
    const now = new Date();
    const ts = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    for (const msg of messages) log.push(`${ts}  ${msg}`);
    if (log.length > 50) log.splice(0, log.length - 50);
    s.dropboxSyncLog = log;
    await invoke("save_settings", { settings: s });
  } catch (_) {}
}
