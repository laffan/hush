/**
 * 409-conflict resolution for rev-gated uploads. Extracted from
 * `sync-state.js` to keep that file under the 700-line build cap.
 *
 * Called from `op-log.js#executeUpload` when Dropbox rejects an upload
 * because `mode: update` didn't match. The remote has a newer rev than
 * we thought — pull it down, snapshot the local copy for recovery,
 * then decide what to do:
 *
 *   - File is open in the editor or as the active notebook canvas:
 *     prompt the user. "Keep mine" re-enqueues an upload using the
 *     freshly-pulled rev; "Keep remote" applies the remote content
 *     locally; "Open Versions" applies remote and surfaces the panel.
 *   - File is not open: auto-accept remote and snapshot local.
 *
 * Either branch leaves Dropbox holding exactly one revision and the
 * local sync map up-to-date with it.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function handleUploadConflict(state, { internalId, relativePath, fullPath, localContent }) {
  if (!IS_TAURI) return;
  const dbx = await import("./dropbox.js");
  const { findNodeByFileId } = await import("../state/tree-helpers.js");

  // Fetch the remote's current state. The cursor will report this
  // eventually too, but we need rev + content immediately so the
  // conflict prompt can show it.
  let remoteMeta;
  try { remoteMeta = await dbx.getMetadata(fullPath); }
  catch (_) { remoteMeta = null; }
  if (!remoteMeta || !remoteMeta.rev) {
    // Remote disappeared (or returned no metadata). Treat as a normal
    // first-upload by clearing our rev so the next drain uses
    // overwrite mode. The user's content is preserved on this device.
    try {
      await tauriInvoke("update_sync_state", {
        internalId, content: localContent, rev: "", syncedAt: Math.floor(Date.now() / 1000),
      });
    } catch (_) {}
    return;
  }

  const isNotebook = relativePath.endsWith(".hushnote");
  let remoteContent;
  try {
    if (isNotebook) {
      const buf = await dbx.downloadBinary(fullPath);
      const { unpackNotebook } = await import("./notebook-sync.js");
      remoteContent = await unpackNotebook(new Uint8Array(buf));
    } else {
      remoteContent = await dbx.downloadFile(fullPath);
    }
  } catch (e) {
    console.warn("conflict: remote download failed, leaving op requeued:", e);
    throw e;
  }

  // Snapshot the local content unconditionally — the user can always
  // recover whichever side they didn't pick. `create_snapshot` writes
  // only to the snapshots table; it doesn't touch the live file.
  try {
    if (localContent && localContent.length > 0) {
      await tauriInvoke("create_snapshot", { documentId: internalId, content: localContent });
    }
  } catch (_) {}

  const node = findNodeByFileId(state.fileTree, internalId);
  const fileName = node?.name || relativePath.split("/").pop();
  const isOpen = state.currentFileId === internalId || state.currentNotebookFileId === internalId;

  let choice = "remote"; // default for closed files
  if (isOpen) {
    try {
      const { openSyncConflictModal } = await import("./sync-conflict-modal.js");
      const result = await openSyncConflictModal({
        fileName,
        localPreview: previewFor(localContent, isNotebook),
        remotePreview: previewFor(remoteContent, isNotebook),
        internalId,
      });
      if (result === "local" || result === "remote" || result === "versions") choice = result;
      else choice = "remote";
    } catch (e) {
      console.warn("conflict modal failed, defaulting to remote:", e);
    }
  }

  if (choice === "versions") {
    await _applyRemoteSide(state, internalId, remoteContent, remoteMeta);
    state.emit("show-versions-panel");
    return;
  }

  if (choice === "remote") {
    await _applyRemoteSide(state, internalId, remoteContent, remoteMeta);
    return;
  }

  // "local" — re-enqueue the upload, now anchored against the remote's
  // current rev so Dropbox accepts.
  await tauriInvoke("update_sync_state", {
    internalId, content: localContent, rev: remoteMeta.rev,
    syncedAt: Math.floor(Date.now() / 1000),
  });
  const { enqueueUpload, triggerDrain } = await import("./op-log.js");
  await enqueueUpload({ internalId, path: relativePath });
  triggerDrain(state);
}

async function _applyRemoteSide(state, internalId, content, remoteMeta) {
  await tauriInvoke("accept_external_change", { internalId, content, syncedAt: null });
  await tauriInvoke("update_sync_state", {
    internalId, content, rev: remoteMeta.rev || "",
    syncedAt: serverModifiedSecsFromMeta(remoteMeta),
  });
  if (state.currentFileId === internalId && state.editor) {
    state.acquirePullLock(internalId);
    try { state.editor.setContent(content); state.dirty = false; }
    finally { state.releasePullLock(); }
  }
  if (state.currentNotebookFileId === internalId) {
    state.emit("notebook-sync-reload", content);
  }
  state.files = await tauriInvoke("list_files");
  state.emit("files-changed");
}

function serverModifiedSecsFromMeta(meta) {
  if (!meta?.server_modified) return Math.floor(Date.now() / 1000);
  const t = Date.parse(meta.server_modified);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function previewFor(content, isNotebook) {
  if (typeof content !== "string") return "";
  if (isNotebook) {
    try {
      const parsed = JSON.parse(content);
      const shapes = Array.isArray(parsed?.shapes) ? parsed.shapes : (Array.isArray(parsed) ? parsed : []);
      const text = shapes
        .filter((s) => s?.type === "text" && s.text)
        .slice(0, 8)
        .map((s) => s.text)
        .join("\n---\n");
      return text || `[notebook with ${shapes.length} shapes]`;
    } catch { return "[notebook]"; }
  }
  return content;
}
