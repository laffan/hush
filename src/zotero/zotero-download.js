/**
 * The two Zotero downloads Settings → Zotero offers — References and
 * Highlights, each its own file and its own section — run to completion
 * and saved, returning the settings patch that describes the result
 * (count, when, how big). Shared by the settings panel and the palette's
 * background "Update Zotero References", so both record the same thing.
 *
 * Either takes an AbortSignal: a cancelled download throws an
 * `AbortError` (`isCancelled`) and has written nothing, so the file from
 * the last finished download stays as it was.
 */

import { downloadZoteroReferences, downloadZoteroHighlights, clearCache } from "../zotero.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export const isCancelled = (e) => e?.name === "AbortError";

export function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + " KB"
    : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Download and save the references. */
export async function updateReferences(userId, apiKey, { onProgress = () => {}, signal } = {}) {
  const refs = await downloadZoteroReferences(userId, apiKey, onProgress, { signal });
  const json = JSON.stringify(refs);
  if (IS_TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_zotero_references", { data: json });
  } else {
    localStorage.setItem("hush_zotero_refs", json);
  }
  clearCache();
  return {
    zoteroLastUpdate: new Date().toLocaleString(),
    zoteroReferenceCount: refs.length,
    zoteroFileSize: formatBytes(new Blob([json]).size),
  };
}

/** Download and save every highlight in the library. */
export async function updateHighlights(userId, apiKey, { onProgress = () => {}, signal } = {}) {
  const { count, bytes } = await downloadZoteroHighlights(userId, apiKey, onProgress, { signal });
  return {
    zoteroHighlightsLastUpdate: new Date().toLocaleString(),
    zoteroHighlightCount: count,
    zoteroHighlightsFileSize: formatBytes(bytes),
  };
}
