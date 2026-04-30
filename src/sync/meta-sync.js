/**
 * Shared infrastructure for `.hush/*.json` meta files.
 *
 * Every meta file follows the same pattern:
 *   1. A serializer that builds a JSON payload from local state.
 *   2. An applier that consumes a remote payload and merges into local
 *      state, additively where it makes sense.
 *   3. A trigger that runs the serializer and enqueues an upload via
 *      the op log.
 *   4. Dispatch from the cursor consumer's `onMeta` handler when a
 *      remote change lands.
 *
 * This module owns:
 *   * The bounded in-memory rev tracker that suppresses our own uploads
 *     when they echo back via the cursor delta. Meta files don't live in
 *     `synced_files`, so the SQLite-backed `last_known_rev` doesn't
 *     cover them.
 *   * The `META_HANDLERS` dispatch table. Per-meta-file modules
 *     (pane-sync, project-sync, style-sync) register their applier
 *     here at import time; the cursor's onMeta routes by filename.
 */

const HUSH_PREFIX = ".hush/";

// ===== Echo suppression =====

const _ourRevs = new Set();
const _ourRevsOrder = [];
const OUR_REVS_MAX = 64;

export function markOurRev(rev) {
  if (!rev || _ourRevs.has(rev)) return;
  _ourRevs.add(rev);
  _ourRevsOrder.push(rev);
  while (_ourRevsOrder.length > OUR_REVS_MAX) {
    const old = _ourRevsOrder.shift();
    _ourRevs.delete(old);
  }
}

export function isOurRev(rev) {
  return !!rev && _ourRevs.has(rev);
}

// ===== Upload helper =====

/**
 * Enqueue a meta-file upload via the op log. The op log already
 * serializes ops by insertion order; for a flurry of state changes the
 * caller should debounce upstream (panes use `schedulePersist`, etc.).
 */
export async function enqueueMetaUpload(filename, payload) {
  const { enqueueUploadPayload, triggerDrain } = await import("./op-log.js");
  await enqueueUploadPayload({ path: HUSH_PREFIX + filename, payload });
  triggerDrain();
}
