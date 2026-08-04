/**
 * Desks — top-level containers above all other file-tree nodes.
 *
 * Desks are part of the structural model, not an opt-in feature. The
 * top level of the file tree is always one or more `type: "desk"`
 * nodes; each carries its own namespaced Inbox / Images / Trash plus
 * the user's content.
 *
 * Special-node IDs are shaped `<kind>:<deskId>`:
 *   - `__inbox__:<deskId>`, `__images__:<deskId>`, `__trash__:<deskId>`
 *
 * The legacy bare ids (`__inbox__`, `__images__`, `__trash__`) only
 * surface on disk for installs created before the always-on
 * migration — `migrateLegacyTreeIfNeeded` rewrites them on first boot.
 *
 * `enableDesks(state, name)` wraps an unwrapped tree under a new desk
 * named `name` (default "Personal"). Used by the boot migration.
 *
 * Active-desk-id is per-device; it's stored on `settings` for
 * persistence.
 */

import { pushDeskRecentFile } from "./recent-files.js";
import { logActivity } from "../activity-log.js";

const SPECIAL_KINDS = ["__inbox__", "__images__", "__pdfs__", "__archive__", "__trash__"];

/** Fire-and-forget write-through of a desk's portable meta (style,
 *  last file, stickies) into its `.hushdesk` — see sync/desk-meta.js. */
function mirrorDeskMeta(state, deskId) {
  if (!deskId) return;
  import("../sync/desk-meta.js")
    .then(({ pushDeskMeta }) => pushDeskMeta(state, deskId))
    .catch(() => {});
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Build a special-node id for a given desk. With `deskId` null,
 *  returns the legacy global id. */
export function specialNodeId(kind, deskId) {
  if (!SPECIAL_KINDS.includes(kind)) throw new Error(`unknown special kind: ${kind}`);
  return deskId ? `${kind}:${deskId}` : kind;
}

/** True if `id` is any special node (across any desk + the legacy
 *  flat-tree ids). Match-by-prefix avoids hardcoding every desk id. */
export function isSpecialNodeId(id) {
  if (!id) return false;
  if (SPECIAL_KINDS.includes(id)) return true;
  return SPECIAL_KINDS.some((kind) => id.startsWith(kind + ":"));
}

/** Decode `__inbox__:abc123` → { kind: "__inbox__", deskId: "abc123" }.
 *  Returns null for non-special ids. */
export function parseSpecialNodeId(id) {
  if (!id) return null;
  if (SPECIAL_KINDS.includes(id)) return { kind: id, deskId: null };
  for (const kind of SPECIAL_KINDS) {
    if (id.startsWith(kind + ":")) return { kind, deskId: id.slice(kind.length + 1) };
  }
  return null;
}

export function getActiveDesk(state) {
  const tree = state.fileTree || [];
  const id = state.settings?.activeDeskId;
  if (id) {
    const match = tree.find((n) => n.type === "desk" && n.id === id);
    if (match) return match;
  }
  return tree.find((n) => n.type === "desk") || null;
}

/** Resolve the special-node id for the active desk. Falls back to the
 *  legacy bare id only if the migration hasn't run yet (defensive — the
 *  boot path runs `migrateLegacyTreeIfNeeded` before anything else
 *  reads specials). */
export function activeSpecialId(state, kind) {
  const desk = getActiveDesk(state);
  if (!desk) return kind;
  return specialNodeId(kind, desk.id);
}

/** Ensure each desk node has its own Inbox / Images / Archive / Trash
 *  children with the correct ordering (Inbox first; Images / Archive /
 *  Trash pinned to the tail). Returns the ids of any specials it had to
 *  create this call, so callers can react to a first-time appearance
 *  (e.g. collapsing a freshly-added Archive on an existing install). */
export function ensureDeskSpecials(deskNode) {
  if (!deskNode || deskNode.type !== "desk") return [];
  if (!Array.isArray(deskNode.children)) deskNode.children = [];
  const c = deskNode.children;
  const created = [];
  const ensure = (kind, type, name) => {
    const id = specialNodeId(kind, deskNode.id);
    if (!c.some((n) => n.id === id)) {
      const node = { id, type, name, children: [], flagged: false };
      if (kind === "__inbox__") c.unshift(node); else c.push(node);
      created.push(id);
    }
  };
  ensure("__inbox__", "project", "Inbox");
  ensure("__images__", "folder", "Images");
  ensure("__archive__", "folder", "Archive");
  ensure("__trash__", "folder", "Trash");
  // Order: Inbox first; Images, Archive then Trash pinned to the tail
  // (Archive sits directly above Trash). PDFs, minted lazily elsewhere,
  // is slotted between Images and Archive by pinSpecialsInList at render.
  const moveTo = (id, idx) => {
    const i = c.findIndex((n) => n.id === id);
    if (i >= 0 && i !== idx) { const [n] = c.splice(i, 1); c.splice(idx, 0, n); }
  };
  moveTo(specialNodeId("__inbox__", deskNode.id), 0);
  moveTo(specialNodeId("__trash__", deskNode.id), c.length - 1);
  moveTo(specialNodeId("__archive__", deskNode.id), c.length - 2);
  moveTo(specialNodeId("__images__", deskNode.id), c.length - 3);
  return created;
}

/** Wrap the existing flat tree under a single new desk. Used by the
 *  boot migration for legacy users and by sync apply when an older
 *  peer flips desks on. No-ops when the tree already has at least one
 *  desk node. */
export async function enableDesks(state, name = "Personal") {
  const t = state.fileTree || [];
  if (t.some((n) => n.type === "desk")) return;

  // Pull the legacy specials out of the top level (we'll re-namespace
  // their ids under the new desk so children stay attached).
  const popById = (id) => {
    const i = t.findIndex((n) => n.id === id);
    if (i < 0) return null;
    return t.splice(i, 1)[0];
  };
  const inbox = popById("__inbox__");
  const images = popById("__images__");
  const trash = popById("__trash__");

  const deskId = uid();
  const desk = {
    id: deskId,
    type: "desk",
    name,
    children: [],
    flagged: false,
    createdAt: Math.floor(Date.now() / 1000),
  };

  // Re-id the legacy specials so they live under this desk.
  if (inbox) { inbox.id = specialNodeId("__inbox__", deskId); desk.children.push(inbox); }
  if (images) { images.id = specialNodeId("__images__", deskId); }
  if (trash) { trash.id = specialNodeId("__trash__", deskId); }

  // Move every remaining top-level node into the desk; specials added
  // last so the ordering helper can re-pin them.
  while (t.length > 0) desk.children.push(t.shift());
  if (images) desk.children.push(images);
  if (trash) desk.children.push(trash);

  ensureDeskSpecials(desk);
  t.push(desk);

  const desksList = [{ id: deskId, name, createdAt: desk.createdAt }];
  // Seed the per-desk style choice from the user's existing global so
  // the first boot after the per-desk migration keeps painting with
  // whatever they had selected before.
  const seededMeta = { ...(state.settings?.desksMeta || {}) };
  if (!seededMeta[deskId]) {
    seededMeta[deskId] = {
      globalStyleId: state.settings?.globalStyleId || null,
    };
  }
  await state.updateSettings({
    useDesks: true,
    desks: desksList,
    activeDeskId: deskId,
    desksMeta: seededMeta,
  });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Add a new empty desk to the tree. Returns the new desk id. */
export async function createDesk(state, name = "Untitled desk") {
  const id = uid();
  const desk = {
    id,
    type: "desk",
    name,
    children: [],
    flagged: false,
    createdAt: Math.floor(Date.now() / 1000),
  };
  ensureDeskSpecials(desk);
  state.fileTree.push(desk);
  const desks = [...(state.settings.desks || []), { id, name, createdAt: desk.createdAt }];
  // Seed the per-desk meta with an explicit `globalStyleId: null` so a
  // brand-new desk starts on the Default style instead of inheriting
  // the user's top-level legacy fallback. The user's first style pick
  // for this desk overwrites the null.
  const meta = { ...(state.settings.desksMeta || {}), [id]: { globalStyleId: null } };
  await state.updateSettings({ desks, desksMeta: meta });
  await state.saveFileTree();
  state.emit("desks-changed");
  return id;
}

/** Rename a desk. **Local desks take their name from their folder**, so
 *  user-driven renames are refused for them — the folder on disk is the
 *  source of truth and Hush never renames a directory the user owns.
 *  The local-desk plumbing itself (make-local / adopt) passes
 *  `{ force: true }` to write the folder's name in. */
export async function renameDesk(state, deskId, newName, { force = false } = {}) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  if (!force && state.deskRoots?.[deskId]) {
    throw Object.assign(
      new Error("A local desk takes its name from its folder — rename the folder instead."),
      { code: "desk-rename-local" },
    );
  }
  const oldName = desk.name;
  if (!newName || newName === oldName) return;
  desk.name = newName;
  const desks = (state.settings.desks || []).map((d) => d.id === deskId ? { ...d, name: newName } : d);
  await state.updateSettings({ desks });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Delete a desk and all of its content. The very last desk can't be
 *  deleted — the file tree must always carry at least one desk. A local
 *  desk's folder is never touched: deletion just unregisters the root
 *  (explicitly, before the tree save — `save_forest` refuses to infer
 *  desk deletion from a tree that merely lacks the desk). */
export async function deleteDesk(state, deskId) {
  const tree = state.fileTree || [];
  const desks = tree.filter((n) => n.type === "desk");
  if (desks.length <= 1) throw new Error("cannot delete the last desk");
  const idx = tree.findIndex((n) => n.type === "desk" && n.id === deskId);
  if (idx < 0) return;
  const doomed = tree[idx];
  logActivity("desks", "warn", `Deleting desk "${doomed?.name || deskId}"`, {
    deskId,
    local: !!state.deskRoots?.[deskId],
    topLevelChildren: (doomed?.children || []).map((c) => c?.name),
  });
  if (state.deskRoots?.[deskId]) {
    const { unregisterDeskRoot } = await import("../sync/desk-roots.js");
    await unregisterDeskRoot(state, deskId);
  } else {
    // Say the deletion out loud. `save_forest` no longer infers it from a
    // tree that merely lacks the desk — that signal is indistinguishable
    // from a stale tree, and inferring it is how a live desk's folder
    // could be swept aside by another window's out-of-date save. The
    // folder is retired (moved under `desks/.deleted/`), never wiped.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desk_retire", { deskId });
    } catch (e) {
      logActivity("desks", "error", "desk_retire failed", { deskId, error: String(e) });
    }
  }
  tree.splice(idx, 1);

  const remaining = (state.settings.desks || []).filter((d) => d.id !== deskId);
  const meta = { ...(state.settings.desksMeta || {}) };
  delete meta[deskId];

  let activeDeskId = state.settings.activeDeskId;
  if (activeDeskId === deskId) activeDeskId = remaining[0]?.id || null;

  await state.updateSettings({ desks: remaining, desksMeta: meta, activeDeskId });
  await state.saveFileTree();
  state.emit("desks-changed");
  if (activeDeskId !== state.settings.activeDeskId) state.emit("active-desk-changed", activeDeskId);
}

/** Every special-node id of `kind` currently in the tree (one per desk).
 *  The bare legacy id is included as a fallback for the brief boot
 *  window before `migrateLegacyTreeIfNeeded` runs. */
export function allSpecialOfKind(state, kind) {
  const out = [kind];
  for (const d of (state.settings?.desks || [])) out.push(`${kind}:${d.id}`);
  return out;
}

/** The Archive folder ships collapsed by default. Fresh installs get that
 *  from the files panel's first-run defaults (no persisted collapse set
 *  yet). Installs that predate Archive already carry a persisted
 *  `collapsedFolderIds`, so when Archive is *first created* on such an
 *  install (reported via `createdIds`), fold its id into that set once —
 *  the "first created" signal is inherently one-shot, so a later
 *  user-expand is never undone. `collapsedFolderIds` is a persisted
 *  setting, so no extra flag is needed. */
export function seedNewArchivesCollapsed(state, createdIds) {
  const collapsed = state.settings?.collapsedFolderIds;
  if (!Array.isArray(collapsed) || !Array.isArray(createdIds)) return;
  const fresh = createdIds.filter((id) => id === "__archive__" || id.startsWith("__archive__:"));
  if (fresh.length === 0) return;
  const next = new Set(collapsed);
  for (const id of fresh) next.add(id);
  void state.updateSettings({ collapsedFolderIds: [...next] });
}

/** Mutates `tree` in place to drop any orphan global specials, fold
 *  loose top-level non-desk nodes into the active (or first) desk, and
 *  ensure every desk carries Inbox/Images/Trash. No-ops on a flat tree
 *  with no desks — `migrateLegacyTreeIfNeeded` runs before this on
 *  boot and produces the desk to fold into. */
export function ensureDesksTreeSpecials(state, tree) {
  const desks = tree.filter((n) => n.type === "desk");
  // Stragglers land in the **first** desk, not the active one. The active
  // desk is per-window: two windows running side by side (Stage Manager
  // on iPad, two windows on desktop) would each fold the same homeless
  // node into a different desk and then each save the whole forest,
  // leaving the node recorded in two desks at once — the state that made
  // a project show up under two desks and go unopenable when one of them
  // was deleted. The first desk is the same answer in every window.
  const target = desks[0];
  if (target) {
    // A top-level non-desk node whose name matches a known desk is an
    // unfinished desk absorption (left behind by an interrupted import
    // or the removed sync layer). Folding those into the active desk
    // would nest them under the wrong path. Leave them alone;
    // `reconcileDesksWithStrayFolders` (re-run on every boot via
    // `migrateLegacyTreeIfNeeded`) will absorb them into the correct
    // desk.
    const knownDeskNames = new Set((state.settings?.desks || []).map((d) => d?.name).filter(Boolean));
    for (const d of desks) if (d?.name) knownDeskNames.add(d.name);
    const stragglers = tree.filter((n) =>
      n.type !== "desk"
      && !isSpecialNodeId(n.id)
      && !knownDeskNames.has(n.name)
    );
    for (const s of stragglers) {
      const idx = tree.indexOf(s);
      if (idx >= 0) tree.splice(idx, 1);
      if (!Array.isArray(target.children)) target.children = [];
      target.children.push(s);
    }
    for (const id of ["__inbox__", "__images__", "__pdfs__", "__archive__", "__trash__"]) {
      const i = tree.findIndex((n) => n.id === id);
      if (i >= 0) tree.splice(i, 1);
    }
  }
  const created = [];
  for (const d of desks) created.push(...ensureDeskSpecials(d));
  return created;
}

// Boot-time repair cluster (migrateLegacyTreeIfNeeded and friends)
// lives in state-desks-boot.js; re-exported here so callers keep
// importing from this barrel.
export {
  absorbMatchingFolder,
  syncDesksRegistryWithTree,
  reconcileDesksWithStrayFolders,
  migrateLegacyTreeIfNeeded,
} from "./state-desks-boot.js";

export async function setActiveDesk(state, deskId) {
  const desks = state.settings?.desks || [];
  if (!desks.some((d) => d.id === deskId)) return;
  if (state.settings?.activeDeskId === deskId) return;
  logActivity("desks", "info",
    `Switched to desk "${desks.find((d) => d.id === deskId)?.name || deskId}"`, { deskId });
  await state.updateSettings({ activeDeskId: deskId });
  state.emit("active-desk-changed", deskId);
}

/** Per-desk "last-opened file" slot. Lives on `desksMeta[deskId]`
 *  alongside the per-desk style choice. Type routes the open path
 *  (document / notebook); projects stay local-per-device since their
 *  identity is path-based. */
export function getDeskLastFile(state, deskId) {
  const meta = state.settings?.desksMeta || {};
  const entry = deskId ? meta[deskId] : null;
  if (!entry) return null;
  const fileId = entry.lastFileId || null;
  const type = entry.lastFileType || null;
  if (!fileId || !type) return null;
  return { fileId, type };
}

/** Update the active desk's last-file slot and push the change through
 *  desks.json so other devices catch up. No-ops when there's no active
 *  desk yet (e.g. brand-new install before the migration runs). */
export async function recordActiveDeskLastFile(state, fileId, type) {
  const desk = getActiveDesk(state);
  // Update this desk's MRU first (per-device, not synced) so the Cmd+O
  // picker and the Recent Files panel can sort by recency. The list is
  // per-desk, so hopping between desks doesn't evict either one's
  // history; each is capped so settings.json can't grow unbounded.
  if (fileId && desk) await pushDeskRecentFile(state, desk.id, fileId);

  if (!desk) return;
  const meta = { ...(state.settings?.desksMeta || {}) };
  const existing = meta[desk.id] || {};
  // Opening a tree file supersedes any Local Folder last-open — clear the
  // local slot (per-desk + per-window) so restore lands on this file.
  const patch = {};
  const deskLocal = state.settings?.deskLastLocalSync || {};
  if (deskLocal[desk.id]) {
    const nextLocal = { ...deskLocal };
    delete nextLocal[desk.id];
    patch.deskLastLocalSync = nextLocal;
  }
  if (state.settings?.lastLocalSync) patch.lastLocalSync = null;
  const metaUnchanged = existing.lastFileId === fileId && existing.lastFileType === type;
  if (metaUnchanged && Object.keys(patch).length === 0) return;
  if (!metaUnchanged) {
    meta[desk.id] = { ...existing, lastFileId: fileId || null, lastFileType: fileId ? type : null };
    patch.desksMeta = meta;
  }
  await state.updateSettings(patch);
  if (!metaUnchanged) mirrorDeskMeta(state, desk.id);
}

/** Record that a Local Folder file is the active desk's most-recent open.
 *  Local-sync files live on disk, not in the desk subtree, so they keep
 *  their own local-per-device slots (`lastLocalSync` per window +
 *  `deskLastLocalSync` per desk) instead of the synced `desksMeta`. Clears
 *  the tree last-file slots so the most recent open wins on restore. */
export async function recordLocalSyncOpen(state, folderId, relPath, name) {
  if (!folderId || !relPath) return;
  const descriptor = { folderId, relPath, name: name || relPath };
  const patch = {
    lastLocalSync: descriptor,
    lastFileId: null, lastProjectId: null,
    lastNotebookId: null, lastPdfId: null, lastStackId: null,
  };
  const desk = getActiveDesk(state);
  if (desk) {
    const deskLocal = { ...(state.settings?.deskLastLocalSync || {}) };
    deskLocal[desk.id] = descriptor;
    patch.deskLastLocalSync = deskLocal;
    const meta = { ...(state.settings?.desksMeta || {}) };
    if (meta[desk.id]?.lastFileId) {
      meta[desk.id] = { ...meta[desk.id], lastFileId: null, lastFileType: null };
      patch.desksMeta = meta;
    }
  }
  await state.updateSettings(patch);
  if (patch.desksMeta && desk) mirrorDeskMeta(state, desk.id);
}

/** Read the active desk's saved global style id. Falls back to the
 *  legacy top-level `settings.globalStyleId` when no per-desk choice
 *  exists yet (first run after the per-desk migration). */
export function getDeskGlobalStyleId(state) {
  const desk = getActiveDesk(state);
  const meta = state.settings?.desksMeta || {};
  const perDesk = desk ? meta[desk.id]?.globalStyleId : undefined;
  if (perDesk !== undefined) return perDesk || null;
  return state.settings?.globalStyleId || null;
}

/** Write the active desk's global style id into desksMeta. Pushes
 *  desks.json so the choice rides cross-device. Top-level
 *  `settings.globalStyleId` is left untouched as a per-device legacy
 *  fallback. */
export async function setDeskGlobalStyleId(state, styleId) {
  const desk = getActiveDesk(state);
  if (!desk) {
    await state.updateSettings({ globalStyleId: styleId || null });
    return;
  }
  const meta = { ...(state.settings?.desksMeta || {}) };
  meta[desk.id] = { ...(meta[desk.id] || {}), globalStyleId: styleId || null };
  await state.updateSettings({ desksMeta: meta });
  mirrorDeskMeta(state, desk.id);
}

