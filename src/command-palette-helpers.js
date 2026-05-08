/**
 * Small helpers used by the command palette. Extracted from
 * command-palette.js so that file stays under the 700-line cap.
 */
import { findNodeByFileId, findParentOfNode } from "./state/tree-helpers.js";

/** Desktop Tauri detection (iOS / iPadOS Tauri exposes a single window
 *  surface, so spawn-window commands gate on this). */
export function isDesktopTauri() {
  if (typeof window === "undefined") return false;
  if (!window.__TAURI_INTERNALS__) return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return false;
  const platform = navigator.platform || "";
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  if (/Mac/i.test(platform) && tp > 0) return false;
  return true;
}

/** Gate the "Use as note" / "Stop using as note" palette entries —
 *  `wantNote` true asks "is this doc already a note?", false asks "is
 *  it a regular doc inside a real project?". */
export function canUseAsNote(state, wantNote) {
  if (!state.currentFileId || state.currentNotebookFileId) return false;
  const n = findNodeByFileId(state.fileTree, state.currentFileId);
  if (!n || n.type !== "document") return false;
  if (wantNote) return !!n.useAsNote;
  if (n.useAsNote) return false;
  const p = findParentOfNode(state.fileTree, n.id);
  return !!p && p.type === "project" && p.id !== "__inbox__" && !p.id?.startsWith("__inbox__:");
}
