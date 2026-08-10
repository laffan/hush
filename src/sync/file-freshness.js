/**
 * "Has this file moved since I last looked?" — a `stat`, not a read.
 *
 * Every surface holding a file open re-reads it on each reconcile pass,
 * because a content-only change produces no reconcile event (see
 * README-SYNC). That was affordable while passes were driven by
 * filesystem events. On iOS there are none: the pass is a poll, and
 * re-reading a multi-megabyte notebook every tick to discover nothing
 * had changed is exactly the sort of work an iPad notices.
 *
 * So the reload hooks ask here first and only read what actually moved.
 * A file we've never seen counts as moved — one read, once.
 */

const _seen = new Map(); // fileId → last observed mtime (epoch ms)

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * Of `ids`, which have a different mtime than the last time we asked.
 * Returns a Set. Ids the store can't place are reported as moved — the
 * reader is better placed than we are to decide what that means.
 *
 * Note this also reports *our own* writes as movement. The reload paths
 * all no-op on content they already have, so that costs one comparison,
 * and the alternative — trying to recognise our own mtimes — is the
 * kind of timestamp bookkeeping this codebase has been burned by.
 */
export async function movedSince(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (list.length === 0) return new Set();
  let mtimes;
  try {
    mtimes = (await invoke("file_mtimes", { ids: list })) || {};
  } catch (_) {
    return new Set(list); // can't tell — let the readers read
  }
  const moved = new Set();
  for (const id of list) {
    const m = mtimes[id];
    if (m == null) { moved.add(id); continue; }
    if (_seen.get(id) !== m) {
      moved.add(id);
      _seen.set(id, m);
    }
  }
  return moved;
}

/** Drop a file's remembered mtime — for a surface that just closed, so
 *  re-opening it later starts from a clean read. */
export function forgetFreshness(id) {
  _seen.delete(id);
}
