/**
 * Dropbox cursor-based change detection.
 *
 * Replaces the per-file `checkDropboxChanges` (N round-trips) and
 * full-listing `diffDropboxSync` (path-set diff that can't tell rename
 * from delete+create) with one server-side delta query.
 *
 * On first run we seed a cursor with `/2/files/list_folder?recursive=true`
 * — every existing file is reported back, which lets us backfill
 * `remoteId` + `lastKnownRev` on entries migrated from sync_map.json. On
 * every subsequent run we ask `/2/files/list_folder/continue` for *only*
 * what's changed since the cursor, including deletes.
 *
 * Identity is keyed on Dropbox's `id` field, which is stable across
 * rename. So when a user renames `A → B` on iPad, we get one event with
 * the old id and the new path; we update the path in the sync map and
 * never invent a new internal file. This is the fix for the
 * rename-creates-duplicate bug.
 *
 * Echo suppression: every entry carries a `rev` (per-revision token). If
 * an event's rev matches our `lastKnownRev`, the change was made by us
 * (we recorded the rev when we uploaded). We skip those silently — no
 * pull-back-our-own-write loop.
 */

const SYNC_FOLDER_ID = "__dropbox_sync__";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "heif", "avif", "tif", "tiff"];

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function classifyEntry(name, relativePath) {
  const lower = (name || "").toLowerCase();
  // `.hush/*.json` is the global meta channel — single-device-config files
  // synced through the same cursor (panes.json, projects.json, styles.json).
  if (relativePath && relativePath.startsWith(".hush/") && lower.endsWith(".json")) {
    return "meta";
  }
  // `<DeskName>/.hushdesk` is the per-desk identity file — desks are
  // discovered via their folder, but their cross-device id + style +
  // last-opened-file metadata rides in this companion file.
  if (lower === ".hushdesk" && relativePath && relativePath.split("/").length === 2) {
    return "deskmeta";
  }
  if (lower.endsWith(".hushproject")) return "hushproject";
  if (lower.endsWith(".hushnote")) return "hushnote";
  if (lower.endsWith(".md")) return "md";
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) return "image";
  }
  return null;
}

function rootBase(state) {
  const p = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
  return p === "/" ? "" : p;
}

function relativeFromDisplay(display, base) {
  if (!display) return "";
  if (!base) {
    return display.startsWith("/") ? display.slice(1) : display;
  }
  if (display.length <= base.length) return "";
  // path_display preserves case; strip prefix verbatim. Path matching
  // against `base` is case-insensitive because Dropbox is.
  if (display.toLowerCase().startsWith(base.toLowerCase() + "/")) {
    return display.slice(base.length + 1);
  }
  return "";
}

function relativeFromLower(pathLower, baseLower) {
  if (!pathLower) return "";
  if (!baseLower) {
    return pathLower.startsWith("/") ? pathLower.slice(1) : pathLower;
  }
  if (pathLower.length <= baseLower.length) return "";
  if (pathLower.startsWith(baseLower + "/")) {
    return pathLower.slice(baseLower.length + 1);
  }
  return "";
}

function serverModifiedSecs(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// ===== Cursor pull =====

/**
 * Pull all events since the last cursor and dispatch them to handlers.
 * Returns the number of events processed.
 *
 * Handlers (all optional, all async):
 *   onCreated({ remoteId, rev, relativePath, dropboxPath, name, kind, serverModified })
 *   onRenamed({ internalId, oldRelativePath, newRelativePath, remoteId, rev, serverModified })
 *   onContentChanged({ internalId, relativePath, dropboxPath, rev, serverModified, kind })
 *   onDeleted({ internalId, relativePath })
 */
export async function pullDropboxCursor(state, handlers) {
  if (!state.settings.dropboxEnabled || !state.settings.dropboxSyncPath) return 0;

  const stored = await tauriInvoke("get_dropbox_cursor", { syncFolderId: SYNC_FOLDER_ID });
  const dbx = await import("./dropbox.js");

  const base = rootBase(state);
  let cursor = stored?.cursor || null;
  let total = 0;

  if (!cursor) {
    // Seed: first call after install / disconnect / cursor-reset. Issue a
    // full recursive list. Every existing entry is reported, which is
    // what backfills `remoteId`/`lastKnownRev` on legacy entries.
    cursor = await seedAndProcess(state, dbx, base, handlers, (n) => { total += n; });
  } else {
    cursor = await continueAndProcess(state, dbx, base, cursor, handlers, (n) => { total += n; });
  }

  if (cursor) {
    await tauriInvoke("set_dropbox_cursor", {
      syncFolderId: SYNC_FOLDER_ID, cursor, rootPath: base,
    });
  }
  return total;
}

async function seedAndProcess(state, dbx, base, handlers, count) {
  let data = await dbx.listFolderRaw(base, { recursive: true, includeDeleted: false });
  await processEntries(state, data.entries || [], base, handlers);
  count(data.entries?.length || 0);
  let cursor = data.cursor;

  while (data.has_more) {
    const resp = await dbx.listFolderContinueRaw(cursor);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Dropbox list_folder/continue ${resp.status}: ${txt}`);
    }
    data = await resp.json();
    await processEntries(state, data.entries || [], base, handlers);
    count(data.entries?.length || 0);
    cursor = data.cursor;
  }
  return cursor;
}

async function continueAndProcess(state, dbx, base, cursor, handlers, count) {
  while (true) {
    const resp = await dbx.listFolderContinueRaw(cursor);
    if (!resp.ok) {
      // 409 with a `reset` error means our cursor expired (>90 days or
      // server-side invalidation). Drop it and reseed on next call.
      const errBody = await resp.json().catch(() => ({}));
      const tag = errBody?.error?.[".tag"];
      if (resp.status === 409 && (tag === "reset" || errBody?.error?.reset)) {
        await tauriInvoke("clear_dropbox_cursor", { syncFolderId: SYNC_FOLDER_ID });
        return null;
      }
      throw new Error(`Dropbox list_folder/continue ${resp.status}: ${JSON.stringify(errBody)}`);
    }
    const data = await resp.json();
    await processEntries(state, data.entries || [], base, handlers);
    count(data.entries?.length || 0);
    cursor = data.cursor;
    if (!data.has_more) break;
  }
  return cursor;
}

async function processEntries(state, entries, base, handlers) {
  const baseLower = base.toLowerCase();
  const { wasOurFileRev } = await import("./meta-sync.js");

  for (const entry of entries) {
    const tag = entry[".tag"];

    if (tag === "deleted") {
      const rel = relativeFromLower(entry.path_lower || "", baseLower);
      if (!rel) continue;
      const info = await tauriInvoke("find_synced_file_by_path", {
        syncFolderId: SYNC_FOLDER_ID, relativePath: rel,
      });
      if (info && handlers.onDeleted) {
        await handlers.onDeleted({ internalId: info.internalId, relativePath: rel });
      }
      continue;
    }

    if (tag === "folder") continue; // tracked implicitly via child files
    if (tag !== "file") continue;

    const rel = relativeFromDisplay(entry.path_display, base);
    if (!rel) continue;
    const kind = classifyEntry(entry.name, rel);
    if (!kind) continue;
    if (kind === "hushproject") continue; // generated locally, ignore

    // Meta files (.hush/*.json — pane sync, future workspace state) bypass
    // the synced_files identity table since they aren't user content.
    if (kind === "meta") {
      if (handlers.onMeta) {
        await handlers.onMeta({
          relativePath: rel,
          dropboxPath: entry.path_display,
          rev: entry.rev || "",
          serverModified: serverModifiedSecs(entry.server_modified),
        });
      }
      continue;
    }

    // Per-desk metadata (<DeskName>/.hushdesk). Each desk owns its own
    // identity file rather than sharing a single .hush/desks.json.
    if (kind === "deskmeta") {
      if (handlers.onDeskMeta) {
        await handlers.onDeskMeta({
          relativePath: rel,
          dropboxPath: entry.path_display,
          rev: entry.rev || "",
          serverModified: serverModifiedSecs(entry.server_modified),
        });
      }
      continue;
    }

    let info = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: entry.id });

    if (!info) {
      // Fall back to path lookup for legacy entries (pre-cursor) whose
      // remote_id hasn't been backfilled yet.
      info = await tauriInvoke("find_synced_file_by_path", {
        syncFolderId: SYNC_FOLDER_ID, relativePath: rel,
      });
      if (info) {
        await tauriInvoke("backfill_remote_id", {
          internalId: info.internalId, remoteId: entry.id, rev: entry.rev || "",
        });
        info = { ...info, remoteId: entry.id, lastKnownRev: entry.rev || "" };
      }
    }

    if (!info) {
      if (handlers.onCreated) {
        await handlers.onCreated({
          remoteId: entry.id,
          rev: entry.rev || "",
          relativePath: rel,
          dropboxPath: entry.path_display,
          name: entry.name,
          kind,
          serverModified: serverModifiedSecs(entry.server_modified),
        });
      }
      continue;
    }

    // Echo suppression: this rev is one we wrote ourselves. The
    // SQLite-backed `lastKnownRev` is one slot — fast successive pushes
    // bump it past the rev Dropbox eventually reports back. The
    // per-file ring (populated in `executeUpload`) covers the
    // recent-history gap.
    if (entry.rev && (
      (info.lastKnownRev && info.lastKnownRev === entry.rev) ||
      wasOurFileRev(info.internalId, entry.rev)
    )) {
      continue;
    }

    // Path differs → rename.
    if (info.relativePath !== rel) {
      if (handlers.onRenamed) {
        await handlers.onRenamed({
          internalId: info.internalId,
          oldRelativePath: info.relativePath,
          newRelativePath: rel,
          remoteId: entry.id,
          rev: entry.rev || "",
          serverModified: serverModifiedSecs(entry.server_modified),
          kind,
        });
      }
      continue;
    }

    // Same path, different rev → content change.
    if (handlers.onContentChanged) {
      await handlers.onContentChanged({
        internalId: info.internalId,
        relativePath: rel,
        dropboxPath: entry.path_display,
        rev: entry.rev || "",
        serverModified: serverModifiedSecs(entry.server_modified),
        kind,
      });
    }
  }
}
