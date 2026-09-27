/**
 * The "Created …" line under the Versions modal's snapshot list.
 *
 * The date comes from the tree node's `createdAt` (epoch seconds, stamped
 * when the node is made — see `TreeNode.created_at` in wire.rs). The
 * file's own birth time is no use: every save is tmp + rename, so the
 * inode is only as old as the last write. Files that predate the stamp
 * (and Local Folder docs, which have no tree node) fall back to the
 * oldest snapshot, worded as the bound it is rather than as the date.
 */

import { findNode, findNodeByFileId } from "../state/tree-helpers.js";

function activeNode(state) {
  const tree = state.fileTree;
  if (!tree) return null;
  if (state.currentNotebookFileId) return findNodeByFileId(tree, state.currentNotebookFileId);
  if (state.currentProjectId) return findNode(tree, state.currentProjectId);
  if (state.currentLocalSync) return null;
  return state.currentFileId ? findNodeByFileId(tree, state.currentFileId) : null;
}

function formatDateTime(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const day = date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

/** The note element, or null when there is nothing to say. `snapshots`
 *  is the full, unfiltered list — the fallback wants the oldest one
 *  whatever the search box holds. */
export function buildCreatedNote(state, snapshots) {
  const createdAt = Number(activeNode(state)?.createdAt) || 0;
  let text = "";
  if (createdAt > 0) {
    text = `Created ${formatDateTime(createdAt)}`;
  } else if (snapshots && snapshots.length) {
    const oldest = Math.min(...snapshots.map((s) => s.createdAt));
    text = `Created on or before ${formatDateTime(oldest)}`;
  }
  if (!text) return null;
  const el = document.createElement("div");
  el.className = "versions-created-note";
  el.textContent = text;
  return el;
}
