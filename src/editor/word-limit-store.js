/**
 * Where a document's word cap lives, and who is allowed to ask about it.
 *
 * The cap is stored on the doc's tree node as `wordLimit` — the same
 * per-doc metadata channel `lockedStyleId` uses, so it round-trips
 * through `save_file_tree` and travels with the desk folder to whatever
 * device the folder syncs to.
 *
 * Kept apart from `word-limit.js` (the enforcement) because the readers
 * outnumber the enforcer and don't want its imports: the word-count pill
 * reads a cap to draw it, the palette reads one to decide which of its
 * two entries to show, and the modal reads one to seed its field. The
 * pill is also what `word-limit.js` counts with, so a shared store is
 * what keeps that from being an import cycle.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";

/** How near the cap the word count starts warning (in words). */
export const LIMIT_WARN_WORDS = 10;

/** A stored limit as a usable number, or null for "no cap". Anything
 *  absent, zero, negative or unparseable reads as no cap. */
export function normalizeWordLimit(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The cap on `fileId`'s document, or null. */
export function getWordLimit(state, fileId) {
  if (!fileId || !state?.fileTree) return null;
  const node = findNodeByFileId(state.fileTree, fileId);
  return node ? normalizeWordLimit(node.wordLimit) : null;
}

/**
 * The document the palette commands act on: whatever plain doc the main
 * editor is showing. `currentFileId` is nulled for every other surface
 * (notebook, project, stack, PDF, Local Folder file), so this is also
 * the "can this be capped at all?" test — a project's joined buffer is
 * many documents at once, and a Local Folder file has no tree node to
 * carry the cap.
 */
export function wordLimitTargetFileId(state) {
  return state?.currentFileId || null;
}

/** The cap on the doc the main editor is showing, or null. */
export function currentWordLimit(state) {
  return getWordLimit(state, wordLimitTargetFileId(state));
}

/**
 * Set (or, with a null limit, clear) the cap on `fileId`'s tree node.
 * Written as `undefined` when cleared so the key drops out of the saved
 * tree entirely rather than persisting as a zero.
 */
export async function setWordLimit(state, fileId, limit) {
  if (!fileId || !state?.fileTree) return;
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node) return;
  const next = normalizeWordLimit(limit);
  node.wordLimit = next === null ? undefined : next;
  await state.saveFileTree();
  // Every surface showing this doc re-reads its cap: the word count has
  // to pick it up (or drop it) without waiting for the next keystroke.
  state.emit("word-limit-changed", fileId);
}
