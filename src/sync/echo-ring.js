/**
 * Bounded "recently seen" rings for sync echo suppression.
 *
 * Every sync provider needs to answer the same question when an
 * external-change event arrives: "is this our own write echoing back?"
 * The answer must be identity-based (a server rev, a content hash) —
 * never time-based. Echoes can arrive seconds late: Dropbox's index is
 * eventually consistent, and iCloud's bird daemon re-touches files long
 * after Hush wrote them, so any timestamp window is a race waiting to
 * be lost.
 *
 * The identity token differs per provider — Dropbox marks the server
 * rev of each upload (meta-sync.js), Local Sync marks a SHA-256 of the
 * content it wrote (local-sync.js) — but the structure is shared:
 * remember the last N tokens we produced, and treat any match as our
 * own echo. A bounded ring rather than a single slot, because a fast
 * write → write sequence can overwrite a single slot before the first
 * write's echo arrives.
 */

/** Bounded set — `mark(token)` remembers, `has(token)` answers.
 *  Oldest tokens fall off past `max`. */
export function createRing(max = 64) {
  const set = new Set();
  const order = [];
  return {
    mark(token) {
      if (!token || set.has(token)) return;
      set.add(token);
      order.push(token);
      while (order.length > max) set.delete(order.shift());
    },
    has(token) {
      return !!token && set.has(token);
    },
  };
}

/** Per-key family of rings — `mark(key, token)` / `has(key, token)`.
 *  Each key (a fileId, a mount-relative path) keeps its own
 *  `max`-bounded ring. */
export function createKeyedRing(max = 64) {
  const rings = new Map();
  return {
    mark(key, token) {
      if (!key || !token) return;
      let ring = rings.get(key);
      if (!ring) {
        ring = createRing(max);
        rings.set(key, ring);
      }
      ring.mark(token);
    },
    has(key, token) {
      if (!key || !token) return false;
      const ring = rings.get(key);
      return !!ring && ring.has(token);
    },
  };
}
