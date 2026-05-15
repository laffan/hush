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
import {
  insertDocumentNode,
  insertImageNode,
  insertExistingNode,
} from "./sync-tree-insert.js";
import { showSyncIndicator, appendSyncLog } from "./sync-feedback.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

let syncPollTimer = null;
let syncing = false;
let _state = null;

let _dropboxConnected = true;
let _healthCheckCounter = 0;
const HEALTH_CHECK_INTERVAL = 1; // safety-net poll runs every 60 s, so
                                 // one tick per safety pass is right.
let _startupReconcileDone = false;

// Longpoll loop bookkeeping. The loop runs in its own async task; we
// just hold an `active` flag and a generation counter so a stop +
// restart doesn't end up with two loops racing.
let _longpollActive = false;
let _longpollGen = 0;
const SAFETY_POLL_MS = 60_000;   // backstop in case longpoll is wedged
const LONGPOLL_TIMEOUT_S = 90;    // server-side wait per longpoll call

export function isDropboxConnected() {
  return _dropboxConnected;
}

export function startSyncPolling(state) {
  if (syncPollTimer) return;
  _state = state;
  _startupReconcileDone = false;
  // Safety-net poll. Longpoll wakes the cycle on every actual change;
  // this catches the edge case where the longpoll connection silently
  // dies (NAT timeout, sleep / wake, ISP middlebox). 60 s cadence is
  // generous — it's not the primary change-detection path.
  syncPollTimer = setInterval(() => runSyncCycle(state), SAFETY_POLL_MS);
  setTimeout(() => runSyncCycle(state), 500);
  // Kick off the longpoll loop. The loop self-feeds: each completed
  // longpoll either fires a cycle (if changes) or re-enters immediately
  // (if not), so we never hold a stale connection.
  startLongPollLoop(state);
  // Drain any ops queued while sync was paused (or by a previous session).
  import("./op-log.js").then(({ startDrainWorker }) => startDrainWorker(state));
}

export function triggerImmediateSync() {
  if (_state) runSyncCycle(_state);
}

/** Awaitable single cycle. Used by recovery flows that need to know
 *  when the cursor seed finishes processing before they can run a
 *  follow-up step (e.g. re-applying `.hush/*.json` meta files only
 *  after every doc/notebook has landed in the tree). */
export async function runOneCycle(state) {
  await runSyncCycle(state);
}

// ===== Progress reporting (used by the "Clear local versions" UI and
//       the new Force Sync flow) =====
//
// Progress events fan out via the `sync-progress` Tauri event so the
// settings window (a separate WebviewWindow) can drive a bar. The
// in-window state.emit channel keeps the legacy `clear-reseed-progress`
// name so anything still listening to it keeps working.

let _progressTotal = 0;
let _progressDone = 0;
let _progressLabel = "";

/** Begin a new progress run with `total` expected entries. Resets the
 *  counter and emits a `begin` event. */
export function progressBegin(state, total, label) {
  _progressTotal = Math.max(0, total | 0);
  _progressDone = 0;
  if (label != null) _progressLabel = label;
  _emitProgressEvent(state, "begin");
}

export function progressEnd(state, label) {
  if (label != null) _progressLabel = label;
  _emitProgressEvent(state, "end");
  _progressTotal = 0;
  _progressDone = 0;
  _progressLabel = "";
}

/** Update the human-readable phase label without resetting counts. */
export function progressPhase(state, label) {
  _progressLabel = label || "";
  _emitProgressEvent(state, "phase");
}

function _emitProgress(state) {
  if (_progressTotal <= 0) return;
  _progressDone++;
  _emitProgressEvent(state, "tick");
}

function _emitProgressEvent(state, phase) {
  const payload = { done: _progressDone, total: _progressTotal, phase, label: _progressLabel };
  state.emit("clear-reseed-progress", payload);
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    import("@tauri-apps/api/event").then((m) => {
      m.emit("clear-reseed-progress", payload);
      m.emit("sync-progress", payload);
    }).catch(() => {});
  }
}

/**
 * Manual full-cycle sync invoked from the settings window's "Force
 * sync" button. Runs the same reconcile + cursor-pull pass that the
 * 10 s timer would, but with progress events fanned out so the user
 * sees what's happening. Pre-counts Dropbox entries to drive a
 * determinate bar through the cursor-pull phase.
 */
export async function runForceSync(state) {
  if (!IS_TAURI) return { ok: false };
  if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return { ok: false };

  progressBegin(state, 0, "Scanning Dropbox…");

  let total = 0;
  try {
    const dbx = await import("./dropbox.js");
    const { countSyncableEntries } = await import("./sync-state.js");
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
  } catch (e) { console.warn("force sync: pre-count failed:", e); }

  progressPhase(state, "Reconciling local tree…");
  try {
    const { reconcileSync } = await import("./sync-state.js");
    await reconcileSync(state);
  } catch (e) { console.warn("force sync: reconcile failed:", e); }

  // Switch to a determinate run for the cursor-pull phase.
  _progressTotal = Math.max(0, total | 0);
  _progressDone = 0;
  progressPhase(state, total > 0 ? `Checking ${total} items on Dropbox…` : "Checking Dropbox for changes…");
  try { await runOneCycle(state); } catch (e) { console.warn("force sync: cycle failed:", e); }

  progressPhase(state, "Pushing pending changes…");
  try {
    const { triggerDrain } = await import("./op-log.js");
    triggerDrain(state);
  } catch (_) {}

  progressEnd(state, "Sync complete.");
  return { ok: true };
}

export function triggerFullReconcile() {
  if (!_state) return;
  runSyncCycle(_state);
}

export function stopSyncPolling() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  _longpollActive = false;
  _longpollGen++; // any in-flight loop bails when its generation mismatches.
  import("./op-log.js").then(({ stopDrainWorker }) => stopDrainWorker());
}

/**
 * Longpoll loop. Asks Dropbox's `notify.dropboxapi.com` to block until
 * it sees changes against the stored cursor (or `LONGPOLL_TIMEOUT_S`
 * elapses). On `changes: true` we run the cursor pull immediately; on
 * `changes: false` we re-enter the longpoll. Errors fall back to a
 * short sleep — the safety-net 60 s poll will catch us up.
 *
 * The loop is gated by `_longpollActive` + the generation counter. A
 * `stopSyncPolling` bumps the generation; any in-flight loop notices
 * on its next iteration and exits.
 */
async function startLongPollLoop(state) {
  if (_longpollActive) return;
  _longpollActive = true;
  const myGen = ++_longpollGen;

  // Brief warmup — let `startSyncPolling`'s initial 500 ms reconcile-
  // cycle land and persist a cursor before we ask longpoll to watch it.
  await new Promise((r) => setTimeout(r, 1500));

  while (_longpollActive && myGen === _longpollGen) {
    if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (_initialSyncBarrier || state.runtime?.reseedActive) {
      // Hold off entirely during initial sync / reseed — both manage
      // their own cursor pulls and our wake-ups would just race them.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    // Read the stored cursor; without one we can't longpoll, so fall
    // back to a short delay until `runSyncCycle` seeds a cursor.
    let cursor = null;
    try {
      const stored = await (await import("@tauri-apps/api/core")).invoke("get_dropbox_cursor", { syncFolderId: SYNC_FOLDER_ID });
      cursor = stored?.cursor || null;
    } catch (_) { cursor = null; }
    if (!cursor) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    try {
      const dbx = await import("./dropbox.js");
      const res = await dbx.listFolderLongpoll(cursor, LONGPOLL_TIMEOUT_S);
      if (myGen !== _longpollGen) break;
      if (res?.changes) {
        await runSyncCycle(state);
      }
      // Optional server-recommended backoff in seconds.
      const backoff = (res && typeof res.backoff === "number") ? Math.max(0, res.backoff) : 0;
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff * 1000));
    } catch (e) {
      // Network blip / token refresh hiccup / gateway error — sleep
      // briefly and try again. The safety-net interval still catches
      // changes while we're recovering.
      if (myGen !== _longpollGen) break;
      console.warn("longpoll error, backing off:", e?.message || e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  _longpollActive = false;
}

/** Poll the in-flight cycle flag and resolve when it's clear (or the
 *  deadline expires). Used by the reseed flow so the wipe doesn't run
 *  under a still-executing `syncDropboxCursor` that would then try to
 *  apply events against the now-empty sync map. */
export async function waitForCycleIdle(maxMs = 2000) {
  const deadline = Date.now() + Math.max(0, maxMs | 0);
  while (syncing && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ===== Initial-sync barrier =====
//
// `performInitialSync` and the cursor seed both register downloads via
// `register_synced_file_full`. If the cursor cycle starts while the
// initial sync is still in its upload phase, `find_by_remote_id` returns
// null for entries the initial sync hasn't yet downloaded — and the
// cycle dispatches `applyCreated` which creates a *second* internal
// file for the same Dropbox file. Result: two `synced_files` rows with
// the same `remote_id` and two tree nodes.
//
// The race is real because the activation flow fires `settings-changed`
// (which kicks off the cycle's 500 ms timer) BEFORE `dropbox-sync-start`
// (which runs `performInitialSync`). A barrier set by the
// dropbox-sync-start handler blocks the cycle until the initial sync
// finishes.
let _initialSyncBarrier = false;

/** Block / unblock cursor cycles AND op-log drain while
 *  `performInitialSync` is running. Call with `true` before
 *  `await performInitialSync(...)`, then `false` in a `finally`. While
 *  set, scheduled cycles are no-ops AND queued ops are held — that
 *  prevents a racy autosave from uploading content to a pre-rename
 *  path while performInitialSync is mid-collision-rename. On release
 *  we kick a fresh cycle and a drain so anything queued during the
 *  barrier window catches up using the post-rename `info.relativePath`. */
export function setInitialSyncBarrier(active) {
  _initialSyncBarrier = !!active;
  if (!active && _state) {
    // Just-cleared barrier — schedule a fresh cycle and drain. setTimeout
    // instead of immediate so the post-initial-sync state has settled.
    setTimeout(() => {
      runSyncCycle(_state);
      import("./op-log.js").then(({ triggerDrain }) => triggerDrain(_state)).catch(() => {});
    }, 100);
  }
}

/** Public predicate so op-log can ask whether the drain is currently
 *  paused for an in-flight initial sync. */
export function isInitialSyncBarrierActive() {
  return _initialSyncBarrier;
}

async function runSyncCycle(state) {
  if (syncing) return;
  if (_initialSyncBarrier) return;
  if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return;
  syncing = true;
  try {
    // Reseed in flight: skip the startup reconcile (it would push our
    // half-built tree shape) but allow the cursor pull so the seed can
    // continue feeding entries into the modal's progress meter.
    const inReseed = !!state.runtime?.reseedActive;
    if (!_startupReconcileDone && !inReseed) {
      _startupReconcileDone = true;
      const { reconcileSync } = await import("./sync-state.js");
      await reconcileSync(state);
    }

    await syncDropboxCursor(state);

    // Each safety-net poll also re-tests the connection. The longpoll
    // loop is the primary change-detection path; this catches outright
    // disconnects (token revoked, account deleted) on the slow timer.
    _healthCheckCounter++;
    if (_healthCheckCounter >= HEALTH_CHECK_INTERVAL) {
      _healthCheckCounter = 0;
      await checkDropboxHealth(state);
    }
    // Kickstart the longpoll loop if it died (e.g. the user reconnected
    // after a long offline stretch — the loop sleeps but doesn't
    // self-resurrect from offline).
    if (!_longpollActive) startLongPollLoop(state);
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

  // Each handler is wrapped in its own try/catch so one failing entry
  // (an unreadable file, a path with hostile characters, a transient
  // 5xx) doesn't kill the rest of the cursor pass. Without this, a
  // single bad file aborted the entire seed and left the tree partial.
  const handlers = {
    onCreated: async (ev) => {
      try {
        const created = await applyCreated(state, ev, dbx, invoke, downloadImage);
        if (created) {
          treeChanged = true;
          summary.created.push(ev.name);
        }
      } catch (e) { console.warn("cursor: onCreated failed:", ev.relativePath, e); }
      _emitProgress(state);
    },
    onRenamed: async (ev) => {
      try {
        await applyRenamed(state, ev, invoke, findNodeByFileId);
        treeChanged = true;
        summary.renamed++;
      } catch (e) { console.warn("cursor: onRenamed failed:", ev.newRelativePath || ev.oldRelativePath, e); }
      _emitProgress(state);
    },
    onContentChanged: async (ev) => {
      try {
        const node = findNodeByFileId(state.fileTree, ev.internalId);
        const name = node?.name || ev.relativePath;
        const applied = await applyContentChanged(state, ev, dbx, invoke);
        if (applied) summary.content.push(name);
      } catch (e) { console.warn("cursor: onContentChanged failed:", ev.relativePath, e); }
      _emitProgress(state);
    },
    onDeleted: async (ev) => {
      try {
        const node = findNodeByFileId(state.fileTree, ev.internalId);
        if (node) {
          removeNode(state.fileTree, node.id);
          treeChanged = true;
          summary.deleted++;
        }
        await invoke("delete_sync_file", { folderPath: "__dropbox__", internalId: ev.internalId })
          .catch(() => {});
      } catch (e) { console.warn("cursor: onDeleted failed:", ev.relativePath, e); }
      _emitProgress(state);
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
    onDeskMeta: async (ev) => {
      try {
        const { isOurRev } = await import("./meta-sync.js");
        if (isOurRev(ev.rev)) return;
        const payload = await dbx.downloadFile(ev.dropboxPath);
        const { applyDeskFile } = await import("./desk-sync.js");
        const result = await applyDeskFile(state, payload, ev.relativePath);
        if (result?.applied) {
          treeChanged = true;
          showSyncIndicator("pulled", `desk ${ev.relativePath.split("/")[0]}`);
        }
      } catch (e) {
        console.warn("cursor: deskmeta apply failed:", e);
      }
      _emitProgress(state);
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
    // If the cycle imported any new docs/folders, re-apply
    // `.hush/projects.json` against the now-complete tree. Without
    // this, a folder that arrives AFTER its projects.json entry
    // (common when one device promotes a folder while the other is
    // offline) stays a plain folder forever — the cursor only
    // re-fires meta when projects.json itself changes again.
    if (summary.created.length) {
      await reapplyProjectsAfterCreates(state, dbx).catch((e) =>
        console.warn("cursor: post-create projects reapply failed:", e));
    }
    updateDropboxStatus(state, true);
  } catch (e) {
    console.error("Dropbox cursor sync failed:", e);
    updateDropboxStatus(state, false);
  }
}

/** Re-download and re-apply `.hush/projects.json` against the current
 *  tree. Used when a cursor pull imported new folders that may match
 *  pending entries in the projects registry. Idempotent — entries
 *  that already match a project-typed node are no-ops. */
async function reapplyProjectsAfterCreates(state, dbx) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  const base = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
  const root = base === "/" ? "" : base;
  const path = `${root}/.hush/projects.json`;
  let payload;
  try { payload = await dbx.downloadFile(path); } catch { return; }
  if (!payload) return;
  try {
    const { applyProjectsFile } = await import("./project-sync.js");
    await applyProjectsFile(state, payload);
  } catch (_) { /* best-effort */ }
}

async function applyCreated(state, ev, dbx, invoke, downloadImage) {
  if (ev.kind === "image") {
    try {
      const finalName = await downloadImage(dbx, ev.dropboxPath, ev.name);
      await invoke("register_synced_image", {
        filename: finalName, syncFolderId: SYNC_FOLDER_ID, relativePath: ev.relativePath,
      });
      insertImageNode(state, finalName, ev.relativePath);
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
  // up locally.
  const node = findNodeByFileId(state.fileTree, ev.internalId);
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

  if (!node) return;

  // Path-aware update: when the parent path changed (cross-folder move
  // on another device), reparent the local node so `buildSyncManifest`
  // doesn't read a stale tree and have `reconcileSync` push the file
  // back to its old folder on the next cycle.
  const oldParts = ev.oldRelativePath.split("/");
  const newParts = ev.newRelativePath.split("/");
  const oldParent = oldParts.slice(0, -1).join("/");
  const newParent = newParts.slice(0, -1).join("/");
  const newName = newParts[newParts.length - 1].replace(/\.(md|hushnote)$/, "");

  if (oldParent !== newParent) {
    // Detach from current parent.
    const { removeNode } = await import("../state/tree-helpers.js");
    removeNode(state.fileTree, node.id);
    node.name = newName;
    // Re-insert under the new parent using the same desk-aware logic
    // as a fresh create event. The target parent's intermediate
    // folders are created if missing.
    insertExistingNode(state, ev.newRelativePath, node);
    return;
  }

  if (node.name !== newName) node.name = newName;
}

async function applyContentChanged(state, ev, dbx, invoke) {
  if (ev.kind === "image") return false; // images are content-immutable on rename

  // If the file is currently open (in the editor for docs, or as the
  // active notebook canvas for .hushnote), hold the pull lock across
  // the full pull (download + persist + reload). Without this, the
  // user's pre-pull buffer / mid-stroke shape can ride out the
  // download via autosave and overwrite what we just pulled.
  const isDocOpen = state.currentFileId === ev.internalId && state.editor;
  const isNotebookOpen = ev.kind === "hushnote" && state.currentNotebookFileId === ev.internalId;
  const isOpen = isDocOpen || isNotebookOpen;
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

    if (isDocOpen) {
      state.editor.setContent(content);
      // We just synced the editor's content with the remote. Clear dirty
      // so the next autosave doesn't push the same content right back.
      state.dirty = false;
    }
    // Notebooks: swap shapes in place. The pull lock is held across
    // this so a concurrent notebook autosave (2 s timer) can't fire
    // its post-reload buffer back up.
    if (isNotebookOpen) {
      state.emit("notebook-sync-reload", content);
      state.dirty = false;
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
    case "desks.json":
      // Legacy: the new schema stores desk identity in per-folder
      // .hushdesk files. The reconcile pass runs migrateFromDesksJson
      // to convert any remaining desks.json into .hushdesk files and
      // delete the legacy file. If the cursor delivers this file
      // before migration runs, ignore it — applyDeskFile will hydrate
      // each desk individually as their .hushdesk arrives.
      return null;
    default:
      return null;
  }
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

// `showSyncIndicator`, `appendSyncLog`, and the log flush timer live
// in `sync-feedback.js` so this file stays under the 700-line cap.
// They're imported at the top.
