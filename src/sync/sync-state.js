/**
 * Sync state operations — full tree sync to Dropbox.
 * Syncs all documents, folders, projects, and notebooks as a mirror backup.
 * Documents → .md files, Notebooks → .hushnote (zip) files, Projects → .hushproject (JSON) files.
 */

import {
  uploadImage,
  downloadImage,
  insertImageIntoTree,
} from "./sync-images.js";
import { sha256Hex, markOurFileRev } from "./meta-sync.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ===== Tree → Dropbox Path Helpers =====

/**
 * Derive a filesystem-safe name from a document's tree name.
 * Strips characters illegal in filenames. Max 50 chars.
 */
function safeName(name) {
  if (!name || name === "Untitled") return "Untitled";
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 50) || "Untitled";
}

/**
 * Return the Dropbox file extension for a given tree node type.
 */
function extensionForType(nodeType) {
  return nodeType === "notebook" ? ".hushnote" : ".md";
}

function isNotebookPath(relativePath) {
  return relativePath.endsWith(".hushnote");
}

/** Upload content to Dropbox, packing notebooks as zip. Returns the
 * upload response (which includes `server_modified` from Dropbox's clock).
 */
async function uploadContent(dbx, fullPath, content, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(content);
    return dbx.uploadBinary(fullPath, zipData);
  }
  return dbx.uploadFile(fullPath, content);
}

/** Convert a Dropbox `server_modified` ISO string to Unix seconds. */
function serverModifiedSecs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Download content from Dropbox, unpacking notebooks from zip. */
async function downloadContent(dbx, dropboxPath, relativePath) {
  if (isNotebookPath(relativePath)) {
    const { unpackNotebook } = await import("./notebook-sync.js");
    const zipData = await dbx.downloadBinary(dropboxPath);
    return unpackNotebook(zipData);
  }
  return dbx.downloadFile(dropboxPath);
}

/**
 * Build a flat map of files and directories from the file tree.
 * Documents become "Name.md", Notebooks become "Name.hushnote",
 * Projects get a ".hushproject" metadata file, Folders become directories.
 *
 * Desks contribute their name as a top-level path segment so
 * `Personal/Inbox/Doc.md` lands under `<deskName>/...` on Dropbox —
 * matching what `findSyncContext` produces for new uploads.
 */
export function buildSyncManifest(fileTree) {
  const manifest = { files: [], directories: [] };

  function walk(nodes, parentPath) {
    for (const node of nodes) {
      const name = safeName(node.name) || "Untitled";
      if ((node.type === "document" || node.type === "notebook") && node.fileId) {
        const ext = extensionForType(node.type);
        const relPath = parentPath ? `${parentPath}/${name}${ext}` : `${name}${ext}`;
        manifest.files.push({ nodeId: node.id, fileId: node.fileId, relativePath: relPath, type: node.type === "notebook" ? "hushnote" : "md" });
      } else if (node.type === "image" && node.fileId) {
        // Image filenames stay verbatim — they *are* the stable id.
        const relPath = parentPath ? `${parentPath}/${node.fileId}` : node.fileId;
        manifest.files.push({ nodeId: node.id, fileId: node.fileId, relativePath: relPath, type: "image" });
      } else if (node.type === "desk") {
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        manifest.directories.push(dirPath);
        if (node.children) walk(node.children, dirPath);
      } else if (node.type === "project") {
        // Project ordering now lives in `.hush/projects.json` rather
        // than per-folder `.hushproject` files. The folder itself is
        // still mirrored so child docs land in the right place.
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        manifest.directories.push(dirPath);
        if (node.children) walk(node.children, dirPath);
      } else if (node.type === "folder") {
        const dirPath = parentPath ? `${parentPath}/${name}` : name;
        manifest.directories.push(dirPath);
        if (node.children) walk(node.children, dirPath);
      }
    }
  }

  walk(fileTree, "");
  return manifest;
}

/**
 * Generate a sync preview: what will be uploaded and what will be downloaded.
 */
export async function generateSyncPreview(state, dropboxPath) {
  if (!IS_TAURI) return { toUpload: [], toDownload: [], unchanged: 0 };

  const dbx = await import("./dropbox.js");
  const manifest = buildSyncManifest(state.fileTree);

  let remoteEntries = [];
  try {
    remoteEntries = await dbx.listFolderRecursive(dropboxPath === "/" ? "" : dropboxPath);
  } catch (e) {
    if (!String(e).includes("not_found")) throw e;
  }

  const remotePaths = new Set(remoteEntries.filter(e => !e.isDirectory).map(e => e.relativePath));
  const localPaths = new Set(manifest.files.map(f => f.relativePath));

  const toUpload = manifest.files
    .filter(f => !remotePaths.has(f.relativePath))
    .map(f => ({ relativePath: f.relativePath, type: f.type }));

  const toDownload = remoteEntries
    .filter(e => !e.isDirectory && !localPaths.has(e.relativePath) && e.tag !== "hushproject")
    .map(e => ({ relativePath: e.relativePath, tag: e.tag || "md" }));

  const unchanged = manifest.files.filter(f => remotePaths.has(f.relativePath)).length;

  return { toUpload, toDownload, unchanged };
}

/**
 * Perform initial full sync — push local to Dropbox, pull new Dropbox files.
 * Returns { uploaded: string[], downloaded: string[] } with filenames.
 */
export async function performInitialSync(state, dropboxPath) {
  if (!IS_TAURI) return { uploaded: [], downloaded: [] };
  const dbx = await import("./dropbox.js");

  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const manifest = buildSyncManifest(state.fileTree);
  const uploaded = [];
  const downloaded = [];

  // Ensure the root sync folder exists
  if (basePath) {
    await dbx.createFolder(basePath).catch(() => {});
  }

  // Create all directories first
  for (const dir of manifest.directories) {
    const fullDir = basePath ? `${basePath}/${dir}` : `/${dir}`;
    await dbx.createFolder(fullDir).catch(() => {});
  }

  // Upload all files
  for (const file of manifest.files) {
    const fullPath = basePath ? `${basePath}/${file.relativePath}` : `/${file.relativePath}`;
    if (file.type === "image" && file.fileId) {
      try {
        await uploadImage(dbx, fullPath, file.fileId);
        uploaded.push(file.relativePath);
        await tauriInvoke("register_synced_image", {
          filename: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: file.relativePath,
        });
      } catch (e) {
        console.error(`Image upload failed for ${file.relativePath}:`, e);
      }
      continue;
    }
    let content = file.content || "";
    if ((file.type === "md" || file.type === "hushnote") && file.fileId) {
      try {
        const fileData = await tauriInvoke("load_file", { id: file.fileId });
        content = fileData.content || "";
      } catch (_) { continue; }
    }
    try {
      await uploadContent(dbx, fullPath, content, file.relativePath);
      uploaded.push(file.relativePath);
      if (file.fileId) {
        await tauriInvoke("register_synced_file", {
          internalId: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: file.relativePath, content,
        });
      }
    } catch (e) {
      console.error(`Upload failed for ${file.relativePath}:`, e);
    }
  }

  // Pull files from Dropbox that aren't in our tree
  let remoteEntries = [];
  try {
    remoteEntries = await dbx.listFolderRecursive(basePath || "");
  } catch (_) {}

  const localPaths = new Set(manifest.files.map(f => f.relativePath));

  for (const entry of remoteEntries) {
    if (entry.isDirectory || localPaths.has(entry.relativePath)) continue;
    if (entry.tag === "hushproject") continue;
    if (!entry.dropboxPath) continue;

    if (entry.tag === "image") {
      try {
        const finalName = await downloadImage(dbx, entry.dropboxPath, entry.name);
        await tauriInvoke("register_synced_image", {
          filename: finalName, syncFolderId: SYNC_FOLDER_ID,
          relativePath: entry.relativePath,
        });
        insertImageIntoTree(state.fileTree, finalName);
        downloaded.push(entry.relativePath);
      } catch (e) {
        console.error(`Image download failed for ${entry.relativePath}:`, e);
      }
      continue;
    }

    try {
      const content = await downloadContent(dbx, entry.dropboxPath, entry.relativePath);
      const file = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: file.id, content });
      await tauriInvoke("register_synced_file", {
        internalId: file.id, syncFolderId: SYNC_FOLDER_ID,
        relativePath: entry.relativePath, content,
      });
      insertIntoTree(state.fileTree, entry.relativePath, file.id, entry.name);
      downloaded.push(entry.relativePath);
    } catch (e) {
      console.error(`Download failed for ${entry.relativePath}:`, e);
    }
  }

  await state.saveFileTree();
  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
  return { uploaded, downloaded };
}

/**
 * Insert a downloaded file into the file tree, merging with existing
 * folders/projects (including special nodes like Inbox and Trash).
 * Creates intermediate folder nodes only if no match exists.
 * Trash is always kept as the last item.
 */
function insertIntoTree(fileTree, relativePath, fileId, displayName) {
  const parts = relativePath.split("/");
  const rawFileName = parts.pop();
  const isNotebook = rawFileName.endsWith(".hushnote");
  const fileName = rawFileName.replace(/\.(md|hushnote)$/, "");
  let current = fileTree;

  const isInboxNode = (n) => n.id === "__inbox__" || n.id?.startsWith("__inbox__:");
  const isTrashNode = (n) => n.id === "__trash__" || n.id?.startsWith("__trash__:");
  for (const dirName of parts) {
    if (!dirName) continue;
    // Match any container node by name (folder, project, desk, or any
    // non-document/notebook). Also match per-desk specials by id prefix
    // so namespaced inboxes / trashes reattach instead of spawning a
    // duplicate "Inbox" folder beside them.
    let folder = current.find(n => n.type !== "document" && n.type !== "notebook" && n.name === dirName)
      || (dirName === "Inbox" && current.find(isInboxNode))
      || (dirName === "Trash" && current.find(isTrashNode));
    if (!folder) {
      folder = {
        id: crypto.randomUUID(), type: "folder", name: dirName,
        children: [], flagged: false,
      };
      // Insert before Trash to keep Trash last
      const trashIdx = current.findIndex(n => isTrashNode(n) || n.name === "Trash");
      if (trashIdx >= 0) current.splice(trashIdx, 0, folder);
      else current.push(folder);
    }
    if (!Array.isArray(folder.children)) folder.children = [];
    current = folder.children;
  }

  // Check if a node with this fileId already exists to avoid duplicates
  if (current.some(n => n.fileId === fileId)) return;

  // Insert before Trash if we're at the top level
  const trashIdx = current.findIndex(n => isTrashNode(n) || n.name === "Trash");
  const node = {
    id: crypto.randomUUID(), type: isNotebook ? "notebook" : "document",
    name: displayName || fileName, fileId,
    children: [], flagged: false,
  };
  if (trashIdx >= 0) current.splice(trashIdx, 0, node);
  else current.push(node);
}

// ===== Ongoing Sync Operations =====

/**
 * Per-fileId upload serializer. Without this, fast autosaves (e.g. a
 * notebook drawing session that emits 2 s autosaves while each upload
 * takes >2 s) stack uploads in flight. That stack produces three
 * downstream bugs: (1) `update_sync_state` runs in completion order
 * rather than start order, leaving `last_known_rev` lagging the actual
 * Dropbox state; (2) the cursor poll then sees a "different rev" for
 * our own write and treats it as an external change → destructive
 * notebook reload; (3) network bandwidth is wasted re-uploading content
 * that's already stale. Per-file serialization fixes all three with a
 * one-slot pending queue: while one upload is in flight, the next call
 * replaces a single pending payload, and that payload fires when the
 * in-flight upload's rev has been recorded.
 */
const _inflightUploads = new Map();   // fileId → Promise
const _pendingUploads = new Map();    // fileId → { state, content }

/**
 * Push a single file's content to Dropbox after an edit.
 *
 * The cursor consumer is the only path for *pulling* remote changes, so
 * this function only handles the push half. The response's `rev` is
 * recorded as `last_known_rev` so that when the cursor delta later
 * reports our own write, echo suppression skips it instead of looping.
 *
 * If a remote change happened between our last sync and this upload,
 * our upload overwrites it. Concurrent edits from different devices are
 * recoverable from the Versions panel.
 */
export function syncFileToExternal(state, fileId, content) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return Promise.resolve();
  if (!state.settings.dropboxSyncPath) return Promise.resolve();

  // If an upload for this file is already running, stash the latest
  // content as the next-up. Repeated calls during the in-flight window
  // collapse into a single pending slot — the most recent content wins.
  if (_inflightUploads.has(fileId)) {
    _pendingUploads.set(fileId, { state, content });
    return _inflightUploads.get(fileId);
  }

  const p = _runUpload(state, fileId, content).finally(() => {
    _inflightUploads.delete(fileId);
    const pending = _pendingUploads.get(fileId);
    if (pending) {
      _pendingUploads.delete(fileId);
      // Fire the pending upload through the same path so the slot can
      // refill again if more saves arrived during this run.
      syncFileToExternal(pending.state, fileId, pending.content);
    }
  });
  _inflightUploads.set(fileId, p);
  return p;
}

async function _runUpload(state, fileId, content) {
  const dropboxPath = state.settings.dropboxSyncPath;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    if (!info) return;

    // Hash gate: skip the upload entirely when local content matches
    // what we last pushed for this file. Backstops project mode (where
    // `saveProjectContent` re-pushes every doc in the project on every
    // save) and any future caller that hands us unchanged content. The
    // cursor still has the right rev because we don't mint a new one.
    const localHash = await sha256Hex(content);
    if (localHash && info.lastSyncedHash && localHash === info.lastSyncedHash) {
      return;
    }

    const dbx = await import("./dropbox.js");
    const basePath = dropboxPath === "/" ? "" : dropboxPath;
    const fullPath = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;

    const uploadResp = await uploadContent(dbx, fullPath, content, info.relativePath);
    const uploadedAt = serverModifiedSecs(uploadResp?.server_modified)
      || Math.floor(Date.now() / 1000);
    await tauriInvoke("update_sync_state", {
      internalId: fileId,
      content,
      rev: uploadResp?.rev || "",
      syncedAt: uploadedAt,
    });

    // Stash the rev in the per-file recent-revs ring so the cursor's
    // echo-suppression survives the rev-race even when a later push
    // overwrites the SQLite `last_known_rev`.
    markOurFileRev(fileId, uploadResp?.rev || "");
  } catch (e) {
    console.error("Sync write failed:", e);
  }
}

/**
 * Accept an external change — replace internal content with external.
 */
export async function acceptExternalChange(state, internalId, content, syncedAt = null) {
  if (!IS_TAURI) return;
  try {
    await tauriInvoke("accept_external_change", { internalId, content, syncedAt });
    state.files = await tauriInvoke("list_files");
    if (state.currentFileId === internalId && state.editor) {
      state.acquirePullLock(internalId);
      try { state.editor.setContent(content); state.dirty = false; }
      finally { state.releasePullLock(); }
    } else if (state.currentNotebookFileId === internalId) {
      // Reload shapes into the open notebook canvas
      state.emit("notebook-sync-reload", content);
    }
    state.emit("files-changed");
  } catch (e) {
    state.runtime.syncPulling = false;
    console.error("Accept external change failed:", e);
  }
}

/**
 * Per-tree-node mutation propagation lives in sync-mutations.js. They're
 * re-exported here so existing callers (`state-tree.js`, sidebar, ...)
 * keep their imports working.
 */
export {
  syncRenameNode,
  syncDeleteNode,
  syncCreateNode,
  syncCreateFile,
  syncProjectOrdering,
} from "./sync-mutations.js";

/**
 * Reconcile sync state after a tree reorganization (drag-and-drop).
 */
export async function reconcileSync(state) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  const dropboxPath = state.settings.dropboxSyncPath;
  if (!dropboxPath) return;

  const dbx = await import("./dropbox.js");
  const basePath = dropboxPath === "/" ? "" : dropboxPath;

  function collectDocs(nodes) {
    const docs = [];
    for (const n of nodes) {
      if ((n.type === "document" || n.type === "notebook") && n.fileId) docs.push(n);
      if (n.children) docs.push(...collectDocs(n.children));
    }
    return docs;
  }

  const docs = collectDocs(state.fileTree);
  const manifest = buildSyncManifest(state.fileTree);
  const expectedPaths = new Map(manifest.files.filter(f => f.fileId).map(f => [f.fileId, f.relativePath]));

  for (const doc of docs) {
    const expectedPath = expectedPaths.get(doc.fileId);
    if (!expectedPath) continue;

    let info = null;
    try { info = await tauriInvoke("get_sync_file_info", { internalId: doc.fileId }); } catch (_) {}

    if (!info) {
      let content = "";
      try { const file = await tauriInvoke("load_file", { id: doc.fileId }); content = file.content || ""; } catch (_) {}
      const fullPath = basePath ? `${basePath}/${expectedPath}` : `/${expectedPath}`;
      try {
        await uploadContent(dbx, fullPath, content, expectedPath);
        await tauriInvoke("register_synced_file", {
          internalId: doc.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: expectedPath, content,
        });
      } catch (_) {}
    } else if (info.relativePath !== expectedPath) {
      const oldFull = basePath ? `${basePath}/${info.relativePath}` : `/${info.relativePath}`;
      const newFull = basePath ? `${basePath}/${expectedPath}` : `/${expectedPath}`;
      try {
        await dbx.moveEntry(oldFull, newFull);
      } catch (_) {
        // 409 = conflict (destination already exists or source missing).
        // Verify the file exists at the expected path; if so, just update the map.
        const meta = await dbx.getMetadata(newFull).catch(() => null);
        if (!meta) continue; // neither location works — skip
      }
      try {
        await tauriInvoke("rename_sync_file", {
          folderPath: "__dropbox__", oldRelative: info.relativePath,
          newRelative: expectedPath, internalId: doc.fileId,
        });
      } catch (_) {}
    }
  }

  // Refresh the projects + styles meta files on first sync after a
  // reconnect. Cheap (one upload each); ensures a brand-new device
  // ends up with `.hush/*.json` populated even if the user hasn't
  // touched anything yet this session.
  try {
    const { pushProjectsToDropbox } = await import("./project-sync.js");
    await pushProjectsToDropbox(state);
  } catch (_) {}
  try {
    const { pushStylesToDropbox } = await import("./style-sync.js");
    await pushStylesToDropbox(state);
  } catch (_) {}
}

// Note: `checkDropboxChanges` and `diffDropboxSync` were removed. They've
// been replaced by `pullDropboxCursor` in `dropbox-cursor.js` — a single
// server-side delta query that reports renames as one event with a stable
// remote_id and skips the per-file metadata fetch loop.

/**
 * Disconnect Dropbox sync. Optionally removes data from Dropbox.
 */
export async function disconnectSync(state, removeFromDropbox) {
  if (!IS_TAURI) return;

  if (removeFromDropbox && state.settings.dropboxSyncPath) {
    try {
      const dbx = await import("./dropbox.js");
      const basePath = state.settings.dropboxSyncPath === "/" ? "" : state.settings.dropboxSyncPath;
      if (basePath) await dbx.deleteEntry(basePath).catch(() => {});
    } catch (_) {}
  }

  await tauriInvoke("unregister_sync_folder", { syncFolderId: SYNC_FOLDER_ID }).catch(() => {});
  const dbx = await import("./dropbox.js");
  dbx.clearTokens();
}

/**
 * Hard-recovery: wipe every locally-stored doc, notebook, image, and
 * sync record on this device, then trigger an immediate poll so the
 * cursor reseeds from Dropbox. Settings (theme, auth tokens, dropbox
 * config, zotero, etc.) are preserved — only the file/sync state is
 * cleared. The next poll's seed treats every Dropbox entry as a
 * Created event, so `insertDocumentNode` rebuilds the tree from the
 * current Dropbox paths.
 *
 * Pre-seeds the global Inbox / Images / Trash specials so a Dropbox
 * path of `Inbox/foo.md` routes into `__inbox__` instead of creating
 * a plain folder named "Inbox". Without this, image inserts would
 * silently no-op (the image handler bails when `__images__` is
 * missing) and Inbox/Trash would lose their special behavior.
 */
export async function clearLocalAndReseed(state) {
  if (!IS_TAURI) return;
  const sp = await import("./sync-polling.js");
  sp.stopSyncPolling();
  await tauriInvoke("clear_local_data");

  // Wipe every session pointer — the files they reference are gone —
  // and clear the desk list so the wrap below picks up a fresh
  // "Personal" desk (matching what a brand-new install would build).
  state.fileTree = [];
  state.currentFileId = null;
  state.currentNotebookFileId = null;
  state.currentProjectId = null;
  state.dirty = false;
  await state.updateSettings({
    desks: [], activeDeskId: null, desksMeta: {},
    lastFileId: null, lastProjectId: null, lastNotebookId: null,
    desktopFileId: null,
  });

  // Wrap the empty tree under a default desk so reseed routes into the
  // namespaced specials (`__inbox__:<deskId>` etc) instead of the bare
  // legacy ids the seed walker would otherwise create.
  const _desks = await import("../state/state-desks.js");
  await _desks.enableDesks(state, "Personal");
  await state.saveFileTree();

  state.files = await tauriInvoke("list_files");
  state.emit("desks-changed");
  state.emit("files-changed");
  state.emit("file-opened", null);

  // Pre-count the Dropbox entries so we can drive a progress bar in
  // the settings window. One extra recursive list before the actual
  // cycle — slower than just letting the seed drain itself, but worth
  // it for the user-visible feedback. Failures are non-fatal: we just
  // run with `total = 0` and the UI shows an indeterminate state.
  let total = 0;
  try {
    const dbx = await import("./dropbox.js");
    const base = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
    const root = base === "/" ? "" : base;
    let data = await dbx.listFolderRaw(root, { recursive: true, includeDeleted: false });
    total += countSyncableEntries(data.entries);
    while (data.has_more) {
      const resp = await dbx.listFolderContinueRaw(data.cursor);
      if (!resp.ok) break;
      data = await resp.json();
      total += countSyncableEntries(data.entries);
    }
  } catch (e) { console.warn("clear: pre-count failed:", e); }
  sp.progressBegin(state, total);

  // Run one full poll cycle synchronously so we know when the cursor
  // seed has finished processing every Dropbox entry. The seed loops
  // internally on `has_more`, so a single call drains the whole listing.
  sp.startSyncPolling(state);
  try { await sp.runOneCycle(state); } catch (e) { console.warn("seed cycle failed:", e); }
  sp.progressEnd(state);

  // Now re-apply `.hush/*.json` meta in dependency order. During the
  // seed, meta files arrive interleaved with doc/notebook entries and
  // their appliers can no-op silently when the referenced folder
  // hasn't landed yet (`applyProjectsFile` skips unmatched paths,
  // `applyDesksFile` won't wrap if a desk's expected children aren't
  // there). A second pass — now that every doc/notebook is in the
  // tree — promotes folders to projects, restores desks, and so on.
  await reapplyHushMetaFiles(state);

  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
}

const META_REAPPLY_ORDER = [
  // desks first so the tree shape settles before projects look for
  // folder paths inside desks.
  ["desks.json",     "./desks-sync.js",    "applyDesksFile"],
  ["projects.json",  "./project-sync.js",  "applyProjectsFile"],
  ["panes.json",     "./pane-sync.js",     "applyPanesFile"],
  ["styles.json",    "./style-sync.js",    "applyStylesFile"],
  ["desktop.json",   "./desktop-sync.js",  "applyDesktopFile"],
];

/** Count Dropbox listing entries that the cursor consumer would
 *  actually act on (skips folders, deleted markers, hushproject
 *  stubs, and image-classification falls through to false). Used to
 *  produce a `total` for the clear/reseed progress bar. */
function countSyncableEntries(entries) {
  if (!Array.isArray(entries)) return 0;
  const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tif", "tiff"];
  let n = 0;
  for (const e of entries) {
    if (e[".tag"] !== "file") continue;
    const lower = (e.name || "").toLowerCase();
    if (lower.endsWith(".hushproject")) continue;
    if (lower.endsWith(".md") || lower.endsWith(".hushnote")) { n++; continue; }
    if (IMG_EXTS.some((x) => lower.endsWith(`.${x}`))) { n++; continue; }
    // .hush/*.json meta also goes through the consumer (onMeta).
    const path = (e.path_display || "").toLowerCase();
    if (path.includes("/.hush/") && lower.endsWith(".json")) n++;
  }
  return n;
}

async function reapplyHushMetaFiles(state) {
  const base = (state.settings?.dropboxSyncPath || "").replace(/\/+$/, "");
  const root = base === "/" ? "" : base;
  const dbx = await import("./dropbox.js");
  for (const [filename, modPath, fnName] of META_REAPPLY_ORDER) {
    try {
      const payload = await dbx.downloadFile(`${root}/.hush/${filename}`);
      if (payload == null) continue;
      const mod = await import(/* @vite-ignore */ modPath);
      const fn = mod[fnName];
      if (typeof fn === "function") await fn(state, payload);
    } catch (_) { /* not present on Dropbox or transient — skip */ }
  }
}

// Re-export image sync helpers so older imports keep resolving.
export { syncCreateImage, syncDeleteImage } from "./sync-images.js";

export { SYNC_FOLDER_ID };
