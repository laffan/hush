/**
 * Desks sync via `.hush/desks.json`.
 *
 * Carries the synced part of the Desks data model across devices:
 *   - the `desks` list ({ id, name, createdAt })
 *   - per-desk metadata (`desksMeta` — active style, desktop slot,
 *     persisted panes once those become per-desk in a follow-up)
 *   - the legacy `useDesks` flag, kept in the payload only so older
 *     peers that still gate on it parse modern files cleanly. Always
 *     emitted as `true`; ignored on apply.
 *
 * Local-only state (the active desk id, last-opened file per desk)
 * stays out of this payload — every device picks its own active desk.
 *
 * Apply just merges the incoming desk list into local settings and
 * runs the local wrap if the tree happens to be flat (e.g. an older
 * peer published a `useDesks: false` payload before this device
 * migrated). The unwrap branch is gone — desks are structural now.
 */

const DESKS_FILENAME = "desks.json";
const FORMAT_VERSION = 1;

export async function serializeDesks(state) {
  const s = state?.settings || {};
  return JSON.stringify({
    format: "hush-desks",
    version: FORMAT_VERSION,
    useDesks: true,
    desks: Array.isArray(s.desks) ? s.desks : [],
    desksMeta: s.desksMeta || {},
    updatedAt: Math.floor(Date.now() / 1000),
  }, null, 2);
}

export async function pushDesksToDropbox(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
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
  const desks = incomingDesks.length > 0
    ? incomingDesks
    : (state.settings?.desks || []);

  let activeDeskId = state.settings?.activeDeskId || null;
  if (!activeDeskId || !desks.some((d) => d.id === activeDeskId)) {
    activeDeskId = desks[0]?.id || null;
  }

  await state.updateSettings({
    useDesks: true,
    desks,
    desksMeta: parsed.desksMeta || {},
    activeDeskId,
  }, { fromSync: true });

  const _desks = await import("../state/state-desks.js");
  // If the local tree is still flat (legacy from a peer that hadn't
  // migrated yet), wrap it now under the first synced desk. The
  // Dropbox moves themselves arrive separately via the cursor delta.
  if (!state.fileTree.some((n) => n.type === "desk") && desks[0]) {
    await wrapTreeLocally(state, desks, _desks);
  }
  // Add tree nodes for any incoming desks the local tree doesn't carry
  // yet, plus rename existing ones whose name changed remotely. Without
  // this, an "Add desk" performed on another device leaves the receiving
  // tree without a desk node, and cursor-delivered files would land in
  // a plain folder named after the desk instead of inside the desk.
  let treeChanged = false;
  for (const d of desks) {
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
    treeChanged = true;
  }
  if (treeChanged) await state.saveFileTree();
  state.emit("desks-changed");
  state.emit("files-changed");
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
