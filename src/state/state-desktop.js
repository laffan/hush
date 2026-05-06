/**
 * Desktop slot operations. The "desktop" is a single fileId pinned for
 * the thumbnail at the bottom of the files panel; assignment + clear
 * flow through `state.setDesktop(fileId | null)`. Cross-device sync
 * rides `.hush/desktop.json` (see `sync/desktop-sync.js`).
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function setDesktop(state, fileId) {
  const next = fileId || null;
  if ((state.settings.desktopFileId || null) === next) return;
  await state.updateSettings({ desktopFileId: next });
  state.emit("desktop-changed", next);
  if (IS_TAURI && state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    import("../sync/desktop-sync.js")
      .then(m => m.pushDesktopToDropbox(state))
      .catch(e => console.warn("desktop sync upload failed:", e));
  }
}
