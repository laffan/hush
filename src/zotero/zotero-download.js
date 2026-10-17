/**
 * The two Zotero downloads Settings → Zotero offers — References and
 * Highlights, each its own file and its own section — run to completion
 * and saved, returning the settings patch that describes the result
 * (count, when, how big). Shared by the settings panel and the palette's
 * background "Update Zotero References", so both record the same thing.
 *
 * In the app both run in Rust (`zotero_sync`, src-tauri/src/zotero_sync.rs,
 * a port of zotero-helper's sync engine): `full: false` is Update Data —
 * only what changed in the library since the last download, folded into
 * a raw cache that holds the library version beside the items — and
 * `full: true` is Re-download All. Rust writes the files the app reads.
 * The browser build has no Rust and always downloads in full here.
 *
 * Either takes an AbortSignal: a cancelled download throws an
 * `AbortError` (`isCancelled`) and has written nothing, so the file from
 * the last finished download stays as it was.
 */

import { downloadZoteroReferences, downloadZoteroHighlights, clearCache } from "../zotero.js";
import { libraryHighlightsReplaced } from "../zotero-annotations.js";
import { throwIfCancelled } from "./api.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export const isCancelled = (e) => e?.name === "AbortError";

export function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + " KB"
    : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Run one download in Rust, relaying its progress and its cancel.
 *  Resolves to its summary (`{ full, count, fileBytes, cacheBytes,
 *  added, updated, removed, version }`). */
async function runSync(kind, full, userId, apiKey, onProgress, signal) {
  throwIfCancelled(signal);
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const runId = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const unlisten = await listen("zotero-sync-progress", (e) => {
    if (e.payload?.runId === runId) onProgress(e.payload.msg, e.payload.pct);
  });
  const onAbort = () => { invoke("zotero_sync_cancel", { kind }).catch(() => {}); };
  signal?.addEventListener("abort", onAbort);
  try {
    return await invoke("zotero_sync", { kind, full, runId, userId, apiKey });
  } catch (e) {
    if (String(e) === "cancelled") throw new DOMException("Cancelled", "AbortError");
    throw new Error(String(e?.message || e));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unlisten();
  }
}

/** "Last updated" — with what an update changed. */
function stamp(summary) {
  const when = new Date().toLocaleString();
  if (summary.full) return when;
  const parts = [];
  if (summary.added) parts.push(`${summary.added} new`);
  if (summary.updated) parts.push(`${summary.updated} changed`);
  if (summary.removed) parts.push(`${summary.removed} removed`);
  return `${when} (${parts.length ? parts.join(", ") : "no changes"})`;
}

/** The file's size, and the library cache's beside it. */
function sizes(summary) {
  return `${formatBytes(summary.fileBytes)} (library cache ${formatBytes(summary.cacheBytes)})`;
}

/** Download and save the references: only what changed unless `full`. */
export async function updateReferences(userId, apiKey, { onProgress = () => {}, signal, full = true } = {}) {
  if (IS_TAURI) {
    const summary = await runSync("references", full, userId, apiKey, onProgress, signal);
    clearCache();
    return {
      zoteroLastUpdate: stamp(summary),
      zoteroReferenceCount: summary.count,
      zoteroFileSize: sizes(summary),
    };
  }
  const refs = await downloadZoteroReferences(userId, apiKey, onProgress, { signal });
  const json = JSON.stringify(refs);
  localStorage.setItem("hush_zotero_refs", json);
  clearCache();
  return {
    zoteroLastUpdate: new Date().toLocaleString(),
    zoteroReferenceCount: refs.length,
    zoteroFileSize: formatBytes(new Blob([json]).size),
  };
}

/** Download and save every highlight in the library: only what changed
 *  unless `full`. */
export async function updateHighlights(userId, apiKey, { onProgress = () => {}, signal, full = true } = {}) {
  if (IS_TAURI) {
    const summary = await runSync("highlights", full, userId, apiKey, onProgress, signal);
    await libraryHighlightsReplaced();
    return {
      zoteroHighlightsLastUpdate: stamp(summary),
      zoteroHighlightCount: summary.count,
      zoteroHighlightsFileSize: sizes(summary),
    };
  }
  const { count, bytes } = await downloadZoteroHighlights(userId, apiKey, onProgress, { signal });
  return {
    zoteroHighlightsLastUpdate: new Date().toLocaleString(),
    zoteroHighlightCount: count,
    zoteroHighlightsFileSize: formatBytes(bytes),
  };
}
