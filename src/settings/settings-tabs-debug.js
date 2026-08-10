/**
 * Settings → Debug.
 *
 * Three sections, top to bottom:
 *
 *  - **Build Info** — what this copy of the app actually is. Both halves:
 *    the web bundle's stamp (scripts/gen-build-info.mjs) and the native
 *    binary's (src-tauri/build.rs). On iPad those come from separate
 *    build steps, and "which build were you running?" is the first
 *    question any bug report has to answer.
 *  - **Desk Storage** — what the store believes it holds, plus the repair
 *    action that puts back files a desk lost track of.
 *  - **Activity Log** — a permanent, cross-window console (see
 *    src/activity-log.js). Rows are plain selectable text so a fragment
 *    can be copied on its own; the header has a button for the lot.
 *
 * Rendering is markup-only, like the other tabs; `bindDebugTab` wires the
 * live parts after the panel is in the DOM.
 */

import { escHtml } from "./settings-tabs.js";
import { readActivityLog, clearActivityLog } from "../activity-log.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** The web bundle's own stamp. The generated module is git-ignored and
 *  written at build time, so treat a missing one as "unstamped" rather
 *  than letting the settings window fail to load. */
async function frontendBuildInfo() {
  try {
    const m = await import("../build-info.generated.js");
    return m.BUILD_INFO || null;
  } catch (_) {
    return null;
  }
}

function fmtTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function row(label, value) {
  return `
    <div class="debug-info-row">
      <span class="debug-info-label">${escHtml(label)}</span>
      <span class="debug-info-value">${escHtml(value ?? "—")}</span>
    </div>`;
}

export function renderDebugTab(settings) {
  const s = settings;
  return `
    <div class="settings-section" id="debug-build-info">
      <h2>Build Info</h2>
      <p class="settings-help">Which build this is. The web bundle and the native app are produced by separate steps — on iPad especially, a mismatch between the two explains a surprising number of "that shouldn't happen" bugs.</p>
      <div class="debug-info-grid" id="debug-build-info-body">
        <p class="settings-help">Reading build stamp…</p>
      </div>
      <div class="debug-actions">
        <button class="debug-button" id="debug-copy-build">Copy build info</button>
      </div>
    </div>

    <div class="settings-section" id="debug-desk-storage">
      <h2>Desk Storage</h2>
      <p class="settings-help">What the store believes it holds. <strong>Missing</strong> counts files a desk's index points at that aren't on disk — those are the rows that appear in the sidebar but refuse to open. <strong>Repair</strong> puts them back from retired desk folders where it can; it only ever adds files, never deletes or overwrites one.</p>
      <div class="debug-info-grid" id="debug-desk-body">
        <p class="settings-help">Reading desk store…</p>
      </div>
      <div class="debug-actions">
        <button class="debug-button" id="debug-repair-desks">Repair desk files</button>
        <button class="debug-button" id="debug-refresh-desks">Refresh</button>
      </div>
      <div class="debug-repair-result" id="debug-repair-result" hidden></div>
    </div>

    <div class="settings-section" id="debug-sync-test">
      <h2>Sync Test</h2>
      <p class="settings-help">A scripted two-device round trip for the local-desk sync. Put both machines in front of you, switch each to the <em>same</em> local desk, and press this within a few seconds of each other. Each device clears its own activity log, creates a Doc, a Notebook and a Stack tagged with its name, edits them at 20s and 50s, and watches three minutes for the other device's copies — logging every arrival with the time it took. When it finishes, copy each device's log (Activity Log → Copy all) and hand both over: side by side they show exactly which file types crossed, in which direction, and how long each took.</p>
      <p class="settings-help">The probe files are ordinary files in the desk's Inbox. Delete them when you're done.</p>
      <div class="debug-actions">
        <button class="debug-button" id="debug-sync-test-run">Run Sync Test</button>
      </div>
      <div class="debug-repair-result" id="debug-sync-test-result" hidden></div>
    </div>

    <div class="settings-section" id="debug-activity">
      <h2>Activity Log</h2>
      <p class="settings-help">Everything the app does across every desk and every window, kept between launches. Select any part of a row to copy just that, or copy the whole log at once.</p>
      <div class="debug-log-toolbar">
        <input type="search" id="debug-log-filter" class="debug-log-filter" placeholder="Filter…" />
        <select id="debug-log-level" class="debug-log-level">
          <option value="all">All levels</option>
          <option value="warn">Warnings &amp; errors</option>
          <option value="error">Errors only</option>
        </select>
        <span class="debug-log-count" id="debug-log-count"></span>
        <button class="debug-button" id="debug-log-refresh">Refresh</button>
        <button class="debug-button" id="debug-log-copy">Copy all</button>
        <button class="debug-button debug-button-danger" id="debug-log-clear">Clear</button>
      </div>
      <div class="debug-log" id="debug-log-body" tabindex="0">
        <p class="settings-help">Loading…</p>
      </div>
    </div>

    <div class="settings-section">
      <h2>Notebook</h2>
      <div class="settings-row">
        <label>Performance HUD</label>
        <input type="checkbox" id="setting-debug-perf-hud" ${s.debugPerfHud ? "checked" : ""} />
      </div>
      <p class="settings-help">Overlays live frame-rate, stall-attribution, and save-pipeline diagnostics on the notebook canvas. The HUD's <em>copy</em> button puts a plain-text report on the clipboard for sharing; <em>probe</em> and <em>tiles</em> run canvas micro-benchmarks. Applies to notebooks opened after toggling, and to the currently open notebook immediately.</p>
    </div>
  `;
}

// ===== Live wiring =====

let _entries = [];

export function bindDebugTab() {
  if (!document.getElementById("debug-activity")) return; // another tab is showing
  void paintBuildInfo();
  void paintDeskStorage();
  void refreshLog();

  on("debug-copy-build", "click", async () => {
    await copyText(await buildInfoText(), "debug-copy-build", "Copy build info");
  });
  on("debug-refresh-desks", "click", () => { void paintDeskStorage(); });
  on("debug-repair-desks", "click", runRepair);
  on("debug-log-refresh", "click", () => { void refreshLog(); });
  on("debug-log-copy", "click", async () => {
    await copyText(visibleEntries().map(asText).join("\n"), "debug-log-copy", "Copy all");
  });
  on("debug-log-clear", "click", async () => {
    if (!window.confirm("Clear the activity log? This can't be undone.")) return;
    await clearActivityLog();
    await refreshLog();
  });
  on("debug-log-filter", "input", paintLog);
  on("debug-log-level", "change", paintLog);
  on("debug-sync-test-run", "click", runSyncTest);
}

/** The test needs the editor window's AppState (the active desk, the
 *  file-creation paths), and this is a separate webview — so ask the
 *  main window to run it and report back here. */
async function runSyncTest() {
  const btn = document.getElementById("debug-sync-test-run");
  const out = document.getElementById("debug-sync-test-result");
  if (btn) { btn.disabled = true; btn.textContent = "Running… (3 min)"; }
  if (out) {
    out.hidden = false;
    out.textContent = "Started. Run it on the other device too, then leave both apps in the foreground. "
      + "The log below fills as probes are created and the other device's copies arrive.";
  }
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("hush-sync-test-start");
  } catch (e) {
    if (out) out.textContent = `Couldn't start the sync test: ${e}`;
  }
  // Keep the log in view while it runs, then hand the button back.
  const poll = setInterval(() => { void refreshLog(); }, 5000);
  setTimeout(() => {
    clearInterval(poll);
    void refreshLog();
    if (btn) { btn.disabled = false; btn.textContent = "Run Sync Test"; }
    if (out) out.textContent = "Finished. Activity Log → Copy all, on both devices.";
  }, 185_000);
}

function on(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}

async function buildInfoText() {
  const [web, native] = await Promise.all([frontendBuildInfo(), nativeBuildInfo()]);
  return [
    "Hush build info",
    `  app version   ${web?.version || native?.version || "unknown"}`,
    `  built         ${fmtTime(web?.builtAt)}`,
    `  branch        ${web?.branch || "unknown"}`,
    `  commit        ${web?.commit || "unknown"}${web?.commitSubject ? ` — ${web.commitSubject}` : ""}`,
    `  bundle mode   ${web?.mode || "unknown"}`,
    `  native built  ${fmtTime(native?.builtAt)}`,
    `  native branch ${native?.branch || "unknown"} @ ${native?.commit || "unknown"} (${native?.profile || "?"})`,
    `  platform      ${native?.target || navigator.platform || "unknown"}`,
    `  data dir      ${native?.dataDir || "unknown"}`,
  ].join("\n");
}

async function nativeBuildInfo() {
  if (!IS_TAURI) return null;
  try { return await invoke("build_info"); } catch (_) { return null; }
}

async function paintBuildInfo() {
  const host = document.getElementById("debug-build-info-body");
  if (!host) return;
  const [web, native] = await Promise.all([frontendBuildInfo(), nativeBuildInfo()]);
  const mismatch = web?.commit && native?.commit && web.commit !== native.commit;
  host.innerHTML = [
    row("Version", web?.version || native?.version),
    row("Built", fmtTime(web?.builtAt)),
    row("Branch", web?.branch),
    row("Commit", web?.commit ? `${web.commit}${web.commitSubject ? ` — ${web.commitSubject}` : ""}` : null),
    row("Bundle", web?.mode),
    native ? row("Native build", `${fmtTime(native.builtAt)} · ${native.branch || "?"}@${native.commit || "?"} (${native.profile})`) : "",
    native ? row("Platform", native.target) : "",
    native ? row("Data folder", native.dataDir) : "",
    mismatch
      ? `<p class="settings-help debug-warn">The web bundle and the native app were built from different commits (${escHtml(web.commit)} vs ${escHtml(native.commit)}). Rebuild both before chasing a bug.</p>`
      : "",
  ].join("");
}

async function paintDeskStorage() {
  const host = document.getElementById("debug-desk-body");
  if (!host) return;
  if (!IS_TAURI) { host.innerHTML = `<p class="settings-help">Only available in the app.</p>`; return; }
  let diag = null;
  try { diag = await invoke("desk_store_diagnostics"); }
  catch (e) { host.innerHTML = `<p class="settings-help debug-warn">Couldn't read the desk store: ${escHtml(String(e))}</p>`; return; }

  const desks = (diag?.desks || []).map((d) => {
    const flags = [d.local ? "local folder" : "in app data"];
    if (d.missing > 0) flags.push(`${d.missing} missing`);
    return row(d.name || d.id, `${d.indexed} file${d.indexed === 1 ? "" : "s"} · ${flags.join(" · ")}`);
  }).join("");

  const contested = (diag?.contestedFileIds || []);
  const retired = (diag?.retired || []);
  host.innerHTML = [
    desks || `<p class="settings-help">No desks on disk.</p>`,
    contested.length
      ? `<p class="settings-help debug-warn">${contested.length} file${contested.length === 1 ? " is" : "s are"} claimed by more than one desk. Saving the tree once will resolve this automatically.</p>`
      : "",
    retired.length ? row("Retired desks", `${retired.length} folder${retired.length === 1 ? "" : "s"} kept under desks/.deleted`) : "",
    diag?.staged ? row("Awaiting placement", `${diag.staged} staged file${diag.staged === 1 ? "" : "s"}`) : "",
    row("Storage folder", diag?.desksDir),
  ].join("");
}

async function runRepair() {
  const out = document.getElementById("debug-repair-result");
  const btn = document.getElementById("debug-repair-desks");
  if (!out || !IS_TAURI) return;
  out.hidden = false;
  out.textContent = "Repairing…";
  if (btn) btn.disabled = true;
  try {
    const r = await invoke("desk_repair_files");
    const summary = r.restored > 0 || r.reindexed > 0
      ? `Restored ${r.restored} file${r.restored === 1 ? "" : "s"} and re-indexed ${r.reindexed}.`
      : r.broken > 0
        ? `Found ${r.broken} file${r.broken === 1 ? "" : "s"} the tree references but nothing could recover.`
        : "Everything the tree references is present — nothing to repair.";
    out.textContent = [summary, ...(r.notes || [])].join("\n");
    await paintDeskStorage();
    await refreshLog();
  } catch (e) {
    out.textContent = `Repair failed: ${e}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshLog() {
  _entries = await readActivityLog(0);
  paintLog();
}

function visibleEntries() {
  const q = (document.getElementById("debug-log-filter")?.value || "").trim().toLowerCase();
  const level = document.getElementById("debug-log-level")?.value || "all";
  return _entries.filter((e) => {
    if (level === "error" && e.level !== "error") return false;
    if (level === "warn" && e.level !== "error" && e.level !== "warn") return false;
    if (!q) return true;
    return `${e.source} ${e.message} ${e.detail} ${e.desk} ${e.window}`.toLowerCase().includes(q);
  });
}

function asText(e) {
  const stamp = new Date(e.t).toISOString().replace("T", " ").slice(0, 23);
  const where = [e.window, e.desk].filter(Boolean).join("/");
  return `${stamp}  ${e.level.toUpperCase().padEnd(5)} [${e.source}]${where ? ` (${where})` : ""} ${e.message}${e.detail ? `  ${e.detail}` : ""}`;
}

function paintLog() {
  const host = document.getElementById("debug-log-body");
  const count = document.getElementById("debug-log-count");
  if (!host) return;
  const rows = visibleEntries();
  if (count) count.textContent = `${rows.length} of ${_entries.length}`;
  if (rows.length === 0) {
    host.innerHTML = `<p class="settings-help">${_entries.length ? "Nothing matches that filter." : "No activity recorded yet."}</p>`;
    return;
  }
  // Newest at the top: when something has just gone wrong, that's what
  // you came to read.
  host.innerHTML = rows.slice().reverse().map((e) => {
    const time = new Date(e.t).toLocaleTimeString(undefined, { hour12: false });
    const date = new Date(e.t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const where = [e.window, e.desk].filter(Boolean).join(" / ");
    return `
      <div class="debug-log-row debug-log-${escHtml(e.level)}">
        <span class="debug-log-time" title="${escHtml(date)}">${escHtml(date)} ${escHtml(time)}</span>
        <span class="debug-log-source">${escHtml(e.source)}</span>
        <span class="debug-log-message">${escHtml(e.message)}${
          where ? `<span class="debug-log-where">${escHtml(where)}</span>` : ""
        }${
          e.detail ? `<span class="debug-log-detail">${escHtml(e.detail)}</span>` : ""
        }</span>
      </div>`;
  }).join("");
}

/** Clipboard write with a short confirmation on the button itself —
 *  a toast system doesn't exist in the settings window. */
async function copyText(text, buttonId, restoreLabel) {
  const btn = document.getElementById(buttonId);
  let ok = false;
  try {
    if (IS_TAURI) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      ok = true;
    } else {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { /* give up */ }
  }
  if (btn) {
    btn.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => { btn.textContent = restoreLabel; }, 1600);
  }
}
