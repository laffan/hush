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
 *  has no actual content. `content` must be the real body — a caller that
 *  doesn't have it (the library listing carries none for notebooks and
 *  stacks) must not ask, or it will get `true` for a file full of work. */
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
    // Documents only, and only when we are actually holding the body.
    // The listing carries `content: null` for notebooks and stacks (see
    // `FileManager::list_files`), and a null body reads as "empty" — an
    // untitled notebook the user had been drawing in would be deleted on
    // the next launch. The node type is the real gate; the content check
    // is the belt to its braces.
    const node = findNodeByFileId(state.fileTree, file?.id);
    if (node && node.type !== "document") continue;
    if (typeof file?.content !== "string") continue;
    if (!isEmptyUntitled(file?.name, file?.content)) continue;
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
  // Drop the pruned entries in place. Re-listing here meant any boot that
  // found one stray placeholder paid the whole library scan twice.
  state.files = state.files.filter((f) => !targets.some((t) => t.fileId === f.id));
  if (!IS_TAURI) state._saveFilesLocal();
  try { await state.saveFileTree(); } catch (_) {}
}
