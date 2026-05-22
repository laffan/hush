/**
 * Per-document Google Doc link store. Thin JS wrapper over the four
 * Rust commands that read / write the `google_doc_links` map on
 * `AppSettings`. The map is keyed by Hush fileId; each entry is
 * `{ docId, title, linkedAt }`.
 *
 * The link state is read-through cached in `state.settings.googleDocLinks`
 * so the link bar can render synchronously off `file-opened`. Mutations
 * go through Rust (durable + saves to disk) and then refresh the cached
 * settings via `get_settings` so subsequent reads are consistent.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function refreshSettings(state) {
  if (!IS_TAURI || !state) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    state.settings = await invoke("get_settings");
    state.emit?.("settings-changed");
  } catch (e) {
    console.warn("[google-docs] refresh settings failed", e);
  }
}

export function getLink(state, fileId) {
  if (!fileId) return null;
  const links = state?.settings?.googleDocLinks;
  if (!links) return null;
  return links[fileId] || null;
}

export async function setLink(state, fileId, link) {
  if (!IS_TAURI) return;
  if (!fileId || !link?.docId) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_google_doc_link", {
    fileId,
    docId: link.docId,
    title: link.title || "Untitled",
  });
  await refreshSettings(state);
  // Mirror the change to Dropbox so other devices pick it up via
  // `.hush/gdocs.json`. Best-effort — the local set above is the
  // source of truth; the meta upload is the cross-device courier.
  try {
    const m = await import("../sync/gdocs-sync.js");
    await m.pushGoogleLinksToDropbox(state);
  } catch (e) { console.warn("[google-docs] gdocs sync push failed:", e); }
}

export async function clearLink(state, fileId) {
  if (!IS_TAURI || !fileId) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clear_google_doc_link", { fileId });
  await refreshSettings(state);
  try {
    const m = await import("../sync/gdocs-sync.js");
    await m.pushGoogleLinksToDropbox(state);
  } catch (e) { console.warn("[google-docs] gdocs sync push failed:", e); }
}

// Append to the persisted Google sync log. Used by import / push / pull
// flows so the user can see what's happened in the Settings tab.
export async function appendLog(state, message) {
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const ts = new Date().toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    await invoke("append_google_sync_log", { entry: `${ts}  ${message}` });
    // Refresh the cached settings so the Settings window picks it up
    // immediately if open.
    if (state?.settings) {
      try {
        const settings = await invoke("get_settings");
        state.settings.googleSyncLog = settings.googleSyncLog || [];
      } catch (_) {}
    }
  } catch (e) {
    console.warn("[google-docs] append log failed", e);
  }
}
