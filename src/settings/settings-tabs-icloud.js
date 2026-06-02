/**
 * Sync > iCloud sub-tab — debug panel for the iOS iCloud-folder bridge.
 *
 * This is the (restyled) home of what began as the standalone
 * icloud-demo harness. It exercises the `tauri-plugin-icloud-folder`
 * commands directly — pick a folder, persist + resolve its
 * security-scoped bookmark, and read/write/list inside it — so the
 * bookmark mechanism that powers "Add > Local Folder on iOS" can be
 * debugged in isolation from the real Local Sync sidebar flow.
 *
 * It is intentionally independent of `sync/local-sync.js`: a failure
 * here points squarely at the plugin/bookmark layer, not at Hush's
 * mount bookkeeping. Stores its own bookmark in localStorage so it can
 * test the cross-launch resolve without touching real mounts.
 */

import { escHtml } from "./settings-tabs.js";

const TEST_FILE = "hush-icloud-debug.md";
const LS_BOOKMARK = "hush.icloudDebug.bookmark";
const LS_NAME = "hush.icloudDebug.name";

// Session state — survives panel re-renders (tab switches) but not a
// full settings-window reload.
const dbg = {
  path: null,
  name: null,
  bookmark: (typeof localStorage !== "undefined" && localStorage.getItem(LS_BOOKMARK)) || null,
  log: [],
};

async function plugin(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(`plugin:icloud-folder|${cmd}`, args);
}

function logLine(msg, kind = "info") {
  const ts = new Date().toLocaleTimeString();
  dbg.log.push({ ts, msg, kind });
  if (dbg.log.length > 200) dbg.log.shift();
  paintLog();
}

function paintLog() {
  const el = document.getElementById("icloud-dbg-log");
  if (!el) return;
  el.innerHTML = dbg.log
    .slice()
    .reverse()
    .map((l) => `<div class="sync-log-entry${l.kind === "err" ? " sync-log-entry-error" : ""}"${l.kind === "err" ? ' style="color:#d33;"' : ""}>${escHtml(`${l.ts}  ${l.msg}`)}</div>`)
    .join("");
}

function paintStatus() {
  const el = document.getElementById("icloud-dbg-status");
  if (!el) return;
  if (dbg.path) {
    el.textContent = `Active: ${dbg.name || dbg.path}`;
    el.className = "sync-info-value";
  } else if (dbg.bookmark) {
    el.textContent = "Saved bookmark present — tap Reconnect.";
    el.className = "sync-info-value";
  } else {
    el.textContent = "No folder picked yet.";
    el.className = "sync-info-value";
  }
}

function filePath() {
  if (!dbg.path) return null;
  return `${dbg.path.replace(/\/+$/, "")}/${TEST_FILE}`;
}

export function renderICloudSubTab() {
  const saved = dbg.bookmark ? "yes" : "no";
  return `
    <div class="settings-section">
      <h2>iCloud folder bridge (debug)</h2>
      <p class="settings-help">
        Exercises the iOS folder-bookmark plugin directly, independent of
        the Local Folder sidebar flow. iOS only — every action reports
        "iOS-only" on desktop. The hard test: Pick, type + Save, force-quit
        the app, relaunch, Reconnect, then Read.
      </p>
      <div class="sync-info-box">
        <div class="sync-info-row">
          <span class="sync-info-label">Status</span>
          <span class="sync-info-value" id="icloud-dbg-status">…</span>
        </div>
        <div class="sync-info-row">
          <span class="sync-info-label">Saved bookmark</span>
          <span class="sync-info-value">${saved}</span>
        </div>
      </div>
      <div class="sync-btn-row">
        <button id="icloud-dbg-pick" class="sync-action-btn">Pick folder…</button>
        <button id="icloud-dbg-resolve" class="sync-inline-btn">Reconnect</button>
        <button id="icloud-dbg-forget" class="sync-inline-btn">Forget bookmark</button>
      </div>
    </div>

    <div class="settings-section">
      <h2>Folder contents</h2>
      <div class="sync-btn-row">
        <button id="icloud-dbg-list" class="sync-inline-btn">List contents</button>
      </div>
      <div class="sync-log-box" id="icloud-dbg-listing"><div class="sync-log-empty">—</div></div>
    </div>

    <div class="settings-section">
      <h2>Read / write test (${escHtml(TEST_FILE)})</h2>
      <textarea id="icloud-dbg-draft" class="settings-input" rows="4"
        placeholder="Type, Save, force-quit, relaunch, Reconnect, Read…"></textarea>
      <div class="sync-btn-row" style="margin-top:8px;">
        <button id="icloud-dbg-save" class="sync-action-btn">Save</button>
        <button id="icloud-dbg-read" class="sync-inline-btn">Read</button>
        <button id="icloud-dbg-stop" class="sync-inline-btn">Stop access</button>
      </div>
    </div>

    <div class="settings-section">
      <h2>Log</h2>
      <div class="sync-log-box" id="icloud-dbg-log"></div>
    </div>
  `;
}

export function bindICloudSubTab() {
  const $ = (id) => document.getElementById(id);
  paintStatus();
  paintLog();

  const ensureActive = () => {
    if (!dbg.path) { logLine("no active folder — pick or reconnect first", "err"); return false; }
    return true;
  };

  $("icloud-dbg-pick")?.addEventListener("click", async () => {
    try {
      logLine("pick_folder…");
      const res = await plugin("pick_folder");
      dbg.path = res.path; dbg.name = res.name; dbg.bookmark = res.bookmark;
      localStorage.setItem(LS_BOOKMARK, res.bookmark);
      localStorage.setItem(LS_NAME, res.name || "");
      logLine(`picked "${res.name}" (accessOk=${res.accessOk})`);
      paintStatus();
    } catch (e) { logLine(`pick failed: ${e}`, "err"); }
  });

  $("icloud-dbg-resolve")?.addEventListener("click", async () => {
    if (!dbg.bookmark) { logLine("no saved bookmark", "err"); return; }
    try {
      logLine("resolve_bookmark…");
      const res = await plugin("resolve_bookmark", { bookmark: dbg.bookmark });
      dbg.path = res.path; dbg.name = res.name || localStorage.getItem(LS_NAME) || res.path;
      logLine(`resolved "${dbg.name}" (stale=${res.stale}, accessOk=${res.accessOk})`, res.stale ? "err" : "info");
      paintStatus();
    } catch (e) { logLine(`resolve failed: ${e}`, "err"); }
  });

  $("icloud-dbg-forget")?.addEventListener("click", () => {
    localStorage.removeItem(LS_BOOKMARK); localStorage.removeItem(LS_NAME);
    dbg.bookmark = null; dbg.path = null; dbg.name = null;
    logLine("forgot saved bookmark");
    paintStatus();
  });

  $("icloud-dbg-list")?.addEventListener("click", async () => {
    if (!ensureActive()) return;
    try {
      const res = await plugin("list_dir", { path: dbg.path });
      const rows = (res.entries || []).map((e) => `<div class="sync-log-entry">${e.isDir ? "📁" : "📄"} ${escHtml(e.name)}</div>`);
      $("icloud-dbg-listing").innerHTML = rows.length ? rows.join("") : `<div class="sync-log-empty">(empty)</div>`;
      logLine(`listed ${res.entries?.length || 0} entries`);
    } catch (e) { logLine(`list failed: ${e}`, "err"); }
  });

  $("icloud-dbg-save")?.addEventListener("click", async () => {
    if (!ensureActive()) return;
    try {
      await plugin("write_file", { path: filePath(), contents: $("icloud-dbg-draft").value });
      logLine("wrote " + TEST_FILE);
    } catch (e) { logLine(`write failed: ${e}`, "err"); }
  });

  $("icloud-dbg-read")?.addEventListener("click", async () => {
    if (!ensureActive()) return;
    try {
      const res = await plugin("read_file", { path: filePath() });
      $("icloud-dbg-draft").value = res?.contents ?? "";
      logLine(`read ${(res?.contents || "").length} chars`);
    } catch (e) { logLine(`read failed: ${e}`, "err"); }
  });

  $("icloud-dbg-stop")?.addEventListener("click", async () => {
    if (!dbg.path) return;
    try { await plugin("stop_access", { path: dbg.path }); logLine("stopped access"); }
    catch (e) { logLine(`stop failed: ${e}`, "err"); }
  });
}
