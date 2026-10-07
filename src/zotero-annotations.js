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
 *
 * Library-wide highlights: Settings → Zotero → Highlights downloads
 * every annotation in the library to a file of its own, separate from
 * the references (`zotero_highlights.json`, `{ attKey: [raw items] }`).
 * While that file exists it is read first — and an attachment it doesn't
 * list is one with no annotations, not one to ask Zotero about — so the
 * highlight browser is a local operation. A refresh still goes to the
 * network, and folds what it gets back into the file.
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
    // Read out of the PDF file itself (pdf/pdf-annotation-extract.js):
    // pdf.js paints those into the page, so overlays skip them.
    embedded: !!d.hushEmbedded,
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

// ── The library's highlights file ───────────────────────────────────

let libraryHighlights; // undefined = not read yet, null = never downloaded

/** `{ attKey: [raw items] }` from the last download that included
 *  highlights, or null when there has been none. Read once per window. */
export async function loadLibraryHighlights() {
  if (libraryHighlights !== undefined) return libraryHighlights;
  try {
    const json = IS_TAURI
      ? await tauriInvoke("load_zotero_highlights")
      : localStorage.getItem("hush_zotero_highlights");
    const parsed = json ? JSON.parse(json) : null;
    libraryHighlights = parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    libraryHighlights = null;
  }
  return libraryHighlights;
}

/** Replace the library's highlights file (Settings → Zotero →
 *  Highlights). Returns the file's size in bytes. */
export async function saveLibraryHighlights(byAttachment) {
  const json = JSON.stringify(byAttachment ?? null);
  if (IS_TAURI) await tauriInvoke("save_zotero_highlights", { data: json });
  else localStorage.setItem("hush_zotero_highlights", json);
  libraryHighlights = byAttachment ?? null;
  // Every other window (the settings window downloads, the editor
  // window reads) drops its copy and reads the file afresh.
  if (IS_TAURI) {
    try { (await import("@tauri-apps/api/event")).emit(HIGHLIGHTS_SAVED_EVENT, null); } catch (_) {}
  }
  return new Blob([json]).size;
}

const HIGHLIGHTS_SAVED_EVENT = "hush-zotero-highlights-saved";
if (IS_TAURI) {
  import("@tauri-apps/api/event")
    .then(({ listen }) => listen(HIGHLIGHTS_SAVED_EVENT, () => { libraryHighlights = undefined; }))
    .catch(() => {});
}

/** How many annotations the library file holds for each attachment —
 *  null when it was never downloaded. For the highlight browser's list. */
export async function libraryHighlightCounts() {
  const lib = await loadLibraryHighlights();
  if (!lib) return null;
  const out = new Map();
  for (const [k, list] of Object.entries(lib)) if (Array.isArray(list)) out.set(k, list.length);
  return out;
}

/** Fold a fresh per-attachment fetch back into the library file, so the
 *  next local read has it. A no-op while there is no file. */
async function patchLibraryHighlights(attKey, rawItems) {
  const lib = await loadLibraryHighlights();
  if (!lib) return;
  const next = { ...lib };
  if (rawItems?.length) next[attKey] = rawItems; else delete next[attKey];
  try { await saveLibraryHighlights(next); } catch (_) { /* the fetch itself succeeded */ }
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
    // Local first: the whole library, when it has been downloaded.
    const lib = await loadLibraryHighlights();
    if (lib) {
      const list = Array.isArray(lib[attKey]) ? lib[attKey] : [];
      return { annotations: sortAnnotations(list.map(normalize)), fromCache: true, local: true };
    }
    const cached = await readCache(attKey);
    if (cached && Array.isArray(cached)) {
      return {
        annotations: sortAnnotations(cached.map(normalize)),
        fromCache: true,
      };
    }
  }

  if (!userId || !apiKey) throw new Error("Zotero credentials missing — set them in Settings > Zotero.");
  const fresh = await fetchFromNetwork(attKey, userId, apiKey);
  await patchLibraryHighlights(attKey, fresh);
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

// ── Annotations extracted from the PDF file ─────────────────────────
// "Extract Annotations" (the viewer's shelf) reads a PDF's own embedded
// annotations into the same raw shape the API returns. They are cached
// beside Zotero's, under a key that can't collide with an item key, per
// Hush fileId — an imported PDF may have no attachment key at all.

function extractedKey(fileId) {
  return "hush-pdf-" + String(fileId || "").replace(/[^A-Za-z0-9_-]/g, "");
}

async function writeCache(key, list) {
  const json = JSON.stringify(list);
  if (!IS_TAURI) { localStorage.setItem("hush_zotero_ann_" + key, json); return; }
  await tauriInvoke("save_zotero_annotations", { itemKey: key, data: json });
}

/** Raw items (the API's shape) → the list the viewer takes, sorted. */
export function normalizeAnnotations(rawItems) {
  return sortAnnotations((rawItems || []).map(normalize));
}

/** Persist a PDF's extracted annotations (raw items). */
export async function saveExtractedAnnotations(fileId, rawItems) {
  if (!fileId) return;
  await writeCache(extractedKey(fileId), rawItems || []);
}

/** The extracted annotations cached for `fileId`, normalised; [] when the
 *  file was never extracted. */
export async function getExtractedAnnotations(fileId) {
  if (!fileId) return [];
  try {
    const cached = await readCache(extractedKey(fileId));
    if (Array.isArray(cached)) return sortAnnotations(cached.map(normalize));
  } catch (_) {}
  return [];
}

/** One list out of the API's and the file's. An annotation in both — a
 *  PDF exported from Zotero carries each one's item key — is kept once,
 *  as the API's (the library is the authority on its text and tags) but
 *  flagged `embedded`, since the page already shows it. */
export function mergeAnnotationLists(apiList, extractedList) {
  if (!extractedList?.length) return apiList || [];
  if (!apiList?.length) return extractedList;
  const inFile = new Set(extractedList.map((a) => a.key));
  const fromApi = new Set(apiList.map((a) => a.key));
  const merged = apiList.map((a) => (inFile.has(a.key) ? { ...a, embedded: true } : a));
  for (const a of extractedList) if (!fromApi.has(a.key)) merged.push(a);
  return sortAnnotations(merged);
}

/**
 * Everything a viewer should list for a PDF: the Zotero attachment's
 * annotations (when there is a key — from the library's highlights file,
 * the attachment's cache, or Zotero itself), merged with any the file
 * has had extracted. Errors on the API side leave the extracted
 * half standing.
 */
export async function loadPdfAnnotationList(fileId, attKey, settings, opts = {}) {
  const extracted = await getExtractedAnnotations(fileId);
  let api = [];
  // No credentials check up front, as in the highlight browser: with
  // the library's highlights downloaded the read is local and needs
  // none, and getAnnotations says so when it does have to ask Zotero.
  if (attKey) {
    try {
      api = (await getAnnotations(attKey, settings?.zoteroUserId || "", settings?.zoteroApiKey || "", opts)).annotations;
    } catch (e) { console.error("Failed to load Zotero annotations:", e); }
  }
  return mergeAnnotationLists(api, extracted);
}
