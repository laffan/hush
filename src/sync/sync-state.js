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
 * Inspect Dropbox before `clearLocalAndReseed`. Every top-level folder
 * is a desk — that's the new single source of truth for desk identity,
 * replacing the old `.hush/desks.json` registry that could drift out of
 * step with the folder layout.
 *
 * Returns:
 *   {
 *     totalFiles, totalImages,
 *     desks: [{ name, docs, notebooks, images, total, hasHushDesk }],
 *     rootFiles: { docs, notebooks, images, total },
 *     metaCount: number,
 *   }
 *
 * `hasHushDesk` flags desks whose folder doesn't yet carry a `.hushdesk`
 * — the reseed will mint one. Empty folders still appear as desks.
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

  // Seed the desk bucket map with every top-level folder. A folder
  // with no files inside is still a desk and should show up empty
  // rather than vanish.
  const buckets = new Map(); // name -> { docs, notebooks, images, total, hasHushDesk }
  for (const e of entries) {
    if (e[".tag"] !== "folder") continue;
    if (!e.path_display) continue;
    let rel = e.path_display;
    if (root) {
      if (rel.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = rel.slice(root.length + 1);
      else continue;
    } else {
      rel = rel.replace(/^\/+/, "");
    }
    if (!rel || rel.includes("/")) continue; // top-level only
    if (rel === ".hush" || rel.startsWith(".")) continue;
    buckets.set(rel, { docs: 0, notebooks: 0, images: 0, total: 0, hasHushDesk: false });
  }

  const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tif", "tiff"];
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

    // `.hushdesk` flag on the matching desk bucket; not counted as content.
    if (!isTopLevel && lower === ".hushdesk" && parts.length === 2) {
      const bucket = buckets.get(top);
      if (bucket) bucket.hasHushDesk = true;
      continue;
    }

    let bucket;
    if (isTopLevel) {
      bucket = rootFiles;
    } else {
      bucket = buckets.get(top) || { docs: 0, notebooks: 0, images: 0, total: 0, hasHushDesk: false };
      buckets.set(top, bucket);
    }

    if (lower.endsWith(".md")) { bucket.docs++; bucket.total++; totalFiles++; }
    else if (lower.endsWith(".hushnote")) { bucket.notebooks++; bucket.total++; totalFiles++; }
    else if (IMG_EXTS.some((x) => lower.endsWith(`.${x}`))) { bucket.images++; bucket.total++; totalImages++; }
    else continue;
  }

  const desks = [];
  for (const [name, counts] of buckets) desks.push({ name, ...counts });
  desks.sort((a, b) => a.name.localeCompare(b.name));

  return { totalFiles, totalImages, desks, rootFiles, metaCount };
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
  // Reseed in flight: any enqueue here would push half-built state up
  // to Dropbox before the cursor seed has finished rebuilding the
  // local tree to match.
  if (state.runtime?.reseedActive) return;

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
  // Reseed in flight: buildSyncManifest reads the live tree, which is
  // being rebuilt by the cursor seed. Moving entries on Dropbox to
  // match a transient mid-reseed shape is exactly the corruption the
  // reseed flag exists to prevent.
  if (state.runtime?.reseedActive) return;

  // One-shot migration off `.hush/desks.json`: if the legacy file is
  // still on Dropbox, hydrate each local desk with its id+createdAt+
  // meta from the legacy entry, push a `<DeskName>/.hushdesk` for
  // each, then delete `desks.json`. Idempotent — the next call finds
  // the legacy file gone and returns immediately.
  try {
    const { migrateFromDesksJson } = await import("./desk-sync.js");
    await migrateFromDesksJson(state);
  } catch (e) { console.warn("reconcile: desks.json migration failed:", e); }

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
  // Each desk's `.hushdesk` is pushed via createDesk / renameDesk / the
  // bootstrap pass below — see desk-sync.js. No global desks.json.
  try {
    const { pushAllDesks } = await import("./desk-sync.js");
    await pushAllDesks(state);
  } catch (e) { console.warn("reconcile: pushAllDesks failed:", e); }
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

  // 0. Re-entry guard. A second invocation while the first is still in
  //    flight (the user double-clicked "Clear and reseed", or the IPC
  //    fired twice) would race the wipe against the seed and corrupt
  //    sync.db. Refuse with a console warning so the symptom is
  //    visible — silently returning would leave the user wondering
  //    why nothing happened.
  if (state.runtime?.reseedActive) {
    console.warn("clearLocalAndReseed: already in flight, ignoring re-entry");
    return;
  }

  // 1. Raise the barrier BEFORE doing anything else. From this moment
  //    until we lower it at the very end, no autosave / op-log drain /
  //    push-meta / reconcile can run. See the gates in
  //    state-files.js#saveCurrentFile, op-log.js#drainOnce,
  //    sync-state.js#syncFileToExternal/reconcileSync, and the various
  //    push* functions in desks-sync / project-sync / style-sync /
  //    pane-persistence.
  state.runtime.reseedActive = true;
  sp.progressBegin(state, 0, "Preparing reseed…");

  // Safety net: if anything inside the try below hangs indefinitely
  // (a stalled fetch with no timeout, a never-resolving listFolder),
  // the `finally` below never fires and the barrier stays pinned —
  // every subsequent save / sync silently no-ops. After
  // RESEED_HARD_DEADLINE the watchdog lowers the barrier so user
  // edits and pending ops can resume. The reseed UI may still be
  // wedged at that point, but at least data isn't being silently
  // dropped on the floor.
  const RESEED_HARD_DEADLINE_MS = 180_000;
  const safetyTimer = setTimeout(() => {
    if (state.runtime?.reseedActive) {
      console.warn(
        "clearLocalAndReseed: hard deadline reached, lowering barrier"
      );
      state.runtime.reseedActive = false;
    }
  }, RESEED_HARD_DEADLINE_MS);

  try {
    // 2. Stop the timer and wait for any in-flight cycle to settle.
    //    `stopSyncPolling` only clears the interval; if the polling
    //    callback is mid-await we need to let it finish before wiping
    //    the database under it.
    sp.stopSyncPolling();
    sp.progressPhase(state, "Waiting for in-flight sync to settle…");
    await sp.waitForCycleIdle(2000);

    // 3. Close the open file in the editor BEFORE the wipe so the user
    //    doesn't see stale text against a freshly-pulled tree, and so
    //    a stray keystroke can't ride the editor buffer into a new file
    //    we just downloaded. `setContent("")` resets the buffer; the
    //    `markDirty` guard in state.js skips because reseedActive=true.
    if (state.editor && typeof state.editor.setContent === "function") {
      try { state.editor.setContent(""); } catch (_) {}
    }
    state.currentFileId = null;
    state.currentNotebookFileId = null;
    state.currentProjectId = null;
    state.dirty = false;

    // 4. Check whether Dropbox already has top-level desk folders. If
    //    it does, we'll let the cursor seed + onDeskMeta build the
    //    desk list from scratch instead of wrapping the empty tree
    //    under a phantom "Personal" desk that would survive and get
    //    pushed back to Dropbox as an extra entry.
    const remoteHasDesks = await dropboxHasAnyDesks(state).catch(() => false);

    await tauriInvoke("clear_local_data");

    state.fileTree = [];
    await state.updateSettings({
      desks: [], activeDeskId: null, desksMeta: {},
      lastFileId: null, lastProjectId: null, lastNotebookId: null,
    });

    if (!remoteHasDesks) {
      // No desks.json on Dropbox — wrap with a single Personal desk so
      // the cursor seed's `Inbox/Trash/Images` routing finds the
      // per-desk specials instead of inventing top-level legacy ids.
      const _desks = await import("../state/state-desks.js");
      await _desks.enableDesks(state, "Personal");
    }
    await state.saveFileTree();

    state.files = await tauriInvoke("list_files");
    state.emit("desks-changed");
    state.emit("files-changed");
    state.emit("file-opened", null);

    // 5. Pre-count Dropbox entries so the progress bar is determinate.
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

    // 6. Run one full cycle. The cursor seed loops internally on
    //    `has_more`, so a single call drains the whole listing. Push
    //    paths (reconcile, op-log drain, push-meta) are still gated by
    //    `reseedActive` so this is a pull-only pass.
    sp.startSyncPolling(state);
    try { await sp.runOneCycle(state); } catch (e) { console.warn("seed cycle failed:", e); }

    // 7. Re-apply `.hush/*.json` meta in dependency order so any meta
    //    file that landed before its referent (e.g. projects.json
    //    before the matching folder) gets a clean second pass against
    //    the now-complete tree.
    sp.progressPhase(state, "Restoring desks and projects…");
    await reapplyHushMetaFiles(state);

    // 7b. Promote any top-level folder that's still a plain "folder"
    //     node (because the cursor seed pulled files in before the
    //     desk-aware folder shape was recognised) into a desk, and
    //     ensure every desk has an Inbox / Trash skeleton + a
    //     `.hushdesk`. Then re-publish so Dropbox catches up.
    try {
      const { finalizeDesks, pushAllDesks } = await import("./desk-sync.js");
      await finalizeDesks(state);
      // Drop the reseed barrier so pushAllDesks's op-log enqueue +
      // drain can run. We leave it down through the remaining
      // bookkeeping below — the outer `finally` is now the single
      // source of truth for lowering it, instead of the previous
      // brittle `false → true → false` toggle (which left the
      // barrier pinned `true` if anything between the inner
      // `finally` and the outer `finally` hung). The polling-cycle
      // gates won't do harm here: reconcileSync has already run via
      // the seed pass, the cursor pull is idempotent, and the only
      // queued ops are our own desk metadata pushes.
      state.runtime.reseedActive = false;
      await pushAllDesks(state);
    } catch (e) { console.warn("clear: finalize desks failed:", e); }

    state.files = await tauriInvoke("list_files");
    state.emit("files-changed");
    sp.progressPhase(state, "Reseed complete.");
  } finally {
    // 8. Lower the barrier so the normal polling cycle (reconcile,
    //    op-log drain, push-meta) resumes. Idempotent — the inner
    //    block above already set it to false on the happy path, but
    //    setting again on throw / early-exit is the load-bearing
    //    guarantee.
    clearTimeout(safetyTimer);
    state.runtime.reseedActive = false;
    sp.progressEnd(state, "Reseed complete.");
  }
}

/** Check whether Dropbox has any top-level desk folder. Used by
 *  `clearLocalAndReseed` to decide whether to wrap the empty tree
 *  under a default Personal desk. A top-level folder counts as a
 *  desk regardless of whether it has a `.hushdesk` yet (the seed
 *  promotes folders to desks; `.hushdesk` files arrive as metadata
 *  via the cursor's onDeskMeta handler). Returns false on any error
 *  so the fallback path (wrap) still runs in degraded conditions. */
async function dropboxHasAnyDesks(state) {
  try {
    const dbx = await import("./dropbox.js");
    const base = (state?.settings?.dropboxSyncPath || "").replace(/\/+$/, "");
    const root = base === "/" ? "" : base;
    const data = await dbx.listFolderRaw(root, { recursive: false, includeDeleted: false });
    const entries = data?.entries || [];
    return entries.some((e) => e[".tag"] === "folder" && e.name && !e.name.startsWith("."));
  } catch (_) { return false; }
}

const META_REAPPLY_ORDER = [
  // Per-desk identity (<DeskName>/.hushdesk) is applied inline during
  // the cursor seed via `onDeskMeta`, and finalizeDesks below promotes
  // any folder without one. The global `.hush/*.json` meta files are
  // applied here in dependency order.
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
