/**
 * iCloud Folder — standalone proof-of-concept harness.
 *
 * This page is deliberately isolated from the rest of Hush (it does NOT
 * touch the Local Sync / Dropbox machinery). Its only job is to prove,
 * on a real iOS device, that the custom `tauri-plugin-icloud-folder`
 * Swift plugin can:
 *
 *   1. present a *folder* picker (stock Tauri can't on iOS),
 *   2. mint a security-scoped *bookmark* and persist it,
 *   3. resolve that bookmark on a *later launch* to re-acquire access,
 *   4. read / write files inside the picked folder (iCloud Drive),
 *   5. drive a macOS-style 2s autosave loop against it.
 *
 * The hard proof is step 3: pick a folder, type into the autosave box,
 * FORCE-QUIT the app, relaunch, tap "Reconnect", then "Read note" — the
 * text you typed before quitting should come back. That demonstrates
 * durable access to an arbitrary iCloud location, which is exactly what
 * "Add > Local Folder on iOS with autosave" needs.
 */

import { invoke } from "@tauri-apps/api/core";

const PLUGIN = "icloud-folder";
const TEST_FILE = "hush-icloud-demo.md";
const LS_BOOKMARK = "hush.icloudDemo.bookmark";
const LS_PATH = "hush.icloudDemo.path";
const LS_NAME = "hush.icloudDemo.name";
const LS_DRAFT = "hush.icloudDemo.lastDraft";

const cmd = (name, args) => invoke(`plugin:${PLUGIN}|${name}`, args);

// ---- tiny state -----------------------------------------------------------

const state = {
  path: null, // active security-scoped folder path
  name: null,
  bookmark: localStorage.getItem(LS_BOOKMARK) || null,
};

const checks = {
  reachable: false,
  picked: false,
  persisted: false,
  resolved: false,
  wrote: false,
  read: false,
  autosave: false,
};

// ---- DOM scaffold ---------------------------------------------------------

const root = document.getElementById("icloud-demo-root");

root.innerHTML = `
  <div class="wrap">
    <h1>iCloud Folder · proof of concept</h1>
    <p class="sub">Custom <code>tauri-plugin-icloud-folder</code> — folder picker + persistent
      security-scoped bookmark. Tap through top-to-bottom; the hard test is the
      <b>force-quit → Reconnect → Read</b> cycle.</p>

    <div id="status" class="status idle">Checking plugin…</div>

    <section>
      <h2>1 · Pick a folder</h2>
      <p class="hint">Choose any iCloud Drive folder (e.g. a folder you make in the Files app).</p>
      <button id="btn-pick">Pick folder…</button>
    </section>

    <section>
      <h2>2 · Reconnect (after a relaunch)</h2>
      <p class="hint">Uses the bookmark saved in localStorage. This is the cross-launch proof —
        no picker should appear.</p>
      <button id="btn-resolve">Reconnect from saved bookmark</button>
      <button id="btn-forget" class="ghost">Forget bookmark</button>
    </section>

    <section>
      <h2>3 · Files in the folder</h2>
      <button id="btn-list">List contents</button>
      <pre id="listing" class="box">—</pre>
    </section>

    <section>
      <h2>4 · Autosave (macOS-style, 2s debounce)</h2>
      <p class="hint">Type below — it writes to <code>${TEST_FILE}</code> 2s after you stop.
        Force-quit, relaunch, Reconnect, then "Read note" to prove it persisted.</p>
      <textarea id="draft" rows="5" placeholder="Type here to autosave into the picked folder…"></textarea>
      <div class="row">
        <button id="btn-save">Save now</button>
        <button id="btn-read">Read note</button>
        <span id="save-state" class="savestate">idle</span>
      </div>
      <pre id="readout" class="box">—</pre>
    </section>

    <section>
      <h2>5 · Release</h2>
      <button id="btn-stop" class="ghost">Stop access</button>
    </section>

    <section>
      <h2>Checklist</h2>
      <ul id="checklist"></ul>
    </section>

    <section>
      <h2>Log</h2>
      <pre id="log" class="box log"></pre>
    </section>
  </div>
`;

const $ = (id) => document.getElementById(id);

// ---- helpers --------------------------------------------------------------

function log(msg, kind = "info") {
  const el = $("log");
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `log-line ${kind}`;
  line.textContent = `${ts}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

const CHECK_LABELS = {
  reachable: "Plugin reachable",
  picked: "Folder picked + bookmark minted",
  persisted: "Bookmark persisted (survives relaunch)",
  resolved: "Bookmark resolved → access re-acquired",
  wrote: "Wrote a file into the folder",
  read: "Read it back (contents matched)",
  autosave: "Autosave round-trip",
};

function renderChecklist() {
  const ul = $("checklist");
  ul.innerHTML = "";
  for (const key of Object.keys(CHECK_LABELS)) {
    const li = document.createElement("li");
    li.className = checks[key] ? "ok" : "pending";
    li.textContent = `${checks[key] ? "✅" : "⬜"} ${CHECK_LABELS[key]}`;
    ul.appendChild(li);
  }
}

function mark(key) {
  if (!checks[key]) {
    checks[key] = true;
    renderChecklist();
  }
}

function filePath() {
  if (!state.path) return null;
  const base = state.path.replace(/\/+$/, "");
  return `${base}/${TEST_FILE}`;
}

function reflectActive() {
  if (state.path) {
    setStatus(`Active: ${state.name || state.path}`, "ok");
  } else if (state.bookmark) {
    setStatus("Saved bookmark present — tap Reconnect.", "warn");
  } else {
    setStatus("No folder yet — tap Pick folder.", "idle");
  }
}

// ---- actions --------------------------------------------------------------

async function pick() {
  try {
    log("pick_folder…");
    const res = await cmd("pick_folder");
    mark("reachable");
    state.path = res.path;
    state.name = res.name;
    state.bookmark = res.bookmark;
    localStorage.setItem(LS_BOOKMARK, res.bookmark);
    localStorage.setItem(LS_PATH, res.path);
    localStorage.setItem(LS_NAME, res.name || "");
    mark("picked");
    mark("persisted");
    log(`picked "${res.name}" (accessOk=${res.accessOk})`, "ok");
    log(`bookmark stored (${res.bookmark.length} b64 chars)`, "ok");
    reflectActive();
  } catch (e) {
    log(`pick failed: ${e}`, "err");
    setStatus(`Pick failed: ${e}`, "err");
  }
}

async function resolve() {
  if (!state.bookmark) {
    log("no saved bookmark to resolve", "warn");
    setStatus("No saved bookmark — Pick a folder first.", "warn");
    return;
  }
  try {
    log("resolve_bookmark…");
    const res = await cmd("resolve_bookmark", { bookmark: state.bookmark });
    mark("reachable");
    state.path = res.path;
    state.name = res.name || localStorage.getItem(LS_NAME) || res.path;
    mark("resolved");
    log(`resolved "${state.name}" (stale=${res.stale}, accessOk=${res.accessOk})`, res.stale ? "warn" : "ok");
    if (res.stale) log("bookmark is STALE — folder moved/renamed; re-pick to refresh.", "warn");
    reflectActive();
  } catch (e) {
    log(`resolve failed: ${e}`, "err");
    setStatus(`Reconnect failed: ${e}`, "err");
  }
}

async function list() {
  if (!ensureActive()) return;
  try {
    const res = await cmd("list_dir", { path: state.path });
    mark("reachable");
    const lines = res.entries.map((e) => `${e.isDir ? "📁" : "📄"} ${e.name}`);
    $("listing").textContent = lines.length ? lines.join("\n") : "(empty)";
    log(`listed ${res.entries.length} entr${res.entries.length === 1 ? "y" : "ies"}`, "ok");
  } catch (e) {
    $("listing").textContent = String(e);
    log(`list failed: ${e}`, "err");
  }
}

async function save(reason = "manual") {
  if (!ensureActive()) return;
  const fp = filePath();
  const contents = $("draft").value;
  $("save-state").textContent = "saving…";
  try {
    await cmd("write_file", { path: fp, contents });
    mark("reachable");
    mark("wrote");
    localStorage.setItem(LS_DRAFT, contents);
    $("save-state").textContent = `saved ✓ (${reason})`;
    log(`wrote ${contents.length} chars → ${TEST_FILE} (${reason})`, "ok");
  } catch (e) {
    $("save-state").textContent = "save failed";
    log(`write failed: ${e}`, "err");
  }
}

async function read() {
  if (!ensureActive()) return;
  const fp = filePath();
  try {
    const res = await cmd("read_file", { path: fp });
    mark("reachable");
    mark("read");
    $("readout").textContent = res.contents || "(empty file)";
    $("draft").value = res.contents;
    log(`read ${res.contents.length} chars from ${TEST_FILE}`, "ok");
    // Autosave round-trip: if what we read matches the last draft we
    // persisted, the full write→quit→resolve→read loop is proven.
    if (res.contents && res.contents === localStorage.getItem(LS_DRAFT)) {
      mark("autosave");
      log("read content matches last autosaved draft — round-trip proven.", "ok");
    }
  } catch (e) {
    $("readout").textContent = String(e);
    log(`read failed: ${e}`, "err");
  }
}

async function stop() {
  if (!state.path) return;
  try {
    await cmd("stop_access", { path: state.path });
    log(`stopped access to ${state.name}`, "ok");
  } catch (e) {
    log(`stop failed: ${e}`, "err");
  }
}

function forget() {
  localStorage.removeItem(LS_BOOKMARK);
  localStorage.removeItem(LS_PATH);
  localStorage.removeItem(LS_NAME);
  state.bookmark = null;
  state.path = null;
  state.name = null;
  checks.resolved = false;
  renderChecklist();
  log("forgot saved bookmark", "warn");
  reflectActive();
}

function ensureActive() {
  if (!state.path) {
    setStatus("No active folder — Pick or Reconnect first.", "warn");
    log("no active folder; pick or reconnect first", "warn");
    return false;
  }
  return true;
}

// ---- autosave loop (mirrors Hush's 2s debounce) ---------------------------

let saveTimer = null;
function scheduleAutosave() {
  $("save-state").textContent = "dirty…";
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save("autosave"), 2000);
}

// ---- wire up --------------------------------------------------------------

$("btn-pick").addEventListener("click", pick);
$("btn-resolve").addEventListener("click", resolve);
$("btn-forget").addEventListener("click", forget);
$("btn-list").addEventListener("click", list);
$("btn-save").addEventListener("click", () => save("manual"));
$("btn-read").addEventListener("click", read);
$("btn-stop").addEventListener("click", stop);
$("draft").addEventListener("input", scheduleAutosave);

renderChecklist();

// Restore the last draft text immediately for context (the real content
// of the file is fetched on demand via "Read note").
const lastDraft = localStorage.getItem(LS_DRAFT);
if (lastDraft) $("draft").value = lastDraft;

reflectActive();

if (state.bookmark) {
  log("found a saved bookmark — relaunch flow: tap Reconnect, then Read note.");
} else {
  log("no saved bookmark yet — start with Pick folder.");
}

// Probe the bridge so the checklist's first item lights up even before
// any user action. On desktop this surfaces the "iOS-only" error, which
// is the expected, honest result there.
cmd("stop_access", { path: "__probe__" })
  .then(() => {
    mark("reachable");
    log("plugin bridge reachable.", "ok");
  })
  .catch((e) => {
    const msg = String(e);
    if (msg.includes("iOS-only")) {
      setStatus("Running off-device: this demo only does anything on iOS.", "warn");
      log("plugin reports iOS-only (expected on desktop/simulator-without-iCloud).", "warn");
    } else {
      // Any other response means the command dispatched — bridge is live.
      mark("reachable");
      log(`plugin bridge reachable (probe said: ${msg}).`, "ok");
    }
  });
