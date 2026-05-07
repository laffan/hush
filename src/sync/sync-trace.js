/**
 * Temporary in-memory trace buffer for the sync layer. Hooked from
 * `initial-sync.js`, `dropbox-cursor.js`, and `op-log.js` to record what
 * each path observed at the moment of decision (find_by_remote_id
 * result, register call, applyCreated dispatch, etc). The diagnostic
 * settings panel surfaces the buffer for debugging the iPad-first-sync
 * duplication.
 *
 * Keep this module small and side-effect-free so it can be ripped out
 * once the bug is fixed.
 */

const _trace = [];
const MAX = 600;

function shortId(s) {
  if (typeof s !== "string") return "";
  return s.length <= 28 ? s : s.slice(0, 28) + "…";
}

export function traceSync(label, detail = {}) {
  const stamp = new Date().toISOString().slice(11, 23);
  const parts = [stamp, label];
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null) { parts.push(`${k}=∅`); continue; }
    if (typeof v === "string") parts.push(`${k}=${shortId(v)}`);
    else parts.push(`${k}=${v}`);
  }
  _trace.push(parts.join(" "));
  while (_trace.length > MAX) _trace.shift();
}

export function getTrace() {
  return _trace.slice();
}

export function clearTrace() {
  _trace.length = 0;
}
