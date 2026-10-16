/**
 * Settings → Zotero: the References and Highlights downloads, each its
 * own section with its own progress bar and Cancel.
 *
 * A download's state lives here, at module level, not in the DOM: the
 * settings panel re-renders whenever any setting changes, and a download
 * running through a re-render must come back with its bar, its message
 * and its Cancel. `bindZoteroTab` is called after every render and
 * repaints whatever is running.
 *
 * The palette's "Update Zotero References" runs in the editor window
 * (sidebar/sidebar-progress.js) and reports here through
 * `hush-zotero-progress` / `hush-zotero-done`, tagged with which
 * download it is; its Cancel is sent back as `hush-zotero-cancel`.
 */

import { testZoteroConnection } from "../zotero.js";
import { updateReferences, updateHighlights, isCancelled } from "../zotero/zotero-download.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

const JOBS = { references: updateReferences, highlights: updateHighlights };

/** job → { status: "running" | "cancelled" | "failed", msg, pct,
 *  controller } — controller null for a download running in the editor
 *  window. */
const jobs = new Map();
let ctx = null; // { settings, saveSetting, render } of the latest render
let listening = false;

function elsFor(job) {
  const p = document.querySelector(`.zotero-progress[data-zotero-job="${job}"]`);
  if (!p) return null;
  return {
    p,
    fill: p.querySelector(".zotero-progress-fill"),
    text: p.querySelector(".zotero-progress-text"),
    cancel: p.querySelector(".zotero-cancel-btn"),
    btn: document.getElementById(`zotero-download-${job}`),
  };
}

function paint(job) {
  const e = elsFor(job);
  if (!e) return;
  const j = jobs.get(job);
  e.p.style.display = j ? "" : "none";
  if (!j) return;
  const running = j.status === "running";
  e.fill.style.width = `${Math.round((running ? j.pct : 0) * 100)}%`;
  e.text.textContent = j.msg || "";
  e.cancel.hidden = !running;
  e.cancel.disabled = !!j.cancelling;
  if (e.btn) e.btn.disabled = running;
}

function credentials() {
  const s = ctx?.settings || {};
  const userId = s.zoteroUserId || document.getElementById("zotero-user-id")?.value?.trim();
  const apiKey = s.zoteroApiKey || document.getElementById("zotero-api-key")?.value?.trim();
  return userId && apiKey ? { userId, apiKey } : null;
}

async function run(job) {
  if (jobs.get(job)?.status === "running") return;
  const creds = credentials();
  if (!creds) return;
  const controller = new AbortController();
  const state = { status: "running", msg: "Starting...", pct: 0, controller };
  jobs.set(job, state);
  paint(job);
  try {
    const patch = await JOBS[job](creds.userId, creds.apiKey, {
      signal: controller.signal,
      onProgress: (msg, pct) => { state.msg = msg; state.pct = pct; paint(job); },
    });
    for (const [k, v] of Object.entries(patch)) ctx.saveSetting(k, v);
    ctx.saveSetting("zoteroUserId", creds.userId);
    ctx.saveSetting("zoteroApiKey", creds.apiKey);
    jobs.delete(job);
    ctx.render();
  } catch (e) {
    jobs.set(job, isCancelled(e)
      ? { status: "cancelled", msg: "Cancelled — the previous download is unchanged." }
      : { status: "failed", msg: "Download failed: " + (e?.message || e) });
    paint(job);
  }
}

async function cancel(job) {
  const j = jobs.get(job);
  if (j?.status !== "running") return;
  j.cancelling = true;
  j.msg = "Cancelling...";
  paint(job);
  if (j.controller) { j.controller.abort(); return; }
  // Running in the editor window (the palette's update): ask it.
  window.dispatchEvent(new CustomEvent("hush-zotero-cancel", { detail: { kind: job } }));
  if (IS_TAURI) {
    try { await (await import("@tauri-apps/api/event")).emit("hush-zotero-cancel", { kind: job }); } catch (_) {}
  }
}

/** Progress from a download running in the editor window. */
function onRemoteProgress(data) {
  const { msg, progress, kind = "references" } = data || {};
  const j = jobs.get(kind);
  if (j?.controller) return; // ours — already painting
  jobs.set(kind, { status: "running", msg, pct: progress || 0, controller: null, cancelling: j?.cancelling });
  paint(kind);
}

function onRemoteDone(data) {
  const { kind = "references", cancelled = false, error = null } = data || {};
  if (jobs.get(kind)?.controller) return;
  if (cancelled || error) {
    jobs.set(kind, cancelled
      ? { status: "cancelled", msg: "Cancelled — the previous download is unchanged." }
      : { status: "failed", msg: "Download failed: " + error });
    paint(kind);
  } else {
    jobs.delete(kind);
    ctx?.render();
  }
}

function listenOnce() {
  if (listening) return;
  listening = true;
  window.addEventListener("hush-zotero-progress", (e) => onRemoteProgress(e.detail));
  window.addEventListener("hush-zotero-done", (e) => onRemoteDone(e.detail));
  if (IS_TAURI) {
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("hush-zotero-progress", (e) => onRemoteProgress(e.payload));
      listen("hush-zotero-done", (e) => onRemoteDone(e.payload));
    }).catch(() => {});
  }
}

/** Wire the Zotero tab after a render. */
export function bindZoteroTab({ settings, saveSetting, render }) {
  ctx = { settings, saveSetting, render };
  listenOnce();

  const testBtn = document.getElementById("zotero-test-btn");
  testBtn?.addEventListener("click", async () => {
    const userId = document.getElementById("zotero-user-id")?.value?.trim();
    const apiKey = document.getElementById("zotero-api-key")?.value?.trim();
    const status = document.getElementById("zotero-test-status");
    if (!userId || !apiKey) { status.textContent = "Please enter both User ID and API Key."; status.className = "zotero-status error"; return; }
    status.textContent = "Testing..."; status.className = "zotero-status";
    try {
      await testZoteroConnection(userId, apiKey);
      status.textContent = "Connected successfully!"; status.className = "zotero-status success";
      saveSetting("zoteroUserId", userId); saveSetting("zoteroApiKey", apiKey);
      for (const job of Object.keys(JOBS)) {
        const btn = document.getElementById(`zotero-download-${job}`);
        if (btn && jobs.get(job)?.status !== "running") btn.disabled = false;
      }
    } catch (e) {
      status.textContent = "Connection failed: " + e.message; status.className = "zotero-status error";
    }
  });

  for (const job of Object.keys(JOBS)) {
    document.getElementById(`zotero-download-${job}`)?.addEventListener("click", () => void run(job));
    elsFor(job)?.cancel.addEventListener("click", () => void cancel(job));
    paint(job);
  }
}
