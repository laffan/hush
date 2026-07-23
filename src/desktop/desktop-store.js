/**
 * Desktop persistence — per-device IndexedDB storage for the Desktop
 * views (desk / project canvases of file thumbnails).
 *
 * Two object stores:
 *  - "envelopes"  containerId → stripped notebook envelope (shapes with
 *                 fileRef dataUrls blanked, layers, camera, background).
 *  - "thumbs"     thumb key (fileId, or nodeId for projects) →
 *                 { dataUrl, sig, w, h } — the rendered thumbnail plus
 *                 the staleness signature it was built from.
 *
 * Like the PDF covers, none of this rides sync: a fresh device just
 * regenerates thumbnails from the files and lays the grid out again.
 * IndexedDB (rather than a Rust-side store) because thumbnails are
 * pure per-device UI cache and dataURLs would blow localStorage's
 * quota on a large library.
 */

const DB_NAME = "hush-desktop";
const DB_VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("envelopes")) db.createObjectStore("envelopes");
      if (!db.objectStoreNames.contains("thumbs")) db.createObjectStore("thumbs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open (private browsing edge cases) shouldn't wedge every
  // later call behind the same rejection — allow a retry.
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function idbGet(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  })).catch(() => null);
}

function idbPut(store, key, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  })).catch(() => false);
}

function idbDelete(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  })).catch(() => false);
}

/** Load the saved desktop envelope for a container (desk / project id).
 *  Null when the container has never been laid out. */
export function loadDesktopEnvelope(containerId) {
  return idbGet("envelopes", containerId);
}

/** Persist the (stripped) desktop envelope for a container. */
export function saveDesktopEnvelope(containerId, envelope) {
  return idbPut("envelopes", containerId, envelope);
}

export function deleteDesktopEnvelope(containerId) {
  return idbDelete("envelopes", containerId);
}

/** Load a cached thumbnail record `{ dataUrl, sig, w, h }` or null. */
export function loadThumbRecord(key) {
  return idbGet("thumbs", key);
}

/** Persist a thumbnail record. `w`/`h` are display (CSS px) dims —
 *  the dataUrl itself is rendered at 2× for HiDPI. */
export function saveThumbRecord(key, record) {
  return idbPut("thumbs", key, record);
}

export function deleteThumbRecord(key) {
  return idbDelete("thumbs", key);
}
