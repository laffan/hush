/**
 * Shared module-level state for the pane subsystem. Lives in its own
 * module so the sibling files (pane-content, pane-persistence, pane-drag,
 * pane-size-popover) can read and mutate the same state without circular
 * imports against pane-manager.js.
 *
 * Reads happen via the live ES module bindings (e.g. `import { panes }
 * from "./pane-state.js"` then iterate). Writes go through setters so the
 * mutation surface stays explicit.
 */

export const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export const panes = new Map();       // id → pane object — live binding (mutable Map)

export let activePaneId = null;
export function setActivePaneId(id) { activePaneId = id; }

export let zCounter = 1000;
export function bumpZCounter() { return ++zCounter; }

// Pinned (global) panes always stack above non-pinned (local) panes,
// regardless of focus order. The offset is large enough that no realistic
// number of focus events on local panes can catch up.
export const PINNED_Z_OFFSET = 100000;
export function zForPane(pane) {
  return bumpZCounter() + (pane.pinned ? PINNED_Z_OFFSET : 0);
}

export let containerEl = null;
export function setContainerEl(el) { containerEl = el; }

export let appState = null;
export function setAppState(s) { appState = s; }

export let autosaveTimer = null;
export function setAutosaveTimer(t) { autosaveTimer = t; }

export let syncing = false;
export function setSyncing(v) { syncing = v; }

// ── Lazy notebook bridge handle ──────────────────────────────────────
export let notebookBridge = null;
export async function getNotebookBridge() {
  if (!notebookBridge) {
    notebookBridge = await import("../notebook/notebook-bridge.js");
  }
  return notebookBridge;
}

// ── Geometry constants ───────────────────────────────────────────────
export const DEFAULT_WIDTH = 420;
export const DEFAULT_HEIGHT = 340;
export const MIN_WIDTH = 240;
export const MIN_HEIGHT = 60;
export const TITLEBAR_HEIGHT = 35;

/** Clamp a pane axis (x or y) so the pane is fully on-screen at the
 *  given viewport size. Falls back to 0 when the viewport is smaller
 *  than the pane — the user can still drag it. */
export function clampPaneAxis(requested, paneSize, viewportSize) {
  const max = Math.max(0, viewportSize - paneSize);
  return Math.min(max, Math.max(0, requested));
}
