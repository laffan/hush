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
 *   * A per-file recent-rev ring used by the user-content cursor path.
 *     The SQLite `last_known_rev` is one slot — fast successive pushes
 *     can bump it past the rev Dropbox eventually reports back, which
 *     reads as a foreign change and overwrites local content. The ring
 *     keeps the last few revs we wrote per file so the cursor consumer
 *     can recognize any of them.
 *   * Content hashing helpers: `sha256Hex` (matches the Rust-side
 *     `SyncedFileInfo.lastSyncedHash` format — lowercase hex SHA-256 of
 *     UTF-8 bytes) and a per-meta-file last-payload hash so identical
 *     re-pushes are dropped at the queue boundary.
 *   * The `META_HANDLERS` dispatch table. Per-meta-file modules
 *     (pane-sync, project-sync, style-sync) register their applier
 *     here at import time; the cursor's onMeta routes by filename.
 */

const HUSH_PREFIX = ".hush/";

// ===== Echo suppression — meta files (single global ring) =====

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

// ===== Echo suppression — user content (per-file ring) =====

/** fileId → { set: Set<rev>, order: rev[] } */
const _fileRevs = new Map();
// Increased from 16 → 64 in the 2026-05 audit pass. With three active
// devices (desktop + iPad + iPhone) a slow device's cursor can lag
// far enough behind that the ring would roll over before it caught up
// to a rev we wrote — that device would then pull-back its own old
// rev as a "foreign change." 64 slots covers a comfortably long lag
// without measurably affecting memory.
const PER_FILE_REVS_MAX = 64;

/**
 * Record a rev we just successfully uploaded for `fileId`. The ring
 * keeps the last `PER_FILE_REVS_MAX` revs so the cursor consumer can
 * recognize any of them as our own write — the single-slot
 * `last_known_rev` in SQLite gets overwritten by the *next* push and
 * stops protecting earlier ones. Without this, a fast type → push →
 * type → push sequence can have the cursor poll observe the older
 * rev (Dropbox's index hasn't caught up to the newer one yet), miss
 * the lastKnownRev match, and pull the older content back over the
 * newer local edit.
 */
export function markOurFileRev(fileId, rev) {
  if (!fileId || !rev) return;
  let entry = _fileRevs.get(fileId);
  if (!entry) {
    entry = { set: new Set(), order: [] };
    _fileRevs.set(fileId, entry);
  }
  if (entry.set.has(rev)) return;
  entry.set.add(rev);
  entry.order.push(rev);
  while (entry.order.length > PER_FILE_REVS_MAX) {
    const old = entry.order.shift();
    entry.set.delete(old);
  }
}

export function wasOurFileRev(fileId, rev) {
  if (!fileId || !rev) return false;
  const entry = _fileRevs.get(fileId);
  return !!entry && entry.set.has(rev);
}

// ===== Hashing =====

/** SHA-256 of the UTF-8 bytes, lowercase hex. Matches the Rust
 *  side's `SyncedFileInfo.last_synced_hash` format so the JS-side
 *  push gate can compare directly against the value returned by
 *  `get_sync_file_info`. */
export async function sha256Hex(text) {
  if (typeof text !== "string") return "";
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ===== Upload helper =====

/** filename (without `.hush/` prefix) → sha256Hex of last enqueued payload */
const _lastMetaPayloadHash = new Map();

/**
 * Enqueue a meta-file upload via the op log. Skips the enqueue when the
 * payload is byte-identical to our last enqueue for the same filename —
 * meta-file callers (`schedulePersist`, project / style triggers) often
 * fire on state changes that don't actually mutate the serialized
 * payload, and re-pushing identical content would cause spurious
 * cross-device cursor wake-ups.
 *
 * The op log already serializes ops by insertion order; for a flurry of
 * state changes the caller should still debounce upstream (panes use
 * `schedulePersist`, etc.).
 */
export async function enqueueMetaUpload(filename, payload) {
  const hash = await sha256Hex(payload);
  if (hash && _lastMetaPayloadHash.get(filename) === hash) return;
  _lastMetaPayloadHash.set(filename, hash);

  const { enqueueUploadPayload, triggerDrain } = await import("./op-log.js");
  await enqueueUploadPayload({ path: HUSH_PREFIX + filename, payload });
  triggerDrain();
}
