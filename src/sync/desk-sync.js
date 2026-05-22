/**
 * Per-desk identity via `<DeskName>/.hushdesk`.
 *
 * Replaces the single `.hush/desks.json` registry. The desk list is now
 * derived from the file tree: every top-level folder under the sync
 * root is a desk, and each desk's identity / cross-device metadata
 * (id, createdAt, style, last-opened file) lives in a `.hushdesk`
 * sitting inside the desk's folder.
 *
 * Why per-folder:
 *   * The folder's existence IS the desk. No second source of truth
 *     to drift apart from the filesystem.
 *   * Renaming a desk = renaming the folder; the .hushdesk rides
 *     along automatically.
 *   * Same-name conflicts on two devices collapse into the existing
 *     folder-collision auto-suffix path. No bespoke list-merge logic.
 *
 * Schema (v1):
 *   {
 *     "format": "hush-desk",
 *     "version": 1,
 *     "id": "<stable uuid>",
 *     "name": "Personal",
 *     "createdAt": 1778540467,
 *     "style": { "globalStyleId": "..." | null },
 *     "lastFile": { "remoteId": "id:...", "type": "document" } | null,
 *     "updatedAt": 1778540999
 *   }
 *
 * Identity rules:
 *   * If a desk has no .hushdesk yet (mid-sync transient, or a folder
 *     a user dropped in manually), the local tree gets a temp id; when
 *     the .hushdesk arrives, `reassignDeskIdByName` reassigns the temp
 *     id to the canonical one and rewrites per-desk special ids.
 *   * If a desk has no .hushdesk after a full seed completes, the seed
 *     auto-creates one with a fresh uuid and pushes it.
 */

const DESK_FILENAME = ".hushdesk";
const FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Translate a local fileId → Dropbox `remote_id` for the wire format.
 *  Returns null when the file isn't tracked in the sync map. */
async function fileIdToRemoteId(fileId) {
  if (!fileId) return null;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    return info?.remoteId || null;
  } catch (_) { return null; }
}

/** Build the wire payload for a single desk. */
export async function serializeDesk(state, desk) {
  if (!desk) return null;
  const meta = state.settings?.desksMeta?.[desk.id] || {};
  const styleId = meta.globalStyleId || null;
  let lastFile = null;
  if (meta.lastFileId) {
    const remoteId = await fileIdToRemoteId(meta.lastFileId);
    if (remoteId) lastFile = { remoteId, type: meta.lastFileType || "document" };
  }
  return JSON.stringify({
    format: "hush-desk",
    version: FORMAT_VERSION,
    id: desk.id,
    name: desk.name || "Untitled desk",
    createdAt: desk.createdAt || Math.floor(Date.now() / 1000),
    style: { globalStyleId: styleId },
    lastFile,
    updatedAt: Math.floor(Date.now() / 1000),
  }, null, 2);
}

/** Push a single desk's `.hushdesk` to Dropbox via the op-log. Skipped
 *  during reseed so half-built tree shapes don't leak back. */
export async function pushDesk(state, desk) {
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return;
  if (!desk || !desk.name) return;
  const payload = await serializeDesk(state, desk);
  if (!payload) return;
  const path = `${desk.name}/${DESK_FILENAME}`;
  const { enqueueUploadPayload, triggerDrain } = await import("./op-log.js");
  await enqueueUploadPayload({ path, payload });
  triggerDrain(state);
}

/** Push every desk in the current tree. Used by the one-shot migration
 *  off `desks.json` and as the "publish the list" entry point that the
 *  rest of the codebase replaces `pushDesksToDropbox` with. */
export async function pushAllDesks(state) {
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return;
  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  for (const desk of desks) {
    try { await pushDesk(state, desk); }
    catch (e) { console.warn("desks: push for", desk.name, "failed:", e); }
  }
}

/** Pull the desk name out of `<DeskName>/.hushdesk`. Returns "" if the
 *  path doesn't match the per-desk pattern (anything nested deeper, or
 *  named differently, is ignored). */
export function parseDeskRelativePath(relativePath) {
  if (!relativePath) return "";
  const parts = relativePath.split("/");
  if (parts.length !== 2) return "";
  if (parts[1] !== DESK_FILENAME) return "";
  return parts[0] || "";
}

/**
 * Apply an incoming `.hushdesk` to local state. Creates or updates the
 * desk node, reconciles desk id by name if local + remote disagree,
 * merges per-desk style + last-opened-file metadata.
 *
 * `relativePath` is the file's path relative to the sync root, e.g.
 * "Personal/.hushdesk". The caller (cursor consumer) is expected to
 * have already verified this is a `.hushdesk` entry.
 */
export async function applyDeskFile(state, payload, relativePath) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { applied: 0, error: "parse" }; }
  if (!parsed || parsed.format !== "hush-desk") return { applied: 0, error: "format" };

  const incomingId = parsed.id || "";
  const incomingName = parsed.name || parseDeskRelativePath(relativePath);
  if (!incomingId || !incomingName) return { applied: 0, error: "incomplete" };

  const _desks = await import("../state/state-desks.js");
  const tree = state.fileTree || [];

  // First try id match — desks that have already round-tripped here
  // will resolve straight to their canonical node.
  let desk = tree.find((n) => n.type === "desk" && n.id === incomingId);

  // Tracks the local id that just got replaced (if any). settings.desks
  // and desksMeta entries keyed on this id need to be pruned at the
  // bottom so the desk switcher doesn't end up with duplicate rows.
  let replacedOldId = null;

  // No id match: try name match. Local tree may have a same-name desk
  // with a different (temp / older) id; reassign in place so per-desk
  // specials keep pointing at the right desk.
  if (!desk) {
    const byName = tree.find((n) => n.type === "desk" && n.name === incomingName);
    if (byName) {
      const oldId = byName.id;
      replacedOldId = oldId;
      byName.id = incomingId;
      for (const c of (byName.children || [])) {
        const parsedId = _desks.parseSpecialNodeId?.(c?.id);
        if (parsedId) c.id = _desks.specialNodeId(parsedId.kind, incomingId);
      }
      if (state.settings?.activeDeskId === oldId) {
        await state.updateSettings({ activeDeskId: incomingId });
      }
      desk = byName;
    }
  }

  // No id and no name match: a brand-new desk arriving from another
  // device. Create the desk node, ensure its specials, and absorb any
  // same-named plain folder that the cursor pulled in before us.
  if (!desk) {
    desk = {
      id: incomingId,
      type: "desk",
      name: incomingName,
      children: [],
      flagged: false,
      createdAt: parsed.createdAt || Math.floor(Date.now() / 1000),
    };
    _desks.ensureDeskSpecials(desk);
    tree.push(desk);
    _desks.absorbMatchingFolder(state, desk);
  } else {
    if (parsed.createdAt && !desk.createdAt) desk.createdAt = parsed.createdAt;
    if (desk.name !== incomingName) desk.name = incomingName;
    _desks.ensureDeskSpecials(desk);
  }

  // Merge per-desk meta. Style is "last write wins per field"; the
  // incoming lastFile.remoteId is resolved to a local fileId via the
  // sync map (untracked files leave the slot null).
  const meta = { ...(state.settings?.desksMeta || {}) };
  const cur = meta[incomingId] || {};
  const merged = { ...cur };
  if (parsed.style && Object.prototype.hasOwnProperty.call(parsed.style, "globalStyleId")) {
    merged.globalStyleId = parsed.style.globalStyleId;
  }
  if (parsed.lastFile?.remoteId) {
    try {
      const info = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: parsed.lastFile.remoteId });
      if (info?.internalId) {
        merged.lastFileId = info.internalId;
        merged.lastFileType = parsed.lastFile.type || "document";
      }
    } catch (_) { /* leave existing */ }
  }
  meta[incomingId] = merged;
  // Carry the old desk's per-desk meta over to the new id, then drop
  // the old key. Without this, replacedOldId keeps living in
  // desksMeta as an orphan even after the matching settings.desks
  // entry is pruned.
  if (replacedOldId && replacedOldId !== incomingId && meta[replacedOldId]) {
    meta[incomingId] = { ...meta[replacedOldId], ...meta[incomingId] };
    delete meta[replacedOldId];
  }

  // Update settings.desks. Insert / update the incomingId entry. When
  // a name-match reassignment just happened, ALSO drop the now-orphan
  // oldId entry so the desk switcher stops showing duplicate rows for
  // the same desk name. Finally, prune any entry that no longer has a
  // corresponding tree node (race-recovery — earlier code paths could
  // leak orphans across long sequences of reassignments).
  let desksList = (state.settings?.desks || []).slice();
  const i = desksList.findIndex((d) => d.id === incomingId);
  if (i < 0) desksList.push({ id: incomingId, name: incomingName, createdAt: desk.createdAt });
  else desksList[i] = { ...desksList[i], name: incomingName, createdAt: desk.createdAt };
  if (replacedOldId && replacedOldId !== incomingId) {
    desksList = desksList.filter((d) => d.id !== replacedOldId);
  }
  const treeDeskIds = new Set(tree.filter((n) => n?.type === "desk").map((n) => n.id));
  desksList = desksList.filter((d) => treeDeskIds.has(d.id));

  await state.updateSettings({ desks: desksList, desksMeta: meta }, { fromSync: true });
  await state.saveFileTree();
  state.emit("desks-changed");
  state.emit("files-changed");
  return { applied: 1, matched: 1 };
}

/**
 * After a Clear Local Versions reseed completes, the cursor has built
 * the tree from Dropbox. Top-level folders were created as desk nodes
 * by `insertDocumentNode` already, but a few things still need to
 * happen before the reseed can declare itself done:
 *
 *   1. `settings.desks` (the registry the sidebar / active-desk lookup
 *      reads) needs to be populated from the tree's desk nodes — the
 *      reseed left it empty.
 *   2. `settings.activeDeskId` must point at an existing desk so a
 *      desk switcher render doesn't pick a missing id.
 *   3. Each desk needs Inbox / Trash / Images specials (the cursor
 *      seed may not have created them if no files arrived inside).
 *   4. Empty top-level folders that don't yet exist as tree desk
 *      nodes (rare — only if the user pre-created a folder in
 *      Dropbox with no content inside) still need to be discovered;
 *      they appear in the recursive listing as `folder` entries.
 *
 * Without (1) and (2), the next boot's `migrateLegacyTreeIfNeeded`
 * sees `settings.desks = []` paired with a tree full of desk nodes
 * and the boot path stays in a weird half-state. With them, the
 * tree, the settings, and the Dropbox layout are all in agreement.
 */
export async function finalizeDesks(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  const _desks = await import("../state/state-desks.js");

  // Discover any top-level folder that wasn't represented in the tree
  // because no files inside arrived (empty-folder case). The recursive
  // listing was already done by `clearLocalAndReseed`'s pre-count, but
  // we re-list non-recursively here since that's cheap.
  try {
    const dbx = await import("./dropbox.js");
    const base = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
    const root = base === "/" ? "" : base;
    const data = await dbx.listFolderRaw(root, { recursive: false, includeDeleted: false });
    for (const e of (data?.entries || [])) {
      if (e[".tag"] !== "folder") continue;
      const folderName = e.name;
      if (!folderName || folderName.startsWith(".")) continue;
      const exists = (state.fileTree || []).some(
        (n) => (n.type === "desk" || n.type === "folder") && n.name === folderName
      );
      if (!exists) {
        const deskId = crypto.randomUUID();
        const desk = {
          id: deskId, type: "desk", name: folderName,
          children: [], flagged: false,
          createdAt: Math.floor(Date.now() / 1000),
        };
        _desks.ensureDeskSpecials(desk);
        state.fileTree.push(desk);
      }
    }
  } catch (e) { console.warn("finalize: empty-folder discovery failed:", e); }

  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  for (const desk of desks) {
    _desks.ensureDeskSpecials(desk);
    if (!desk.createdAt) desk.createdAt = Math.floor(Date.now() / 1000);
  }

  // Populate the settings registry from the tree so subsequent boots
  // see a consistent picture. Per-desk style/last-file metadata can
  // live in an empty stub here; `applyDeskFile` will fill in the
  // remote-published values as each `.hushdesk` lands via the cursor.
  const desksRegistry = desks.map((d) => ({
    id: d.id, name: d.name, createdAt: d.createdAt || Math.floor(Date.now() / 1000),
  }));
  const meta = { ...(state.settings?.desksMeta || {}) };
  for (const d of desks) {
    if (!meta[d.id]) meta[d.id] = { globalStyleId: null };
  }
  const activeDeskId = state.settings?.activeDeskId && desks.some((d) => d.id === state.settings.activeDeskId)
    ? state.settings.activeDeskId
    : (desks[0]?.id || null);

  await state.updateSettings({
    desks: desksRegistry,
    desksMeta: meta,
    activeDeskId,
  }, { fromSync: true });

  await state.saveFileTree();
  state.emit("desks-changed");
}

/**
 * One-shot migration off `.hush/desks.json`. On the first cycle after
 * the schema change, if Dropbox still has `.hush/desks.json` and at
 * least one desk lacks a `.hushdesk` (or the legacy file exists in any
 * form), read `desks.json`, write a `.hushdesk` for each entry, then
 * delete `.hush/desks.json` from Dropbox.
 *
 * Idempotent: a second call notices the legacy file is gone and exits.
 */
export async function migrateFromDesksJson(state) {
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return false;

  const dbx = await import("./dropbox.js");
  const base = (state.settings.dropboxSyncPath || "").replace(/\/+$/, "");
  const root = base === "/" ? "" : base;
  const legacyPath = `${root}/.hush/desks.json`;

  const meta = await dbx.getMetadata(legacyPath).catch(() => null);
  if (!meta) return false; // already migrated or never existed

  let payload;
  try { payload = await dbx.downloadFile(legacyPath); }
  catch (e) { console.warn("migrate: download desks.json failed:", e); return false; }

  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { console.warn("migrate: desks.json unparseable"); return false; }

  const legacyDesks = Array.isArray(parsed?.desks) ? parsed.desks : [];
  const legacyMeta = parsed?.desksMeta || {};

  // For each desk in the local tree, attach an id+createdAt from the
  // legacy file when names match. Push each desk's .hushdesk.
  const treeDesks = (state.fileTree || []).filter((n) => n.type === "desk");
  for (const desk of treeDesks) {
    const legacy = legacyDesks.find((d) => d.name === desk.name);
    if (legacy?.id && desk.id !== legacy.id) {
      // Carry the legacy id forward so cross-device identity is preserved.
      const _desks = await import("../state/state-desks.js");
      const oldId = desk.id;
      desk.id = legacy.id;
      for (const c of (desk.children || [])) {
        const p = _desks.parseSpecialNodeId?.(c?.id);
        if (p) c.id = _desks.specialNodeId(p.kind, legacy.id);
      }
      if (state.settings?.activeDeskId === oldId) {
        await state.updateSettings({ activeDeskId: legacy.id });
      }
    }
    if (legacy?.createdAt && !desk.createdAt) desk.createdAt = legacy.createdAt;
    const lm = legacyMeta[desk.id];
    if (lm) {
      const all = { ...(state.settings?.desksMeta || {}) };
      all[desk.id] = { ...(all[desk.id] || {}), ...lm };
      await state.updateSettings({ desksMeta: all }, { fromSync: true });
    }
    await pushDesk(state, desk);
  }

  // Also write a .hushdesk for any legacy entry that isn't represented
  // by a folder in the tree yet — the matching folder may sync down on
  // a later cycle, at which point applyDeskFile will hydrate the desk.
  for (const d of legacyDesks) {
    if (treeDesks.some((t) => t.name === d.name)) continue;
    const minimalDesk = {
      id: d.id, name: d.name, createdAt: d.createdAt || Math.floor(Date.now() / 1000),
    };
    // Build the payload without going through serializeDesk (no
    // desksMeta path lookup needed for an orphan).
    const body = JSON.stringify({
      format: "hush-desk", version: FORMAT_VERSION,
      id: minimalDesk.id, name: minimalDesk.name, createdAt: minimalDesk.createdAt,
      style: { globalStyleId: legacyMeta[d.id]?.globalStyleId || null },
      lastFile: null,
      updatedAt: Math.floor(Date.now() / 1000),
    }, null, 2);
    const { enqueueUploadPayload } = await import("./op-log.js");
    await enqueueUploadPayload({ path: `${minimalDesk.name}/${DESK_FILENAME}`, payload: body });
  }

  // Delete the legacy file from Dropbox. After this returns, the
  // cursor delta will report `.hush/desks.json` as deleted; that's a
  // no-op for us since we don't have a synced_files entry for it.
  try {
    await dbx.deleteEntry(legacyPath);
  } catch (e) {
    console.warn("migrate: failed to delete .hush/desks.json:", e);
  }

  const { triggerDrain } = await import("./op-log.js");
  triggerDrain(state);
  return true;
}

export const DESK_FILENAME_CONST = DESK_FILENAME;
