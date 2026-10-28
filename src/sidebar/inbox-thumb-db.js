/**
 * Where the Inbox's notebook snapshots are kept: IndexedDB, per device,
 * mirrored in memory so the sidebar can read them synchronously while it
 * renders. `localStorage` held them before, but two PNGs of a proof
 * notebook's pages can run to hundreds of kilobytes, and its ~5 MB quota
 * filled — a refused write dropped the snapshot, which is how previews
 * went missing after leaving a file.
 *
 * `loadThumbs()` reads the store once at start-up (and clears the old
 * `localStorage` entries); until it has, `getThumb` returns null. Writes
 * go to memory at once and to the store behind it. At most `MAX` are
 * kept, the oldest dropped first.
 */

const DB_NAME = "hush-inbox-thumbs";
const STORE = "thumbs";
const MAX = 60;
const OLD_PREFIX = "hush.inbox.thumb.";
const OLD_INDEX = "hush.inbox.thumbs";

/** fileId → { light, dark, at } */
const cache = new Map();
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no IndexedDB")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => {});
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function dropOldStorage() {
  try {
    const ids = JSON.parse(localStorage.getItem(OLD_INDEX) || "[]");
    for (const id of Array.isArray(ids) ? ids : []) {
      for (const k of ["", ".light", ".dark"]) localStorage.removeItem(OLD_PREFIX + id + k);
    }
    localStorage.removeItem(OLD_INDEX);
  } catch { /* storage unavailable */ }
}

/** Read every kept snapshot into memory. Resolves true once loaded. */
export async function loadThumbs() {
  dropOldStorage();
  try {
    await run("readonly", (store) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (cur.value && cur.value.light && cur.value.dark) cache.set(String(cur.key), cur.value);
        cur.continue();
      };
    });
    return true;
  } catch { return false; }
}

export function getThumb(fileId) {
  return cache.get(fileId) || null;
}

export function putThumb(fileId, light, dark) {
  const value = { light, dark, at: Date.now() };
  cache.set(fileId, value);
  const doomed = [];
  if (cache.size > MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of oldest.slice(0, cache.size - MAX)) { cache.delete(id); doomed.push(id); }
  }
  void run("readwrite", (store) => {
    store.put(value, fileId);
    for (const id of doomed) store.delete(id);
  }).catch(() => {});
}

export function deleteThumb(fileId) {
  if (!cache.delete(fileId)) return;
  void run("readwrite", (store) => store.delete(fileId)).catch(() => {});
}
