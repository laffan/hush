/**
 * A project's Desktop — the entry point every caller uses (the sidebar's
 * Desktop button, the palette, the return crumb, desk teardown). The
 * Desktop is the board (board/board-view.js); this module only gives it
 * the names the rest of the app calls it by.
 *
 * The free-form canvas Desktop it replaced is gone. What it left on this
 * device — its thumbnail and layout cache in IndexedDB, and the
 * "has content" index in localStorage — is cleared once, the first time
 * a Desktop is opened.
 */
import { findNode } from "../state/tree-helpers.js";
import { isBoardOpen, boardContainerId, openProjectBoard, closeProjectBoard } from "./board/board-view.js";

export const isDesktopOpen = () => isBoardOpen();
export const currentDesktopContainerId = () => boardContainerId();
export const closeDesktop = () => closeProjectBoard();

/** The project node a Desktop belongs to, or null. */
export function findDesktopContainer(state, containerId) {
  const node = findNode(state.fileTree || [], containerId);
  return node && node.type === "project" ? node : null;
}

/** Open a project's Desktop. `opts.focusKey` (a fileId) scrolls to that
 *  document's row ("View in Desktop"). */
export function openDesktop(state, containerId, opts = {}) {
  clearCanvasLeftovers();
  if (!findDesktopContainer(state, containerId)) return;
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
