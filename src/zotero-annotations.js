/**
 * Zotero annotations — fetch + cache layer for PDF annotations.
 *
 * Annotations are child items of a PDF attachment in Zotero (itemType
 * "annotation"). This module fetches them server-side via the
 * `fetch_zotero_annotations` Tauri command, caches the raw JSON to disk
 * under `{data_dir}/zotero_annotations/{attKey}.json`, and exposes a
 * normalised list to the rest of the app.
 *
 * Cache policy: cache-first. Callers can pass `forceRefresh: true` to
 * skip the cached read. The pane UI exposes a refresh button for that.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const ZOTERO_API = "https://api.zotero.org";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Pull the bits we care about off a raw Zotero annotation item.
 *  Anything we don't surface yet (positions, image data, tags) is left
 *  untouched in case a later pass wants it — the raw object is kept on
 *  the `_raw` field. */
function normalize(raw) {
  const d = raw?.data || {};
  return {
    key: raw?.key || "",
    type: d.annotationType || "highlight", // highlight | underline | note | image | ink
    color: (d.annotationColor || "").toLowerCase(),
    text: d.annotationText || "",
    comment: d.annotationComment || "",
    pageLabel: d.annotationPageLabel || "",
    sortIndex: d.annotationSortIndex || "",
    tags: Array.isArray(d.tags) ? d.tags.map((t) => t.tag).filter(Boolean) : [],
    _raw: raw,
  };
}

/** Sort by Zotero's sortIndex string, which is `pp|cccc|oooo` zero-padded
 *  page/character/offset triple. Lexicographic compare is correct. */
function sortAnnotations(list) {
  return list.slice().sort((a, b) => {
    if (a.sortIndex === b.sortIndex) return 0;
    return a.sortIndex < b.sortIndex ? -1 : 1;
  });
}

/** Read the cached JSON file for an attachment, or `null` if missing. */
async function readCache(attKey) {
  if (!IS_TAURI) {
    const stored = localStorage.getItem("hush_zotero_ann_" + attKey);
    return stored ? JSON.parse(stored) : null;
  }
  const json = await tauriInvoke("load_zotero_annotations", { itemKey: attKey });
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/** Network fetch routes through the Rust command in Tauri (server-side,
 *  paginated, persists cache on success). The browser fallback hits the
 *  Zotero API directly so dev-mode without Tauri can still iterate. */
async function fetchFromNetwork(attKey, userId, apiKey) {
  if (IS_TAURI) {
    const json = await tauriInvoke("fetch_zotero_annotations", {
      itemKey: attKey,
      userId,
      apiKey,
    });
    return JSON.parse(json);
  }
  // Browser fallback — paginate manually.
  const all = [];
  const pageSize = 100;
  let start = 0;
  while (true) {
    const url = `${ZOTERO_API}/users/${userId}/items/${attKey}/children?itemType=annotation&format=json&limit=${pageSize}&start=${start}`;
    const resp = await fetch(url, {
      headers: {
        "Zotero-API-Key": apiKey,
        "Zotero-API-Version": "3",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const total = parseInt(resp.headers.get("Total-Results") || "0", 10);
    const batch = await resp.json();
    all.push(...batch);
    start += pageSize;
    if (start >= total || batch.length === 0) break;
  }
  localStorage.setItem("hush_zotero_ann_" + attKey, JSON.stringify(all));
  return all;
}

/** Cache-only read — never hits the network. Used by the PDF Shelf's
 *  search to index annotation text without pinging the API per PDF. */
export async function getCachedAnnotations(attKey) {
  if (!attKey) return [];
  try {
    const cached = await readCache(attKey);
    if (cached && Array.isArray(cached)) return sortAnnotations(cached.map(normalize));
  } catch (_) {}
  return [];
}

/**
 * Resolve the annotation list for a PDF attachment.
 * @param {string} attKey       Zotero attachment item key
 * @param {string} userId       Zotero user id (from settings)
 * @param {string} apiKey       Zotero API key (from settings)
 * @param {Object} opts
 * @param {boolean} [opts.forceRefresh]  Skip the cache and re-fetch.
 * @returns {Promise<{ annotations: Array, fromCache: boolean }>}
 */
export async function getAnnotations(attKey, userId, apiKey, opts = {}) {
  const { forceRefresh = false } = opts;
  if (!attKey) throw new Error("attachment key required");

  if (!forceRefresh) {
    const cached = await readCache(attKey);
    if (cached && Array.isArray(cached)) {
      return {
        annotations: sortAnnotations(cached.map(normalize)),
        fromCache: true,
      };
    }
  }

  const fresh = await fetchFromNetwork(attKey, userId, apiKey);
  return {
    annotations: sortAnnotations(fresh.map(normalize)),
    fromCache: false,
  };
}

/** Group annotations by `color`. Returns `{ colors: string[], byColor: Map }`. */
export function groupByColor(annotations) {
  const byColor = new Map();
  for (const ann of annotations) {
    const c = ann.color || "";
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(ann);
  }
  // Stable order: by first appearance in the (already-sorted) list.
  const colors = [];
  for (const ann of annotations) {
    if (!colors.includes(ann.color)) colors.push(ann.color);
  }
  return { colors, byColor };
}
