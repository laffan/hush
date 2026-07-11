/**
 * Bounded "recently seen" rings for sync echo suppression.
 *
 * Every sync provider needs to answer the same question when an
 * external-change event arrives: "is this our own write echoing back?"
 * The answer must be identity-based (a server rev, a content hash) —
 * never time-based. Echoes can arrive seconds late: iCloud's bird
 * daemon re-touches files long after Hush wrote them, so any timestamp
 * window is a race waiting to be lost.
 *
 * The identity token can differ per provider (a server rev, a SHA-256
 * of the written content — see local-sync.js) but the structure is
 * shared:
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

/** SHA-256 of a UTF-8 string as lowercase hex — the identity token for
 *  filesystem providers (a plain folder has no server revs). Matches the
 *  Rust side's hash format so the two compare directly. */
export async function sha256Hex(text) {
  if (typeof text !== "string") return "";
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
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
