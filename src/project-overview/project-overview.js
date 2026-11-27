/**
 * A project's Project Overview — the entry point every caller uses (the
 * sidebar's Overview button, the palette, the return crumb, desk
 * teardown). The Overview is the board (board/board-view.js); this
 * module only gives it the names the rest of the app calls it by.
 *
 * It was called the Project Desktop until it was renamed, and before the
 * board it was a free-form canvas. That canvas is gone. What it left on
 * this device — its thumbnail and layout cache in IndexedDB, and the
 * "has content" index in localStorage, both still under their
 * `hush-desktop` names — is cleared once, the first time an Overview is
 * opened.
 */
import { findNode } from "../state/tree-helpers.js";
import {
  isBoardOpen, boardContainerId, openProjectBoard, closeProjectBoard, flushOverviewDoc, refreshOverviewDoc,
} from "./board/board-view.js";

export const isProjectOverviewOpen = () => isBoardOpen();
export const currentProjectOverviewId = () => boardContainerId();
export const closeProjectOverview = () => closeProjectBoard();
/** The Overview Doc's unsaved edits, written now (background flush). */
export const flushProjectOverview = () => flushOverviewDoc();
/** The Overview Doc re-reads its file after a sync (desk reload). */
export const refreshProjectOverviewFromDisk = () => refreshOverviewDoc();

/** The project node an Overview belongs to, or null. */
export function findOverviewProject(state, containerId) {
  const node = findNode(state.fileTree || [], containerId);
  return node && node.type === "project" ? node : null;
}

/** Open a project's Overview. `opts.focusKey` (a fileId) scrolls to that
 *  document's row ("View in Project Overview"). */
export function openProjectOverview(state, containerId, opts = {}) {
  clearCanvasLeftovers();
  if (!findOverviewProject(state, containerId)) return;
  return openProjectBoard(state, containerId, opts);
}

let cleared = false;
function clearCanvasLeftovers() {
  if (cleared) return;
  cleared = true;
  try {
    if (localStorage.getItem("hush-desktop-cleared")) return;
    localStorage.removeItem("hush-desktop-content");
    localStorage.removeItem("hush-desktop-content-backfilled");
    localStorage.setItem("hush-desktop-cleared", "1");
  } catch { /* storage unavailable */ }
  try { indexedDB.deleteDatabase("hush-desktop"); } catch { /* unavailable */ }
}
