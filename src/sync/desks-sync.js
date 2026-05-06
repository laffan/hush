/**
 * Desks sync via `.hush/desks.json`.
 *
 * Carries the synced part of the Desks data model across devices:
 *   - `useDesks` flag
 *   - the `desks` list ({ id, name, createdAt })
 *   - per-desk metadata (`desksMeta` — active style, desktop slot,
 *     persisted panes once those become per-desk in a follow-up)
 *
 * Local-only state (the active desk id, last-opened file per desk)
 * stays out of this payload — every device picks its own active desk.
 *
 * On apply, when the receiving device sees `useDesks` flip from off
 * to on, it runs the local tree wrap (no Dropbox writes — the source
 * device already enqueued the moves). When `useDesks` flips off, the
 * receiving device runs the local unwrap.
 */

const DESKS_FILENAME = "desks.json";
const FORMAT_VERSION = 1;

export async function serializeDesks(state) {
  const s = state?.settings || {};
  return JSON.stringify({
    format: "hush-desks",
    version: FORMAT_VERSION,
    useDesks: !!s.useDesks,
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

  const wasOn = !!state.settings?.useDesks;
  const willBeOn = !!parsed.useDesks;

  // Apply the synced fields. Local activeDeskId is preserved when
  // possible (defaults to first desk if the previous active is gone).
  const incomingDesks = Array.isArray(parsed.desks) ? parsed.desks : [];
  let activeDeskId = state.settings?.activeDeskId || null;
  if (willBeOn && (!activeDeskId || !incomingDesks.some((d) => d.id === activeDeskId))) {
    activeDeskId = incomingDesks[0]?.id || null;
  }
  if (!willBeOn) activeDeskId = null;

  await state.updateSettings({
    useDesks: willBeOn,
    desks: incomingDesks,
    desksMeta: parsed.desksMeta || {},
    activeDeskId,
  }, { fromSync: true });

  // Local tree shape: wrap on flip-on, unwrap on flip-off. The Dropbox
  // moves themselves arrive separately via the cursor delta; we only
  // need to mutate the local fileTree to match the new shape.
  if (!wasOn && willBeOn) {
    const _desks = await import("../state/state-desks.js");
    await wrapTreeLocally(state, incomingDesks, _desks);
  } else if (wasOn && !willBeOn) {
    const _desks = await import("../state/state-desks.js");
    await unwrapTreeLocally(state, _desks);
  }
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

/** Local-only mirror of `disableDesks`. */
async function unwrapTreeLocally(state, _desks) {
  const t = state.fileTree;
  const desks = t.filter((n) => n.type === "desk");
  if (desks.length === 0) return;
  const inbox = { id: "__inbox__", type: "project", name: "Inbox", children: [], flagged: false };
  const images = { id: "__images__", type: "folder", name: "Images", children: [], flagged: false };
  const trash = { id: "__trash__", type: "folder", name: "Trash", children: [], flagged: false };
  const hoisted = [];
  const isSingleDesk = desks.length === 1;
  for (const d of desks) {
    const nonSpecials = [];
    for (const c of (d.children || [])) {
      if (c.id?.startsWith("__inbox__:")) inbox.children.push(...(c.children || []));
      else if (c.id?.startsWith("__images__:")) images.children.push(...(c.children || []));
      else if (c.id?.startsWith("__trash__:")) trash.children.push(...(c.children || []));
      else nonSpecials.push(c);
    }
    if (isSingleDesk || nonSpecials.length === 0) hoisted.push(...nonSpecials);
    else hoisted.push({ id: crypto.randomUUID(), type: "folder", name: d.name || "Untitled desk", children: nonSpecials, flagged: false });
  }
  t.length = 0;
  t.push(inbox, ...hoisted, images, trash);
  await state.saveFileTree();
}

export const DESKS_RELATIVE_PATH = `.hush/${DESKS_FILENAME}`;
