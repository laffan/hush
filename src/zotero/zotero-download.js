/**
 * The two Zotero downloads Settings → Zotero offers — References and
 * Highlights, each its own file and its own section — run to completion
 * and saved, returning the settings patch that describes the result
 * (count, when, how big). Shared by the settings panel and the palette's
 * background "Update Zotero References", so both record the same thing.
 *
 * Each also has an "Update Data" form (`syncReferences`,
 * `syncHighlights`): only what changed in the library since the version
 * the last download recorded (`zoteroLibraryVersion`,
 * `zoteroHighlightsVersion`), folded into the file already on this
 * device — new items added, edited ones replaced, deleted ones dropped
 * (zotero-merge.js). Without a recorded version or a file to fold into,
 * it is the full download.
 *
 * Either takes an AbortSignal: a cancelled download throws an
 * `AbortError` (`isCancelled`) and has written nothing, so the file from
 * the last finished download stays as it was.
 */

import {
  downloadZoteroReferences, downloadZoteroHighlights, clearCache, loadReferences, refreshZoteroCollections,
} from "../zotero.js";
import { loadLibraryHighlights, saveLibraryHighlights } from "../zotero-annotations.js";
import { fetchChangedSince, fetchDeletedSince, throwIfCancelled } from "./api.js";
import { mergeReferences, mergeHighlights } from "./zotero-merge.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export const isCancelled = (e) => e?.name === "AbortError";

export function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + " KB"
    : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** "3 new, 1 changed, 2 removed" — or "no changes". */
function changeSummary({ added, updated, removed }) {
  const parts = [];
  if (added) parts.push(`${added} new`);
  if (updated) parts.push(`${updated} changed`);
  if (removed) parts.push(`${removed} removed`);
  return parts.length ? parts.join(", ") : "no changes";
}

async function saveReferences(refs) {
  const json = JSON.stringify(refs);
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_zotero_references", { data: json });
  } else {
    localStorage.setItem("hush_zotero_refs", json);
  }
  clearCache();
  return json;
}

/** Download and save the references. */
export async function updateReferences(userId, apiKey, { onProgress = () => {}, signal } = {}) {
  const meta = {};
  const refs = await downloadZoteroReferences(userId, apiKey, onProgress, { signal, meta });
  const json = await saveReferences(refs);
  return {
    zoteroLastUpdate: new Date().toLocaleString(),
    zoteroReferenceCount: refs.length,
    zoteroFileSize: formatBytes(new Blob([json]).size),
    zoteroLibraryVersion: meta.version ?? null,
  };
}

/** Update Data for the references: only what changed since `since`. */
export async function syncReferences(userId, apiKey, { onProgress = () => {}, signal, since } = {}) {
  const current = since != null ? await loadReferences().catch(() => null) : null;
  if (!Array.isArray(current) || !current.length) return updateReferences(userId, apiKey, { onProgress, signal });
  onProgress("Checking for changes...", 0);
  const top = await fetchChangedSince(userId, apiKey, "items/top?", since, signal,
    (n, total) => onProgress(`Fetching changed items (${n} of ${total})...`, 0.1 + (total ? n / total : 1) * 0.4));
  const atts = await fetchChangedSince(userId, apiKey, "items?itemType=attachment&", since, signal,
    (n, total) => onProgress(`Fetching changed attachments (${n} of ${total})...`, 0.5 + (total ? n / total : 1) * 0.3));
  onProgress("Checking for deletions...", 0.85);
  const deleted = await fetchDeletedSince(userId, apiKey, since, signal);
  onProgress("Fetching collections...", 0.9);
  await refreshZoteroCollections(userId, apiKey, signal);
  throwIfCancelled(signal);
  const merged = mergeReferences(current, top.items, atts.items, deleted.items);
  const json = await saveReferences(merged.references);
  onProgress("Done!", 1);
  return {
    zoteroLastUpdate: `${new Date().toLocaleString()} (${changeSummary(merged)})`,
    zoteroReferenceCount: merged.references.length,
    zoteroFileSize: formatBytes(new Blob([json]).size),
    // The oldest version any of the three answers reflects: a change
    // that landed between them is fetched again next time, not skipped.
    zoteroLibraryVersion: minVersion(since, top.version, atts.version, deleted.version),
  };
}

function minVersion(since, ...versions) {
  const known = versions.filter((v) => Number.isFinite(v));
  return known.length ? Math.max(since, Math.min(...known)) : since;
}

/** Download and save every highlight in the library. */
export async function updateHighlights(userId, apiKey, { onProgress = () => {}, signal } = {}) {
  const { count, bytes, version } = await downloadZoteroHighlights(userId, apiKey, onProgress, { signal });
  return {
    zoteroHighlightsLastUpdate: new Date().toLocaleString(),
    zoteroHighlightCount: count,
    zoteroHighlightsFileSize: formatBytes(bytes),
    zoteroHighlightsVersion: version ?? null,
  };
}

/** Update Data for the highlights: only what changed since `since`. */
export async function syncHighlights(userId, apiKey, { onProgress = () => {}, signal, since } = {}) {
  const current = since != null ? await loadLibraryHighlights() : null;
  if (!current) return updateHighlights(userId, apiKey, { onProgress, signal });
  onProgress("Checking for changes...", 0);
  const changed = await fetchChangedSince(userId, apiKey, "items?itemType=annotation&", since, signal,
    (n, total) => onProgress(`Fetching changed highlights (${n} of ${total})...`, (total ? n / total : 1) * 0.8));
  onProgress("Checking for deletions...", 0.85);
  const deleted = await fetchDeletedSince(userId, apiKey, since, signal);
  throwIfCancelled(signal);
  const merged = mergeHighlights(current, changed.items, deleted.items);
  const bytes = await saveLibraryHighlights(merged.byAttachment);
  onProgress("Done!", 1);
  return {
    zoteroHighlightsLastUpdate: `${new Date().toLocaleString()} (${changeSummary(merged)})`,
    zoteroHighlightCount: merged.count,
    zoteroHighlightsFileSize: formatBytes(bytes),
    zoteroHighlightsVersion: minVersion(since, changed.version, deleted.version),
  };
}
