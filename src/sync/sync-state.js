/**
 * Sync state operations — full tree sync to Dropbox.
 * Syncs all documents, folders, projects, and notebooks as a mirror backup.
 * Documents → .md files, Notebooks → .hushnote (zip) files, Projects → .hushproject (JSON) files.
 */

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

// `generateSyncPreview` and `performInitialSync` live in initial-sync.js.
// They're re-exported below for backwards-compat with the Cmd handlers
// that still import them from this module.
export { generateSyncPreview, performInitialSync } from "./initial-sync.js";

/**
 * Inspect Dropbox before `clearLocalAndReseed` so the user can see what
 * the reseed is about to pull down. Returns:
 *   {
 *     totalFiles: number,    // .md + .hushnote count
 *     totalImages: number,
 *     desks: [{ name, docs, notebooks, images, total }],   // declared in .hush/desks.json
 *     loose: [{ name, docs, notebooks, images, total }],   // top-level folders not in desks.json
 *     rootFiles: { docs, notebooks, images, total },        // files at the sync root
 *     hasDesksJson: boolean,
 *     declaredDesks: [{ id, name }],
 *     metaCount: number,
 *   }
 *
 * Empty desks declared in `desks.json` are surfaced too so an empty
 * placeholder desk doesn't silently vanish from the preview.
 */
export async function generateClearLocalPreview(state) {
  if (!IS_TAURI) return null;
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return null;

  const dbx = await import("./dropbox.js");
  const base = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
  const root = base === "/" ? "" : base;

  const entries = [];
  let data = await dbx.listFolderRaw(root, { recursive: true, includeDeleted: false });
  entries.push(...(data.entries || []));
  while (data.has_more) {
    const resp = await dbx.listFolderContinueRaw(data.cursor);
    if (!resp.ok) break;
    data = await resp.json();
    entries.push(...(data.entries || []));
  }

  let declaredDesks = [];
  let hasDesksJson = false;
  try {
    const payload = await dbx.downloadFile(`${root}/.hush/desks.json`);
    const parsed = JSON.parse(payload);
    if (parsed && parsed.format === "hush-desks" && Array.isArray(parsed.desks)) {
      hasDesksJson = true;
      declaredDesks = parsed.desks.map((d) => ({ id: d.id, name: d.name || "Untitled desk" }));
    }
  } catch (_) { /* desks.json absent — reseed will wrap loose folders under default Personal */ }

  const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tif", "tiff"];
  const buckets = new Map();
  const rootFiles = { docs: 0, notebooks: 0, images: 0, total: 0 };
  let metaCount = 0;
  let totalFiles = 0;
  let totalImages = 0;

  for (const e of entries) {
    if (e[".tag"] !== "file") continue;
    let rel = e.path_display || "";
    if (root) {
      if (rel.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = rel.slice(root.length + 1);
      else continue;
    } else {
      rel = rel.replace(/^\/+/, "");
    }
    if (!rel) continue;

    const lower = (e.name || "").toLowerCase();
    if (rel.startsWith(".hush/") && lower.endsWith(".json")) { metaCount++; continue; }
    if (lower.endsWith(".hushproject")) continue;

    const parts = rel.split("/");
    const isTopLevel = parts.length === 1;
    const top = isTopLevel ? null : parts[0];

    const bucket = isTopLevel ? rootFiles : (buckets.get(top) || { docs: 0, notebooks: 0, images: 0, total: 0 });

    if (lower.endsWith(".md")) { bucket.docs++; bucket.total++; totalFiles++; }
    else if (lower.endsWith(".hushnote")) { bucket.notebooks++; bucket.total++; totalFiles++; }
    else if (IMG_EXTS.some((x) => lower.endsWith(`.${x}`))) { bucket.images++; bucket.total++; totalImages++; }
    else continue;

    if (!isTopLevel) buckets.set(top, bucket);
  }

  const declaredNames = new Set(declaredDesks.map((d) => d.name));
  const desks = [];
  const loose = [];
  for (const [name, counts] of buckets) {
    const row = { name, ...counts };
    if (declaredNames.has(name)) desks.push(row);
    else loose.push(row);
  }
  for (const d of declaredDesks) {
    if (!desks.some((x) => x.name === d.name)) {
      desks.push({ name: d.name, docs: 0, notebooks: 0, images: 0, total: 0 });
    }
  }

  desks.sort((a, b) => a.name.localeCompare(b.name));
  loose.sort((a, b) => a.name.localeCompare(b.name));

  return {
    totalFiles, totalImages,
    desks, loose, rootFiles,
    hasDesksJson, declaredDesks, metaCount,
  };
}


// ===== Ongoing Sync Operations =====

/**
 * Push a single file's content to Dropbox after an edit by enqueuing an
 * upload op on the durable op-log. The drain worker picks up ops in
 * insertion order, so a content upload enqueued after a rename for the
 * same file literally cannot race past it — closing the
 * "title-rename produces three files" race where an autosave fired
 * mid-rename and uploaded to the pre-rename path, creating a fresh file
 * at that path on Dropbox.
 *
 * The cursor consumer is the only path for *pulling* remote changes, so
 * this function only handles the push half. The op-log's `executeUpload`
 * records the response's `rev` as `last_known_rev` so that when the
 * cursor delta later reports our own write, echo suppression skips it
 * instead of looping.
 *
 * `content` is intentionally ignored — `executeUpload` re-reads from disk
 * at drain time so the freshest content always wins. The parameter is
 * kept for caller compatibility.
 */
// eslint-disable-next-line no-unused-vars
export async function syncFileToExternal(state, fileId, content) {
  if (!IS_TAURI || !state.settings.dropboxEnabled) return;
  if (!state.settings.dropboxSyncPath) return;
  if (!fileId) return;

  try {
    // Best-effort path hint for the executor. Prefer the sync map's
    // current relative_path (which reflects any rename that already
    // drained); fall back to a tree-derived path for brand-new files
    // not yet registered. The executor re-resolves this at drain time
    // via the same logic, so a stale hint is harmless.
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId }).catch(() => null);
    let path = info?.relativePath || "";
    if (!path) {
      try {
        const { findNodeByFileId, findSyncContext } = await import("../state/tree-helpers.js");
        const node = findNodeByFileId(state.fileTree, fileId);
        const ctx = node ? findSyncContext(state.fileTree, node.id) : null;
        if (ctx?.relativePath && node) {
          const ext = node.type === "notebook" ? ".hushnote" : ".md";
          path = `${ctx.relativePath}${ext}`;
        }
      } catch (_) { /* leave path empty; executor will recompute */ }
    }

    const { enqueueUpload, triggerDrain } = await import("./op-log.js");
    await enqueueUpload({ internalId: fileId, path });
    triggerDrain(state);
  } catch (e) {
    console.error("Sync write enqueue failed:", e);
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

  // Refresh the meta files on first sync after a reconnect — but only
  // when Dropbox doesn't already have a copy. Without this guard the
  // second device to activate sync overwrites the first's `.hush/*.json`
  // with its own (less complete) state, then echo-suppresses its own
  // upload when the cursor seed fetches it back. Result: the publisher's
  // payload never reaches the consumer, and a desk Mac created looks
  // like a stray top-level folder on iPad. Push-only-if-absent is the
  // bootstrap path; subsequent edits push via createDesk / renameDesk /
  // applyDesksFile's merge-back.
  await pushMetaIfAbsent(state, dbx, basePath, ".hush/desks.json", async () => {
    const { pushDesksToDropbox } = await import("./desks-sync.js");
    return pushDesksToDropbox(state);
  });
  await pushMetaIfAbsent(state, dbx, basePath, ".hush/projects.json", async () => {
    const { pushProjectsToDropbox } = await import("./project-sync.js");
    return pushProjectsToDropbox(state);
  });
  await pushMetaIfAbsent(state, dbx, basePath, ".hush/styles.json", async () => {
    const { pushStylesToDropbox } = await import("./style-sync.js");
    return pushStylesToDropbox(state);
  });
}

async function pushMetaIfAbsent(state, dbx, basePath, relPath, pushFn) {
  try {
    const fullPath = basePath ? `${basePath}/${relPath}` : `/${relPath}`;
    const meta = await dbx.getMetadata(fullPath).catch(() => null);
    if (meta) return; // Dropbox already has it — let the cursor seed apply it.
    await pushFn();
  } catch (_) { /* push best-effort */ }
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
  sp.progressBegin(state, total, total > 0 ? `Pulling ${total} items from Dropbox…` : "Pulling items from Dropbox…");

  // Run one full poll cycle synchronously so we know when the cursor
  // seed has finished processing every Dropbox entry. The seed loops
  // internally on `has_more`, so a single call drains the whole listing.
  sp.startSyncPolling(state);
  try { await sp.runOneCycle(state); } catch (e) { console.warn("seed cycle failed:", e); }

  // Re-apply `.hush/*.json` meta in dependency order. During the
  // seed, meta files arrive interleaved with doc/notebook entries and
  // their appliers can no-op silently when the referenced folder
  // hasn't landed yet (`applyProjectsFile` skips unmatched paths,
  // `applyDesksFile` won't wrap if a desk's expected children aren't
  // there). A second pass — now that every doc/notebook is in the
  // tree — promotes folders to projects, restores desks, and so on.
  sp.progressPhase(state, "Restoring desks and projects…");
  await reapplyHushMetaFiles(state);

  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
  sp.progressEnd(state, "Reseed complete.");
}

const META_REAPPLY_ORDER = [
  // desks first so the tree shape settles before projects look for
  // folder paths inside desks.
  ["desks.json",     "./desks-sync.js",    "applyDesksFile"],
  ["projects.json",  "./project-sync.js",  "applyProjectsFile"],
  ["panes.json",     "./pane-sync.js",     "applyPanesFile"],
  ["styles.json",    "./style-sync.js",    "applyStylesFile"],
];

/** Count Dropbox listing entries that the cursor consumer would
 *  actually act on (skips folders, deleted markers, hushproject
 *  stubs, and image-classification falls through to false). Used to
 *  produce a `total` for the clear/reseed progress bar. */
export function countSyncableEntries(entries) {
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
