/**
 * Locked-style lookup for panes — extracted from pane-content.js to
 * keep that file under the repo's 700-line cap. Walks the file tree
 * for the pane's fileId and returns its `lockedStyleId`, if any.
 * Shared by the pane load path and pane-theme-sync.
 */
import { appState } from "./pane-state.js";

export function findLockedStyleForFile(fileId) {
  if (!fileId || !appState || !appState.fileTree) return null;
  function walk(nodes) {
    for (const n of nodes) {
      if (n.fileId === fileId) return n.lockedStyleId || null;
      if (n.children) {
        const r = walk(n.children);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }
  const v = walk(appState.fileTree);
  return v || null;
}
