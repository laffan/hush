/**
 * Doc-mode snapshot tracking — extracted from state.js. The keystroke
 * counter fires every 30 dirty keystrokes; manual snapshots run on
 * demand. Notebook snapshots are driven by notebook-bridge.js, not
 * here.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** The snapshots-table key for whatever the main editor is showing.
 *  Plain docs use their fileId (the historical key, so existing
 *  snapshots keep working); projects and Local Folder docs — which
 *  previously never got Versions at all — use stable synthetic keys.
 *  Shared with versions-panel.js so browse/restore resolve the same
 *  history the auto-snapshots write. */
export function versionDocId(state) {
  if (state.currentProjectId) return `project:${state.currentProjectId}`;
  const ls = state.currentLocalSync;
  if (ls && ls.kind === "doc" && ls.folderId && ls.relPath) {
    return `localsync:${ls.folderId}:${ls.relPath}`;
  }
  return state.currentFileId || null;
}

export function trackKeystroke(state) {
  state._keystrokeCount++;
  if (state._keystrokeCount >= 30 && state.dirty) {
    state._keystrokeCount = 0;
    createAutoSnapshot(state);
  }
}

async function createAutoSnapshot(state) {
  const docId = versionDocId(state);
  if (!docId || !state.editor || state._snapshotPending) return;
  state._snapshotPending = true;
  try {
    if (IS_TAURI) await tauriInvoke("create_snapshot", { documentId: docId, content: state.editor.getContent() });
  } catch (e) { console.error("Snapshot failed:", e); }
  finally { state._snapshotPending = false; }
}

export async function createManualSnapshot(state) {
  const docId = versionDocId(state);
  if (!docId || !state.editor) return;
  if (IS_TAURI) {
    try { await tauriInvoke("create_snapshot", { documentId: docId, content: state.editor.getContent() }); }
    catch (e) { console.error("Manual snapshot failed:", e); }
  }
}
