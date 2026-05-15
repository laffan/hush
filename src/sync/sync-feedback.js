/**
 * Sync user-feedback channels: the corner toast and the persistent
 * sync log shown in Settings → Sync. Extracted from `sync-polling.js`
 * to keep that file under the 700-line build cap.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Brief corner toast that fades after ~3 s. Also appends to the
 *  persistent sync log so the settings window can review history. */
export function showSyncIndicator(direction, detail) {
  const existing = document.querySelector(".sync-indicator");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "sync-indicator";
  el.textContent = direction === "pulled" ? "Synced ↓" : "Synced ↑";
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);

  appendSyncLog(direction === "pulled" ? `Downloaded ${detail || "changes"}` : `Uploaded ${detail || "changes"}`);
}

// Log buffer + 2 s flush. Batching avoids a save_settings round-trip
// per cursor event during a busy sync burst.
let _pendingLogMessages = [];
let _logFlushTimer = null;

export function appendSyncLog(message) {
  _pendingLogMessages.push(message);
  if (_logFlushTimer) clearTimeout(_logFlushTimer);
  _logFlushTimer = setTimeout(flushSyncLog, 2000);
}

async function flushSyncLog() {
  _logFlushTimer = null;
  if (!IS_TAURI || _pendingLogMessages.length === 0) return;
  const messages = _pendingLogMessages.splice(0);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const s = await invoke("get_settings");
    const log = s.dropboxSyncLog || [];
    const now = new Date();
    const ts = now.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    for (const msg of messages) log.push(`${ts}  ${msg}`);
    if (log.length > 50) log.splice(0, log.length - 50);
    s.dropboxSyncLog = log;
    await invoke("save_settings", { settings: s });
  } catch (_) {}
}
