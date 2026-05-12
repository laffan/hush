/**
 * Desks sync via `.hush/desks.json`.
 *
 * Carries the synced part of the Desks data model across devices:
 *   - the `desks` list ({ id, name, createdAt })
 *   - per-desk metadata (`desksMeta` — active style, last-opened file)
 *   - the legacy `useDesks` flag, kept in the payload only so older
 *     peers that still gate on it parse modern files cleanly. Always
 *     emitted as `true`; ignored on apply.
 *
 * The active desk id is intentionally local-per-device.
 *
 * Per-desk last-opened file: stored locally as `lastFileId` (the
 * device's own UUID) but published on the wire as `lastFileRemoteId`
 * (Dropbox's cross-device-stable id). `metaToWire` does the translate
 * on serialize; the apply branch resolves the remote id back to a
 * local fileId via `find_synced_file_by_remote_id`. Files without a
 * remote_id (Local Sync, never-synced) ride as null and the receiving
 * device falls back to "first inbox item" when the user switches in.
 *
 * Apply merges the incoming desk list into local settings and runs
 * the local wrap if the tree happens to be flat (e.g. an older peer
 * published a `useDesks: false` payload before this device migrated).
 */

const DESKS_FILENAME = "desks.json";
const FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Translate a local fileId → its Dropbox `remote_id` for the wire
 *  format. Returns null when the file isn't tracked in the sync map
 *  (Local Sync, never-synced) — those entries can't be resolved on
 *  the receiving device, so the slot rides as null. */
async function fileIdToRemoteId(fileId) {
  if (!fileId) return null;
  try {
    const info = await tauriInvoke("get_sync_file_info", { internalId: fileId });
    return info?.remoteId || null;
  } catch (_) { return null; }
}

/** Build the per-desk meta payload for the wire. The local format
 *  carries `lastFileId` (a per-device UUID); the wire format carries
 *  `lastFileRemoteId` (Dropbox-stable). `lastFileType` rides through
 *  unchanged so the receiving device knows which open path to take.
 *  We also keep the local `lastFileId` in the wire so a peer that hits
 *  back-to-back syncs without translating gets a sane fallback, but
 *  the apply path always prefers `lastFileRemoteId` when present. */
async function metaToWire(meta) {
  const out = {};
  for (const [deskId, entry] of Object.entries(meta || {})) {
    if (!entry || typeof entry !== "object") continue;
    const wire = { ...entry };
    if (entry.lastFileId) {
      const remote = await fileIdToRemoteId(entry.lastFileId);
      if (remote) wire.lastFileRemoteId = remote;
      // Strip the device-local lastFileId from the published payload —
      // peer's fileId map doesn't know our UUIDs and a stale value
      // there would only confuse the apply branch.
      delete wire.lastFileId;
    }
    out[deskId] = wire;
  }
  return out;
}

export async function serializeDesks(state) {
  const s = state?.settings || {};
  return JSON.stringify({
    format: "hush-desks",
    version: FORMAT_VERSION,
    useDesks: true,
    desks: Array.isArray(s.desks) ? s.desks : [],
    desksMeta: await metaToWire(s.desksMeta || {}),
    updatedAt: Math.floor(Date.now() / 1000),
  }, null, 2);
}

export async function pushDesksToDropbox(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  // Reseed in flight: the local desk list is mid-rebuild. A push here
  // would write our half-built state over Dropbox's authoritative copy.
  if (state.runtime?.reseedActive) return;
  const payload = await serializeDesks(state);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(DESKS_FILENAME, payload);
}

export async function applyDesksFile(state, payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { applied: 0, error: "parse" }; }
  if (!parsed || parsed.format !== "hush-desks") return { applied: 0, error: "format" };

  // Merge the incoming desk list. If the payload is empty (e.g. an
  // older peer that still serialized `useDesks: false` with no desks),
  // keep whatever desks we already have — the receiving device's
  // structural always-on guarantee owns the local list in that case.
  const incomingDesks = Array.isArray(parsed.desks) ? parsed.desks : [];
  const _desks = await import("../state/state-desks.js");

  // If the local tree is still flat (legacy from a peer that hadn't
  // migrated yet), wrap it now under the first synced desk. The
  // Dropbox moves themselves arrive separately via the cursor delta.
  if (!state.fileTree.some((n) => n.type === "desk") && incomingDesks[0]) {
    await wrapTreeLocally(state, incomingDesks, _desks);
  }

  // Same-name reconciliation: if both devices independently created a
  // desk with the same name, merge them by reassigning the local
  // desk's id (and its per-desk specials) to the incoming id. This is
  // the "we both made a 'Personal' desk on first boot" case.
  const renamedDeskIds = _desks.reassignDeskIdByName(state, incomingDesks);

  // Add tree nodes for any incoming desks the local tree doesn't carry
  // yet. For each new desk, absorb any same-named "ghost" folder the
  // cursor delta may have built before this payload arrived (the
  // <DeskName>/Inbox/Doc.md events that arrived before .hush/desks.json).
  let treeChanged = renamedDeskIds.size > 0;
  for (const d of incomingDesks) {
    if (!d?.id) continue;
    const existing = state.fileTree.find((n) => n.type === "desk" && n.id === d.id);
    if (existing) {
      if (d.name && existing.name !== d.name) { existing.name = d.name; treeChanged = true; }
      continue;
    }
    const desk = {
      id: d.id, type: "desk", name: d.name || "Untitled desk",
      children: [], flagged: false,
      createdAt: d.createdAt || Math.floor(Date.now() / 1000),
    };
    _desks.ensureDeskSpecials(desk);
    state.fileTree.push(desk);
    _desks.absorbMatchingFolder(state, desk);
    treeChanged = true;
  }
  // One more pass: for desks we already had, sweep up any matching
  // folders that may be sitting at the top level or nested inside
  // another desk. Catches the case where the file events arrived
  // before applyDesksFile ever ran (or before this fix landed).
  if (_desks.reconcileDesksWithStrayFolders(state) > 0) treeChanged = true;

  // Preserve any local desks the incoming list didn't mention. Without
  // this the receiving device would lose desks it created but never
  // had the chance to publish — e.g. if a desk was added between
  // sync cycles.
  const localDeskIds = state.fileTree.filter((n) => n.type === "desk").map((n) => n.id);
  const incomingIds = new Set(incomingDesks.map((d) => d?.id).filter(Boolean));
  const mergedDesks = [...incomingDesks];
  for (const id of localDeskIds) {
    if (incomingIds.has(id)) continue;
    const node = state.fileTree.find((n) => n.id === id);
    mergedDesks.push({
      id, name: node?.name || "Untitled desk",
      createdAt: node?.createdAt || Math.floor(Date.now() / 1000),
    });
  }
  const desks = mergedDesks.length > 0 ? mergedDesks : (state.settings?.desks || []);

  let activeDeskId = state.settings?.activeDeskId || null;
  if (renamedDeskIds.has(activeDeskId)) activeDeskId = renamedDeskIds.get(activeDeskId);
  if (!activeDeskId || !desks.some((d) => d.id === activeDeskId)) {
    activeDeskId = desks[0]?.id || null;
  }

  // Per-desk meta is merged key-by-key rather than replaced wholesale
  // so a payload from one device can't blow away another device's
  // saved choices for desks the sender hasn't touched yet. Within an
  // entry, last writer wins on a per-field basis.
  const localMeta = state.settings?.desksMeta || {};
  const remoteMeta = parsed.desksMeta && typeof parsed.desksMeta === "object"
    ? parsed.desksMeta : {};
  const validIds = new Set(desks.map((d) => d.id));
  const mergedMeta = {};
  for (const id of validIds) {
    const oldId = [...renamedDeskIds.entries()].find(([_, v]) => v === id)?.[0];
    const a = localMeta[id] || (oldId ? localMeta[oldId] : undefined);
    const b = remoteMeta[id];
    let merged;
    if (a && b) merged = { ...a, ...b };
    else if (a || b) merged = a || b;
    if (merged) {
      // Translate the wire's `lastFileRemoteId` back to a local fileId.
      // Resolution happens via the sync map, so untracked files (Local
      // Sync, never-synced) leave the slot null and the receiving
      // device falls back to "first inbox item" on a desk switch.
      // Important: only override the local `lastFileId` when the
      // resolution succeeds — a peer with no remote_id for its choice
      // shouldn't blow away our resolvable choice.
      if (merged.lastFileRemoteId) {
        let info = null;
        try { info = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: merged.lastFileRemoteId }); }
        catch (_) { /* ignore */ }
        if (info?.internalId) merged.lastFileId = info.internalId;
        else if (a?.lastFileId) merged.lastFileId = a.lastFileId;
      }
      mergedMeta[id] = merged;
    }
  }

  await state.updateSettings({
    useDesks: true,
    desks,
    desksMeta: mergedMeta,
    activeDeskId,
  }, { fromSync: true });

  if (treeChanged) await state.saveFileTree();
  state.emit("desks-changed");
  state.emit("files-changed");

  // Merge-back: if our local list ended up larger than what Dropbox sent
  // (we had desks the sender hadn't published yet, e.g. simultaneous
  // first-activation race), push the merged list back so peers see the
  // full union. Without this, a desk created on the second-activated
  // device would never reach the first.
  if (desks.length > incomingDesks.length) {
    pushDesksToDropbox(state).catch((e) => console.warn("desks: merge-back push failed:", e));
  }

  return { applied: 1 };
}

/** Local-only mirror of `enableDesks` for a sync-driven flip. The
 *  desk id is taken from the synced desk list (so both devices end
 *  up with the same id), but the file content reorganization is local. */
async function wrapTreeLocally(state, desks, _desks) {
  if (state.fileTree.some((n) => n.type === "desk")) return; // already wrapped
  const target = desks[0];
  if (!target) return;
  const t = state.fileTree;
  const popById = (id) => { const i = t.findIndex((n) => n.id === id); return i < 0 ? null : t.splice(i, 1)[0]; };
  const inbox = popById("__inbox__");
  const images = popById("__images__");
  const trash = popById("__trash__");
  const desk = { id: target.id, type: "desk", name: target.name, children: [], flagged: false, createdAt: target.createdAt };
  if (inbox) { inbox.id = `__inbox__:${target.id}`; desk.children.push(inbox); }
  while (t.length > 0) desk.children.push(t.shift());
  if (images) { images.id = `__images__:${target.id}`; desk.children.push(images); }
  if (trash) { trash.id = `__trash__:${target.id}`; desk.children.push(trash); }
  _desks.ensureDeskSpecials(desk);
  t.push(desk);
  await state.saveFileTree();
}

export const DESKS_RELATIVE_PATH = `.hush/${DESKS_FILENAME}`;
