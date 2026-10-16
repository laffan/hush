/**
 * Sidebar progress center — manages background tasks with visual
 * progress indicators in the sidebar grip area.
 */
import { updateReferences, isCancelled } from "../zotero/zotero-download.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let progressDot = null;
let progressLabel = null;
let activeTask = null;

/** Mount the progress-dot element inside the footer sync group,
 *  alongside the sync dot. Called once from sidebar.js during init. */
export function mountProgressCenter(container, state) {
  // Small text label beside the progress dot.
  progressLabel = document.createElement("div");
  progressLabel.className = "sidebar-progress-label";
  progressLabel.setAttribute("aria-hidden", "true");
  container.appendChild(progressLabel);

  // Progress ring — a small circle that fills as tasks run.
  progressDot = document.createElement("div");
  progressDot.className = "sidebar-progress-dot";
  progressDot.setAttribute("aria-hidden", "true");
  container.appendChild(progressDot);

  // Listen for task updates.
  state.on("background-task-progress", updateProgress);
  state.on("background-task-done", clearProgress);
}

function updateProgress(detail) {
  if (!progressDot || !progressLabel) return;
  const { label, progress } = detail || {};
  progressDot.classList.add("active");
  progressLabel.classList.add("active");
  progressLabel.textContent = label || "";
  // Use a conic-gradient to show a ring progress.
  const pct = Math.round((progress || 0) * 100);
  progressDot.style.setProperty("--progress", `${pct}%`);
}

function clearProgress() {
  if (!progressDot || !progressLabel) return;
  progressDot.classList.remove("active");
  progressLabel.classList.remove("active");
  progressLabel.textContent = "";
  progressDot.style.removeProperty("--progress");
  activeTask = null;
}

/** Broadcast progress to both same-window listeners (iOS modal) and
 *  cross-window listeners (desktop Tauri settings window). `kind` says
 *  which Settings → Zotero section it belongs to. */
async function broadcast(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
  if (IS_TAURI) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(name, detail);
    } catch (_) {}
  }
}

// The Cancel in Settings → Zotero reaches a download running here as
// `hush-zotero-cancel` — a window event when Settings is a modal in this
// window (iPad), a Tauri event from the settings window otherwise.
let zoteroAbort = null;
function onCancel(detail) {
  if ((detail?.kind || "references") === "references") zoteroAbort?.abort();
}
window.addEventListener("hush-zotero-cancel", (e) => onCancel(e.detail));
if (IS_TAURI) {
  import("@tauri-apps/api/event")
    .then(({ listen }) => listen("hush-zotero-cancel", (e) => onCancel(e.payload)))
    .catch(() => {});
}

/** Start a Zotero reference update in the background (the palette's
 *  "Update Zotero References"). Highlights are a download of their own,
 *  in Settings → Zotero. */
export async function startZoteroUpdate(state) {
  if (activeTask) return; // one task at a time
  const userId = state.settings.zoteroUserId;
  const apiKey = state.settings.zoteroApiKey;
  if (!userId || !apiKey) return;
  activeTask = "zotero";
  zoteroAbort = new AbortController();
  try {
    const patch = await updateReferences(userId, apiKey, {
      signal: zoteroAbort.signal,
      onProgress: (msg, progress) => {
        state.emit("background-task-progress", { label: "Zotero", progress });
        void broadcast("hush-zotero-progress", { msg, progress, kind: "references" });
      },
    });
    await state.updateSettings(patch);
    state.emit("background-task-done");
    void broadcast("hush-zotero-done", { kind: "references" });
  } catch (err) {
    const cancelled = isCancelled(err);
    if (!cancelled) console.error("Zotero update failed:", err);
    state.emit("background-task-done");
    void broadcast("hush-zotero-done", { kind: "references", cancelled, error: cancelled ? null : String(err?.message || err) });
  } finally {
    zoteroAbort = null;
  }
}
