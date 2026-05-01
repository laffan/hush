/**
 * Desk slot operations. The "desk" is a single fileId pinned for the
 * thumbnail at the bottom of the files panel; assignment + clear flow
 * through `state.setDesk(fileId | null)`. Cross-device sync rides
 * `.hush/desk.json` (see `sync/desk-sync.js`).
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function setDesk(state, fileId) {
  const next = fileId || null;
  if ((state.settings.deskFileId || null) === next) return;
  await state.updateSettings({ deskFileId: next });
  state.emit("desk-changed", next);
  if (IS_TAURI && state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    import("../sync/desk-sync.js")
      .then(m => m.pushDeskToDropbox(state))
      .catch(e => console.warn("desk sync upload failed:", e));
  }
}
