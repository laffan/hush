/**
 * Sidebar progress center — manages background tasks with visual
 * progress indicators in the sidebar grip area.
 */
import { downloadZoteroReferences, clearCache as clearZoteroCache } from "../zotero.js";

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
 *  cross-window listeners (desktop Tauri settings window). */
async function broadcastProgress(msg, progress) {
  window.dispatchEvent(new CustomEvent("hush-zotero-progress", { detail: { msg, progress } }));
  if (IS_TAURI) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("hush-zotero-progress", { msg, progress });
    } catch (_) {}
  }
}
async function broadcastDone() {
  window.dispatchEvent(new CustomEvent("hush-zotero-done"));
  if (IS_TAURI) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("hush-zotero-done");
    } catch (_) {}
  }
}

/** Start a Zotero reference update in the background. */
export async function startZoteroUpdate(state) {
  if (activeTask) return; // one task at a time
  const userId = state.settings.zoteroUserId;
  const apiKey = state.settings.zoteroApiKey;
  if (!userId || !apiKey) return;
  activeTask = "zotero";
  try {
    const refs = await downloadZoteroReferences(userId, apiKey, (msg, progress) => {
      state.emit("background-task-progress", { label: "Zotero", progress });
      broadcastProgress(msg, progress);
    });
    // Persist
    if (IS_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      const data = JSON.stringify(refs);
      await invoke("save_zotero_references", { data });
      const size = new Blob([data]).size;
      state.updateSettings({
        zoteroLastUpdate: new Date().toISOString(),
        zoteroReferenceCount: refs.length,
        zoteroFileSize: size,
      });
    } else {
      localStorage.setItem("hush_zotero_references", JSON.stringify(refs));
    }
    clearZoteroCache();
    state.emit("background-task-done");
    broadcastDone();
  } catch (err) {
    console.error("Zotero update failed:", err);
    state.emit("background-task-done");
  }
}
