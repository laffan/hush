/**
 * The "empty Untitled" hygiene pass.
 *
 * Hush spins up a fresh doc slot in several places (a new window with no
 * file to restore, a desk with nothing in it), and when the user never
 * types into one it's pure noise: a placeholder-named, contentless doc
 * that then competes to be the "last file" on the next launch. Such docs
 * are skipped by the save / sync paths and swept at boot.
 *
 * Split out of state-files.js for the line cap.
 */

import { findNodeByFileId, removeNode } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** A doc is "empty Untitled" when it carries the placeholder name and
 *  has no actual content. */
export function isEmptyUntitled(name, content) {
  if (name && name !== "Untitled") return false;
  return !content || !content.trim();
}

/** Walk the loaded files + tree and drop any empty Untitled docs that
 *  survived a previous session. Called once during init() after the tree
 *  has been hydrated so the next "restore last file" branch never lands
 *  on a placeholder doc the user never used. */
export async function pruneEmptyUntitled(state) {
  if (!Array.isArray(state.files) || state.files.length === 0) return;
  const targets = [];
  for (const file of state.files) {
    if (!isEmptyUntitled(file?.name, file?.content)) continue;
    const node = findNodeByFileId(state.fileTree, file.id);
    targets.push({ fileId: file.id, nodeId: node?.id || null });
  }
  if (!targets.length) return;
  for (const { fileId, nodeId } of targets) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fileId }); }
      catch (e) { console.warn("prune empty Untitled failed:", e); }
    }
    if (nodeId) removeNode(state.fileTree, nodeId);
  }
  if (IS_TAURI) {
    try { state.files = await tauriInvoke("list_files"); }
    catch (_) {}
  } else {
    state.files = state.files.filter((f) => !targets.some((t) => t.fileId === f.id));
    state._saveFilesLocal();
  }
  try { await state.saveFileTree(); } catch (_) {}
}
