/**
 * Operation log: durable, ordered queue of mutations that need to be
 * replayed against Dropbox. Replaces the fire-and-forget calls that used
 * to live in `sync-mutations.js`.
 *
 * Why this exists:
 *   * Survives offline: enqueued ops persist in `sync.db` and replay on
 *     reconnect.
 *   * Idempotent: each kind's executor checks remote state and tolerates
 *     a partially-completed previous attempt without producing duplicates.
 *   * Serial: one op at a time, in insertion order — guarantees that a
 *     rename then an upload of the same file can't race.
 *
 * The op log is the *only* path mutations should take from this point
 * forward. Callers in `sync-mutations.js` enqueue and trigger the drain;
 * this module owns execution.
 */

const SYNC_FOLDER_ID = "__dropbox_sync__";
const DRAIN_INTERVAL_MS = 30000; // safety-net retry cadence

let _drainTimer = null;
let _draining = false;
let _state = null;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function dropboxBasePath(state) {
  const p = state?.settings?.dropboxSyncPath;
  if (!p || p === "/") return "";
  return p;
}

function fullDbxPath(state, relativePath) {
  const base = dropboxBasePath(state);
  return base ? `${base}/${relativePath}` : `/${relativePath}`;
}

// ===== Public API =====

export async function enqueueRename({ internalId, fromPath, toPath }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "rename",
    internalId: internalId || null,
    remoteId: null,
    path: fromPath,
    newPath: toPath,
    payload: null,
  });
}

export async function enqueueRenameDir({ fromPath, toPath }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "rename_dir",
    internalId: null,
    remoteId: null,
    path: fromPath,
    newPath: toPath,
    payload: null,
  });
}

export async function enqueueDelete({ internalId, path }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "delete",
    internalId: internalId || null,
    remoteId: null,
    path,
    newPath: null,
    payload: null,
  });
}

export async function enqueueDeleteDir({ path }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "delete_dir",
    internalId: null,
    remoteId: null,
    path,
    newPath: null,
    payload: null,
  });
}

export async function enqueueUpload({ internalId, path }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "upload",
    internalId,
    remoteId: null,
    path,
    newPath: null,
    payload: null,
  });
}

export async function enqueueCreateFolder({ path }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "create_folder",
    internalId: null,
    remoteId: null,
    path,
    newPath: null,
    payload: null,
  });
}

/// Upload a fixed payload (e.g. `.hushproject` ordering JSON) — used when
/// the content isn't backed by a FileManager file.
export async function enqueueUploadPayload({ path, payload }) {
  return tauriInvoke("enqueue_sync_op", {
    kind: "upload_payload",
    internalId: null,
    remoteId: null,
    path,
    newPath: null,
    payload,
  });
}

// ===== Drain worker lifecycle =====

export function startDrainWorker(state) {
  _state = state;
  if (_drainTimer) return;
  _drainTimer = setInterval(() => drainOnce(state), DRAIN_INTERVAL_MS);
  drainOnce(state);
}

export function stopDrainWorker() {
  if (_drainTimer) clearInterval(_drainTimer);
  _drainTimer = null;
  _state = null;
}

/// Trigger an immediate drain. Safe to call from anywhere; concurrent
/// triggers collapse into a single in-flight drain via `_draining`.
export function triggerDrain(state) {
  drainOnce(state || _state);
}

async function drainOnce(state) {
  if (_draining || !state) return;
  if (!state.settings?.dropboxEnabled || !state.settings?.dropboxSyncPath) return;
  _draining = true;
  try {
    while (true) {
      const ops = await tauriInvoke("peek_pending_ops", { limit: 1 });
      if (!ops || ops.length === 0) break;
      const op = ops[0];
      try {
        await executeOp(state, op);
        await tauriInvoke("pending_op_succeeded", { id: op.id });
      } catch (e) {
        const msg = e?.message || String(e);
        await tauriInvoke("pending_op_failed", { id: op.id, error: msg }).catch(() => {});
        // Stop draining on failure — most likely network. The interval
        // (or the next caller-triggered drain) will retry. Leaving the op
        // at the head means we don't reorder past it.
        console.warn(`op-log: ${op.kind} failed (will retry):`, msg);
        break;
      }
    }
  } finally {
    _draining = false;
  }
}

// ===== Op executors =====

async function executeOp(state, op) {
  const dbx = await import("./dropbox.js");
  switch (op.kind) {
    case "rename": return executeRename(state, op, dbx);
    case "rename_dir": return executeRenameDir(state, op, dbx);
    case "delete": return executeDelete(state, op, dbx);
    case "delete_dir": return executeDeleteDir(state, op, dbx);
    case "upload": return executeUpload(state, op, dbx);
    case "upload_payload": return executeUploadPayload(state, op, dbx);
    case "create_folder": return executeCreateFolder(state, op, dbx);
    default: throw new Error(`unknown op kind: ${op.kind}`);
  }
}

async function executeRename(state, op, dbx) {
  const fromFull = fullDbxPath(state, op.path);
  const toFull = fullDbxPath(state, op.newPath);

  // Idempotency: if the destination already exists and the source
  // doesn't, a previous attempt succeeded. Just refresh the map.
  const [destMeta, srcMeta] = await Promise.all([
    dbx.getMetadata(toFull).catch(() => null),
    dbx.getMetadata(fromFull).catch(() => null),
  ]);

  if (destMeta && !srcMeta) {
    // Move already happened.
    if (op.internalId) {
      await tauriInvoke("rename_sync_file", {
        folderPath: "__dropbox__",
        oldRelative: op.path,
        newRelative: op.newPath,
        internalId: op.internalId,
      });
    }
    return;
  }

  if (destMeta && srcMeta) {
    // Both exist — collision. Refuse to overwrite; leave for the user
    // (cursor reconciliation in stage 3 will surface this as a conflict).
    throw new Error(`rename collision: ${op.newPath} already exists`);
  }

  if (!srcMeta) {
    // Source gone, destination missing — there's nothing to do. Treat as
    // success so we don't loop forever on a nonexistent file.
    return;
  }

  await dbx.moveEntry(fromFull, toFull);
  if (op.internalId) {
    await tauriInvoke("rename_sync_file", {
      folderPath: "__dropbox__",
      oldRelative: op.path,
      newRelative: op.newPath,
      internalId: op.internalId,
    });
  }
}

async function executeRenameDir(state, op, dbx) {
  const fromFull = fullDbxPath(state, op.path);
  const toFull = fullDbxPath(state, op.newPath);

  const [destMeta, srcMeta] = await Promise.all([
    dbx.getMetadata(toFull).catch(() => null),
    dbx.getMetadata(fromFull).catch(() => null),
  ]);

  if (destMeta && !srcMeta) {
    await tauriInvoke("rename_sync_directory", {
      folderPath: "__dropbox__",
      oldRelative: op.path,
      newRelative: op.newPath,
      syncFolderId: SYNC_FOLDER_ID,
    });
    return;
  }
  if (destMeta && srcMeta) {
    throw new Error(`directory rename collision: ${op.newPath} exists`);
  }
  if (!srcMeta) return;

  await dbx.moveEntry(fromFull, toFull);
  await tauriInvoke("rename_sync_directory", {
    folderPath: "__dropbox__",
    oldRelative: op.path,
    newRelative: op.newPath,
    syncFolderId: SYNC_FOLDER_ID,
  });
}

async function executeDelete(state, op, dbx) {
  const fullPath = fullDbxPath(state, op.path);
  try {
    await dbx.deleteEntry(fullPath);
  } catch (e) {
    // If it's already gone, treat as success.
    const meta = await dbx.getMetadata(fullPath).catch(() => null);
    if (meta) throw e;
  }
  if (op.internalId) {
    await tauriInvoke("delete_sync_file", {
      folderPath: "__dropbox__",
      internalId: op.internalId,
    }).catch(() => {});
  }
}

async function executeDeleteDir(state, op, dbx) {
  const fullPath = fullDbxPath(state, op.path);
  try {
    await dbx.deleteEntry(fullPath);
  } catch (e) {
    const meta = await dbx.getMetadata(fullPath).catch(() => null);
    if (meta) throw e;
  }
  await tauriInvoke("delete_sync_directory", {
    folderPath: "__dropbox__",
    relativePath: op.path,
    syncFolderId: SYNC_FOLDER_ID,
  }).catch(() => {});
}

async function executeUpload(state, op, dbx) {
  if (!op.internalId) throw new Error("upload op missing internalId");

  // Re-read content fresh — the latest user edit always wins.
  const file = await tauriInvoke("load_file", { id: op.internalId }).catch(() => null);
  if (!file) {
    // File deleted locally before upload drained. Drop the op silently.
    return;
  }

  // Hash gate: if the disk content matches what we last synced, the op
  // is a no-op. Skip the upload to avoid minting a new Dropbox rev that
  // other devices would then pull back. The op is still considered
  // successful so it drains out of the queue.
  const { sha256Hex, markOurFileRev } = await import("./meta-sync.js");
  const info = await tauriInvoke("get_sync_file_info", { internalId: op.internalId }).catch(() => null);
  if (info && info.lastSyncedHash) {
    const hash = await sha256Hex(file.content);
    if (hash && hash === info.lastSyncedHash) return;
  }

  // Resolve the destination path at drain time, NOT enqueue time. When
  // `info` exists, its `relativePath` reflects every rename op that has
  // already drained, which is exactly the path we want to upload to.
  // Using `op.path` here would re-write content to the stale pre-rename
  // path — and since the file was just moved away by the rename, the
  // upload would create a brand-new Dropbox file at that path
  // (the "title rename produces three files" race).
  // For first-time uploads (no SQLite info yet) recompute from the live
  // tree — without this a rename that fired between `syncCreateFile`
  // enqueueing and the drain (common when first-line auto-rename catches
  // the user mid-typing) would land the file at the stale name.
  let path = info?.relativePath || op.path;
  if (!info) {
    try {
      const { findNodeByFileId, findSyncContext } = await import("../state/tree-helpers.js");
      const node = findNodeByFileId(state.fileTree, op.internalId);
      const ctx = node ? findSyncContext(state.fileTree, node.id) : null;
      if (ctx?.relativePath && node) {
        const ext = node.type === "notebook" ? ".hushnote" : ".md";
        path = `${ctx.relativePath}${ext}`;
      }
    } catch (e) { /* fall back to op.path */ }
  }

  const fullPath = fullDbxPath(state, path);
  let resp;
  if (path.endsWith(".hushnote")) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(file.content);
    resp = await dbx.uploadBinary(fullPath, zipData);
  } else {
    resp = await dbx.uploadFile(fullPath, file.content);
  }

  // Record the new rev so the cursor consumer can recognize our own
  // write and skip it instead of pulling it back.
  const remoteId = resp?.id || "";
  const rev = resp?.rev || "";
  const syncedAt = serverModifiedSecs(resp?.server_modified)
    || Math.floor(Date.now() / 1000);

  await tauriInvoke("register_synced_file_full", {
    internalId: op.internalId,
    syncFolderId: SYNC_FOLDER_ID,
    relativePath: path,
    content: file.content,
    remoteId,
    rev,
    syncedAt,
  });

  // Stash the rev in the per-file recent-revs ring so the cursor can
  // recognize the echo even after a later push has bumped the
  // single-slot SQLite `last_known_rev`.
  markOurFileRev(op.internalId, rev);
}

async function executeUploadPayload(state, op, dbx) {
  if (op.payload === null || op.payload === undefined) {
    throw new Error("upload_payload op missing payload");
  }
  const fullPath = fullDbxPath(state, op.path);
  const resp = await dbx.uploadFile(fullPath, op.payload);
  // Meta files (`.hush/*.json`) aren't tracked in `synced_files` so they
  // don't get the SQLite-backed echo suppression that user content does.
  // Stash the response rev in pane-sync's in-memory set instead so the
  // cursor consumer skips when our own upload comes back as a delta.
  if (op.path && op.path.startsWith(".hush/") && resp?.rev) {
    const { markOurRev } = await import("./pane-sync.js");
    markOurRev(resp.rev);
  }
}

function serverModifiedSecs(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

async function executeCreateFolder(state, op, dbx) {
  const fullPath = fullDbxPath(state, op.path);
  // dbx.createFolder() already swallows "already exists" conflicts.
  await dbx.createFolder(fullPath);
}
