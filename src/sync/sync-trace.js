/**
 * Temporary in-memory trace buffer for the sync layer. Lets the
 * diagnostics surface in Settings > Sync print a chronological log of
 * the decisions sync code made — what `applyDesksFile` saw, what
 * `absorbMatchingFolder` matched, what `ensureDesksTreeSpecials`
 * stuffed where, what moves `reconcileSync` issued, etc.
 *
 * Designed to be ripped out once the desk-nesting bug is understood.
 * Single API: `traceSync(label, detail = {})`. Detail values are
 * stringified inline; long ids get truncated for readability.
 */

const _trace = [];
const MAX = 800;
const LS_KEY = "hush_sync_trace";

// Hydrate from localStorage so a re-opened settings window (which
// runs in a separate WebviewWindow on desktop) can read the trace
// produced by the main window.
try {
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const s of arr) _trace.push(String(s));
    }
  }
} catch (_) { /* localStorage unavailable */ }

function _persist() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_KEY, JSON.stringify(_trace));
    }
  } catch (_) { /* quota exceeded etc — ignore */ }
}

function shortStr(s) {
  if (typeof s !== "string") return String(s);
  return s.length <= 40 ? s : s.slice(0, 40) + "…";
}

export function traceSync(label, detail = {}) {
  const stamp = new Date().toISOString().slice(11, 23);
  const parts = [stamp, label];
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null) { parts.push(`${k}=∅`); continue; }
    if (typeof v === "string") parts.push(`${k}="${shortStr(v)}"`);
    else if (typeof v === "object") {
      try { parts.push(`${k}=${shortStr(JSON.stringify(v))}`); }
      catch { parts.push(`${k}=[object]`); }
    } else parts.push(`${k}=${v}`);
  }
  _trace.push(parts.join(" "));
  while (_trace.length > MAX) _trace.shift();
  _persist();
}

export function getTrace() {
  // Re-hydrate from localStorage so the settings window (separate
  // WebviewWindow on desktop) sees entries produced by the main window.
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.slice();
      }
    }
  } catch (_) {}
  return _trace.slice();
}

export function clearTrace() {
  _trace.length = 0;
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY); } catch (_) {}
}
