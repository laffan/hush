/**
 * Settings → Debug.
 *
 * Sections, top to bottom:
 *
 *  - **Startup Time** — where a launch's seconds actually go, native half
 *    and webview half, one row per phase (see src/startup-trace.js). First
 *    section because "why is it slow to open" is asked more often than
 *    anything else the tab answers.
 *  - **Build Info** — what this copy of the app actually is. Both halves:
 *    the web bundle's stamp (scripts/gen-build-info.mjs) and the native
 *    binary's (src-tauri/build.rs). On iPad those come from separate
 *    build steps, and "which build were you running?" is the first
 *    question any bug report has to answer.
 *  - **Desk Storage** — what the store believes it holds, plus the repair
 *    action that puts back files a desk lost track of.
 *  - **Windows & Displays** — the window registry plus this window's
 *    screen geometry (see src/window-diagnostics.js), and a button that
 *    writes both into the log. Second question of any iPad bug report.
 *  - **Activity Log** — a permanent, cross-window console (see
 *    src/activity-log.js). Rows are plain selectable text so a fragment
 *    can be copied on its own; the header has a button for the lot. The
 *    filter box takes a source name: `paste` is a full trace of an image
 *    paste, which on iPad is the only way to see one at all.
 *
 * Rendering is markup-only, like the other tabs; `bindDebugTab` wires the
 * live parts after the panel is in the DOM.
 */

import { escHtml } from "./settings-tabs.js";
import { readActivityLog, clearActivityLog, flushActivityLog } from "../activity-log.js";
import { logWindowSnapshot, readWindowGeometry } from "../window-diagnostics.js";

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
    <div class="settings-section" id="debug-startup">
      <h2>Startup Time</h2>
      <p class="settings-help">Every step a launch takes, from the moment the process starts to the moment the first surface is on screen, with what each one cost. The window is transparent until the app paints, so all of this time reads to the user as a black screen — this is the list that says which part of it to go after.</p>
      <div class="settings-row">
        <label for="setting-track-startup-timing">Track Startup processes</label>
        <input type="checkbox" id="setting-track-startup-timing" ${s.trackStartupTiming ? "checked" : ""} />
      </div>
      <div id="debug-startup-body">
        <p class="settings-help">Reading startup trace…</p>
      </div>
    </div>

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
      <p class="settings-help">A scripted two-device round trip for the local-desk sync. Put both machines in front of you, switch each to the <em>same</em> local desk, and press this within a few seconds of each other. Each device clears its own activity log, creates a Doc, a Notebook and a Stack tagged with its name, and then <strong>hands off</strong>: it waits until it has actually seen the other device's copies before sending its next edit, twice over. Every line is stamped with the time since that device started, so the two logs read side by side. It ends as soon as the last round lands — then copy both logs (Activity Log → Copy all) and hand them over.</p>
      <div class="settings-row">
        <label for="debug-sync-test-new-desk">Create a new desk for the test</label>
        <input type="checkbox" id="debug-sync-test-new-desk" />
      </div>
      <p class="settings-help">With this on, each device asks for a folder first and opens it as a desk — pick (or create) the <em>same</em> folder name on both machines. That exercises the folder-identity handshake as well as the file sync: the log records which device made the desk and which adopted the one already there.</p>
      <p class="settings-help">The probe files are ordinary files in the desk's Inbox. Delete them when you're done.</p>
      <div class="debug-actions">
        <button class="debug-button" id="debug-sync-test-run">Run Sync Test</button>
      </div>
      <div class="debug-repair-result" id="debug-sync-test-result" hidden></div>
    </div>

    <div class="settings-section" id="debug-windows">
      <h2>Windows &amp; Displays</h2>
      <p class="settings-help">Every Hush window the app currently knows about, and the shape of the screen this one is on. On iPad a window can be resized by Split View, moved to another display under Stage Manager, or suspended in the app switcher with nothing running to notice — <strong>Log a snapshot</strong> writes the numbers below into the Activity Log so a "the window went black" or "it crashed when I plugged the monitor in" report has the geometry attached to it.</p>
      <div class="debug-info-grid" id="debug-windows-body">
        <p class="settings-help">Reading windows…</p>
      </div>
      <div class="debug-actions">
        <button class="debug-button" id="debug-windows-snapshot">Log a snapshot</button>
        <button class="debug-button" id="debug-windows-copy">Copy</button>
        <button class="debug-button" id="debug-windows-refresh">Refresh</button>
      </div>
    </div>

    <div class="settings-section" id="debug-activity">
      <h2>Activity Log</h2>
      <p class="settings-help">Everything the app does across every desk and every window, kept between launches. Select any part of a row to copy just that, or copy the whole log at once. Filter by a subsystem's name to follow one thing end to end — <code>paste</code> traces an image paste from the event through the clipboard read to the file being written, which is how to find out why one didn't land.</p>
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
  void paintStartupTiming();
  void paintBuildInfo();
  void paintDeskStorage();
  void paintWindows();
  void refreshLog();

  // The checkbox's own save runs through settings-window.js#bindCheckbox;
  // this listener is the second half — switching it on asks the editor
  // window to record the launch that is already in progress, so the list
  // fills in straight away instead of demanding a relaunch first.
  on("setting-track-startup-timing", "change", onTrackStartupChanged);
  // The section's own Copy / Refresh buttons don't exist yet — they are
  // part of the body `paintStartupTiming` renders, and are wired there.
  on("debug-copy-build", "click", async () => {
    await copyText(await buildInfoText(), "debug-copy-build", "Copy build info");
  });
  on("debug-refresh-desks", "click", () => { void paintDeskStorage(); });
  on("debug-repair-desks", "click", runRepair);
  on("debug-windows-refresh", "click", () => { void paintWindows(); });
  on("debug-windows-copy", "click", async () => {
    await copyText(await windowsText(), "debug-windows-copy", "Copy");
  });
  on("debug-windows-snapshot", "click", async () => {
    logWindowSnapshot("requested from Settings → Debug", { windows: await windowList() });
    await flushActivityLog();
    await refreshLog();
    void paintWindows();
  });
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
 *  main window to run it and wait for it to say it's done. The run has
 *  no fixed length any more: it ends when the last round lands, or when
 *  a round times out. */
async function runSyncTest() {
  const btn = document.getElementById("debug-sync-test-run");
  const out = document.getElementById("debug-sync-test-result");
  const newDesk = !!document.getElementById("debug-sync-test-new-desk")?.checked;
  const poll = setInterval(() => { void refreshLog(); }, 3000);
  const finish = (message) => {
    clearInterval(poll);
    void refreshLog();
    if (btn) { btn.disabled = false; btn.textContent = "Run Sync Test"; }
    if (out) out.textContent = message;
  };
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  if (out) {
    out.hidden = false;
    out.textContent = newDesk
      ? "Started — answer the folder picker in the main window, on both devices."
      : "Started. Run it on the other device too, then leave both apps frontmost. The log below fills as the two sides hand off.";
  }
  try {
    const { emit, listen } = await import("@tauri-apps/api/event");
    const stop = await listen("hush-sync-test-done", () => {
      stop();
      finish("Finished — see RESULT at the end of the log. Activity Log → Copy all, on both devices.");
    });
    await emit("hush-sync-test-start", { newDesk });
  } catch (e) {
    finish(`Couldn't start the sync test: ${e}`);
  }
}

function on(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}

// ===== Startup Time =====
//
// The trace is recorded by the editor window (src/startup-trace.js) and
// reaches this webview through settings, because the two are separate
// pages and can't see each other's memory. `trackStartupTiming` gates the
// write, not the recording — so switching the toggle on can ask the editor
// window for the launch already in progress rather than making the user
// relaunch to see anything.

/** The trace, as last written by the editor window. */
let _startup = null;

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${Math.round(v)} ms`;
}

/** Process start → first surface on screen. Native phases run before the
 *  webview exists, so the webview's own clock only covers half of it. */
function launchTotal(t) {
  return (t?.processToWebviewMs || 0) + (t?.totalMs || 0);
}

function startupRow(name, ms, depth, total) {
  const share = total > 0 ? Math.min(100, (ms / total) * 100) : 0;
  return `
    <div class="startup-row">
      <span class="startup-row-name" style="padding-left:${depth * 14}px">${escHtml(name)}</span>
      <span class="startup-row-bar"><i style="width:${share.toFixed(2)}%"></i></span>
      <span class="startup-row-ms">${escHtml(fmtMs(ms))}</span>
    </div>`;
}

function renderStartup(t) {
  const total = launchTotal(t);
  const appMs = Math.max(0, (t.totalMs || 0) - (t.documentMs || 0) - (t.bundleMs || 0));
  const summary = [
    row("Recorded", fmtTime(t.capturedAt)),
    row("Launch → first surface", fmtMs(total)),
    row("Native launch (before the webview)", fmtMs(t.processToWebviewMs)),
    row("Document + stylesheet", fmtMs(t.documentMs)),
    row("JavaScript bundle", fmtMs(t.bundleMs)),
    row("App boot", fmtMs(appMs)),
  ].join("");
  const native = (t.native || []).map((p) => startupRow(`native · ${p.name}`, p.ms, 0, total));
  const phases = (t.phases || []).map((p) => startupRow(p.name, p.ms, p.depth || 0, total));
  const rows = native.concat(phases);
  return `
    <div class="debug-info-grid">${summary}</div>
    <div class="startup-phases">${rows.join("") || '<p class="settings-help">No phases recorded.</p>'}</div>
    <div class="debug-actions">
      <button class="debug-button" id="debug-startup-copy">Copy</button>
      <button class="debug-button" id="debug-startup-refresh">Refresh</button>
    </div>`;
}

/** Plain-text form, for pasting into a bug report. */
function startupText() {
  const t = _startup;
  if (!t) return "Hush startup: nothing recorded.";
  const lines = [
    "Hush startup trace",
    `  recorded             ${fmtTime(t.capturedAt)}`,
    `  launch → surface     ${fmtMs(launchTotal(t))}`,
    `  native launch        ${fmtMs(t.processToWebviewMs)}`,
    `  document + css       ${fmtMs(t.documentMs)}`,
    `  javascript bundle    ${fmtMs(t.bundleMs)}`,
    "",
  ];
  for (const p of t.native || []) lines.push(`  native · ${p.name}: ${fmtMs(p.ms)}`);
  for (const p of t.phases || []) {
    lines.push(`  ${"  ".repeat(p.depth || 0)}${p.name}: ${fmtMs(p.ms)}`);
  }
  return lines.join("\n");
}

async function paintStartupTiming() {
  const body = document.getElementById("debug-startup-body");
  if (!body) return;
  let settings = null;
  try {
    settings = IS_TAURI ? await invoke("get_settings") : null;
  } catch (_) { /* fall through to the off / empty state */ }
  // The checkbox, not the persisted value: this repaint can be triggered
  // by the toggle's own `change` event, which may still be racing the
  // settings write. What the user just clicked is the truth.
  const box = document.getElementById("setting-track-startup-timing");
  const tracking = box ? box.checked : !!settings?.trackStartupTiming;
  _startup = settings?.startupTimings || null;
  if (!tracking) {
    _startup = null;
    body.innerHTML = `<p class="settings-help">Off. Switch it on to see how long each step of the last launch took — the recording itself is always running, so the numbers appear immediately, without a relaunch.</p>`;
    return;
  }
  if (!_startup) {
    body.innerHTML = `<p class="settings-help">Nothing recorded yet. Relaunch Hush and come back — the next launch will be captured.</p>`;
    return;
  }
  body.innerHTML = renderStartup(_startup);
  on("debug-startup-copy", "click", async () => {
    await copyText(startupText(), "debug-startup-copy", "Copy");
  });
  on("debug-startup-refresh", "click", () => { void paintStartupTiming(); });
}

/** Toggled on: ask the editor window to write out the launch it booted
 *  from, then repaint. Toggled off: just repaint the off state. */
async function onTrackStartupChanged(e) {
  const wantsTracking = !!e.currentTarget?.checked;
  if (!wantsTracking || !IS_TAURI) { void paintStartupTiming(); return; }
  try {
    const { emit, listen } = await import("@tauri-apps/api/event");
    const stop = await listen("hush-startup-timing-captured", () => {
      stop();
      void paintStartupTiming();
    });
    await emit("hush-startup-timing-capture");
  } catch (_) { /* the settings write still landed; fall back to a repaint */ }
  // Repaint regardless — an editor window that never answers (an older
  // build, a window still booting) should still leave a readable panel.
  setTimeout(() => { void paintStartupTiming(); }, 400);
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

/** The registry's view of every live Hush window. Empty outside Tauri,
 *  and on an error — a diagnostics panel that can't read one section
 *  still has to render the rest. */
async function windowList() {
  if (!IS_TAURI) return [];
  try { return (await invoke("list_windows")) || []; }
  catch (_) { return []; }
}

/** Human-readable geometry rows, shared by the panel and the clipboard
 *  copy. Keys come straight from `readWindowGeometry` so the panel and
 *  the log lines describe the same fields under the same names. */
function geometryRows() {
  const g = readWindowGeometry();
  return [
    ["Viewport", `${g.innerWidth} × ${g.innerHeight}`],
    ["Visual viewport", g.visualWidth != null ? `${g.visualWidth} × ${g.visualHeight} @ ${g.visualScale}×` : "—"],
    ["Screen", `${g.screenWidth} × ${g.screenHeight} (available ${g.screenAvailWidth} × ${g.screenAvailHeight})`],
    ["Pixel ratio", g.dpr != null ? `${g.dpr}×` : "—"],
    ["Orientation", g.orientation || "—"],
    ["Safe area (T,R,B,L)", g.safeArea || "—"],
    ["Colour depth", g.colorDepth != null ? `${g.colorDepth}-bit` : "—"],
  ];
}

async function paintWindows() {
  const host = document.getElementById("debug-windows-body");
  if (!host) return;
  const list = await windowList();
  const windows = list.length
    ? list.map((w) => row(
        `Window ${w.number}`,
        `${w.label}${w.fileType ? ` · ${w.fileType}` : " · nothing open"}`,
      )).join("")
    : `<p class="settings-help">${IS_TAURI ? "No windows registered." : "Only available in the app."}</p>`;
  host.innerHTML = windows + geometryRows().map(([k, v]) => row(k, v)).join("");
}

async function windowsText() {
  const list = await windowList();
  return [
    "Hush windows & displays",
    ...list.map((w) => `  window ${w.number}   ${w.label}${w.fileType ? ` · ${w.fileType}` : ""}`),
    ...geometryRows().map(([k, v]) => `  ${k.padEnd(20)} ${v}`),
    `  ${"User agent".padEnd(20)} ${navigator.userAgent || "unknown"}`,
  ].join("\n");
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
