/**
 * Google Docs link sync via `.hush/gdocs.json`.
 *
 * Per-device, `settings.googleDocLinks` maps a local `fileId` → link
 * `{ docId, title, linkedAt }`. The local fileId is generated when the
 * file is created on that device, so a doc that synced from Laptop to
 * iPad has TWO different local ids; the link record on Laptop doesn't
 * help iPad. To bridge the gap we translate every link to the file's
 * Dropbox `remote_id` (stable across devices), serialise the whole
 * map, and ride it through the existing meta-file channel.
 *
 * Schema (v1):
 *   {
 *     "format": "hush-gdocs",
 *     "version": 1,
 *     "links": [
 *       { "remoteId": "id:abc…", "docId": "google-doc-id", "title": "…" }
 *     ]
 *   }
 *
 * Identity: the `remoteId` is the file's identity. On receive, we look
 * up the matching local fileId via the sync map. Entries whose
 * remoteId doesn't resolve are skipped silently — the file probably
 * hasn't synced down yet, and the post-create reapply will catch it
 * on the next pull (see `reapplyGdocsAfterCreates` in sync-polling).
 *
 * The local copy of the link still lives in `settings.googleDocLinks`
 * keyed by per-device fileId; this module only handles the wire
 * format and the cross-device mapping.
 */

const GDOCS_FILENAME = "gdocs.json";
const FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Serialize the current local link map into the wire payload. Skips
 *  links whose underlying file isn't synced (no remote_id) — they can't
 *  meaningfully ride across devices. */
export async function serializeGoogleLinks(state) {
  const links = state?.settings?.googleDocLinks || {};
  const out = [];
  for (const [fileId, link] of Object.entries(links)) {
    if (!fileId || !link?.docId) continue;
    try {
      const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
      const remoteId = info?.remoteId;
      if (!remoteId) continue;
      out.push({ remoteId, docId: link.docId, title: link.title || "" });
    } catch (_) { /* skip unresolvable */ }
  }
  return JSON.stringify({
    format: "hush-gdocs",
    version: FORMAT_VERSION,
    links: out,
  }, null, 2);
}

/** Apply a remote `.hush/gdocs.json` payload locally. For each entry,
 *  resolve `remoteId → fileId` via the sync map and `set_google_doc_link`
 *  if the local link record differs (or is missing). Returns
 *  `{ matched, added, skipped }`. */
export async function applyGoogleLinks(state, payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { matched: 0, added: 0, skipped: 0, error: "parse" }; }
  if (!parsed || parsed.format !== "hush-gdocs" || !Array.isArray(parsed.links)) {
    return { matched: 0, added: 0, skipped: 0, error: "format" };
  }

  let matched = 0;
  let added = 0;
  let changed = 0;
  let skipped = 0;
  const localLinks = state?.settings?.googleDocLinks || {};

  for (const entry of parsed.links) {
    if (!entry?.remoteId || !entry?.docId) { skipped++; continue; }
    let info = null;
    try { info = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: entry.remoteId }); }
    catch (_) { info = null; }
    if (!info?.internalId) { skipped++; continue; }
    const existing = localLinks[info.internalId];
    if (existing && existing.docId === entry.docId && existing.title === entry.title) {
      matched++;
      continue;
    }
    try {
      await tauriInvoke("set_google_doc_link", {
        fileId: info.internalId,
        docId: entry.docId,
        title: entry.title || "Untitled",
      });
      changed++;
      if (existing) matched++; else added++;
    } catch (e) {
      console.warn("[gdocs sync] set_google_doc_link failed:", e);
      skipped++;
    }
  }

  if (changed > 0) {
    // Refresh the cached settings so the open file's link bar
    // picks up the change without waiting for the next event.
    try {
      const settings = await tauriInvoke("get_settings");
      state.settings = { ...state.settings, googleDocLinks: settings.googleDocLinks || {} };
      state.emit?.("settings-changed");
      state.emit?.("google-link-changed");
    } catch (_) {}
  }

  return { matched, added, skipped, applied: matched + added };
}

/** Push the current link map to Dropbox via the op-log. Coalesces with
 *  the meta-sync dedupe so identical re-pushes are dropped. Skipped
 *  when sync isn't configured. */
export async function pushGoogleLinksToDropbox(state) {
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return;
  const payload = await serializeGoogleLinks(state);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(GDOCS_FILENAME, payload);
}

export const GDOCS_RELATIVE_PATH = `.hush/${GDOCS_FILENAME}`;
