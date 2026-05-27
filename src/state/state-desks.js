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
 * named `name` (default "Personal"). Used by the boot migration and
 * by `applyDesksFile` when a peer's payload describes a desk list but
 * the local tree is still flat.
 *
 * Active-desk-id is per-device; it's stored on `settings` for
 * persistence but isn't intended to round-trip via Dropbox sync.
 */

const SPECIAL_KINDS = ["__inbox__", "__images__", "__pdfs__", "__trash__"];

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

/** Ensure each desk node has its own Inbox / Images / Trash children
 *  with the correct ordering (Inbox first, Images / Trash pinned to
 *  the tail). */
export function ensureDeskSpecials(deskNode) {
  if (!deskNode || deskNode.type !== "desk") return;
  if (!Array.isArray(deskNode.children)) deskNode.children = [];
  const c = deskNode.children;
  const ensure = (kind, type, name) => {
    const id = specialNodeId(kind, deskNode.id);
    if (!c.some((n) => n.id === id)) {
      const node = { id, type, name, children: [], flagged: false };
      if (kind === "__inbox__") c.unshift(node); else c.push(node);
    }
  };
  ensure("__inbox__", "project", "Inbox");
  ensure("__images__", "folder", "Images");
  ensure("__trash__", "folder", "Trash");
  // Order: Inbox first, Images then Trash pinned to the tail.
  const moveTo = (id, idx) => {
    const i = c.findIndex((n) => n.id === id);
    if (i >= 0 && i !== idx) { const [n] = c.splice(i, 1); c.splice(idx, 0, n); }
  };
  moveTo(specialNodeId("__inbox__", deskNode.id), 0);
  moveTo(specialNodeId("__trash__", deskNode.id), c.length - 1);
  moveTo(specialNodeId("__images__", deskNode.id), c.length - 2);
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

  const desks = [{ id: deskId, name, createdAt: desk.createdAt }];
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
    desks,
    activeDeskId: deskId,
    desksMeta: seededMeta,
  });
  await state.saveFileTree();
  state.emit("desks-changed");

  // Migrate the Dropbox layout to match the new local tree shape.
  // Paths get a `<deskName>/` prefix; the op-log handles the actual
  // moves on the network side.
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    try {
      const m = await import("../sync/desks-migration.js");
      const r = await m.migrateSyncToDesk(state, name);
      if (r?.moved) console.info(`desks: enqueued ${r.moved} Dropbox moves under "${name}/"`);
    } catch (e) { console.warn("desks: sync migration (on) failed:", e); }
    pushDesksJson(state);
  }
}

/** Push every desk's `<DeskName>/.hushdesk` upstream so other devices
 *  learn about the current desk list. Best-effort; logs but never
 *  throws. The pre-`.hushdesk` schema used a single `.hush/desks.json`;
 *  see `desk-sync.js` for the new layout. */
function pushDesksJson(state) {
  import("../sync/desk-sync.js")
    .then((m) => m.pushAllDesks(state))
    .catch((e) => console.warn("desks: meta push failed:", e));
}

/** Push a single desk's `.hushdesk` — used by createDesk/renameDesk so
 *  we don't republish the entire desk list for a single-desk change. */
function pushSingleDesk(state, desk) {
  import("../sync/desk-sync.js")
    .then((m) => m.pushDesk(state, desk))
    .catch((e) => console.warn("desks: single push failed:", e));
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
  // Push the desk skeleton to Dropbox: the folder itself, Inbox /
  // Trash subfolders, and the desk's .hushdesk identity file. The
  // single .hush/desks.json registry is gone — each desk owns its
  // metadata file alongside its content.
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    try {
      const { enqueueCreateFolder, triggerDrain } = await import("../sync/op-log.js");
      await enqueueCreateFolder({ path: name });
      for (const child of (desk.children || [])) {
        const childName = child?.name;
        if (!childName) continue;
        await enqueueCreateFolder({ path: `${name}/${childName}` });
      }
      triggerDrain(state);
    } catch (e) { console.warn("desks: skeleton enqueue failed:", e); }
  }
  pushSingleDesk(state, desk);
  return id;
}

export async function renameDesk(state, deskId, newName) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  const oldName = desk.name;
  if (!newName || newName === oldName) return;
  desk.name = newName;
  const desks = (state.settings.desks || []).map((d) => d.id === deskId ? { ...d, name: newName } : d);
  await state.updateSettings({ desks });
  await state.saveFileTree();
  state.emit("desks-changed");
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    try {
      const { enqueueRenameDir, triggerDrain } = await import("../sync/op-log.js");
      await enqueueRenameDir({ fromPath: oldName, toPath: newName });
      // Update every synced_files row that lives under the old desk
      // prefix so future content writes land at the renamed path.
      await rewriteSyncPathsPrefix(state, `${oldName}/`, `${newName}/`);
      triggerDrain(state);
    } catch (e) { console.warn("desks: rename enqueue failed:", e); }
  }
  // Republish the desk's .hushdesk so the `name` field inside matches
  // the new folder name. The rename_dir op moves the existing file
  // along with the folder; this push updates its content.
  pushSingleDesk(state, desk);
}

/** Delete a desk and all of its content. The very last desk can't be
 *  deleted — the file tree must always carry at least one desk. */
export async function deleteDesk(state, deskId) {
  const tree = state.fileTree || [];
  const desks = tree.filter((n) => n.type === "desk");
  if (desks.length <= 1) throw new Error("cannot delete the last desk");
  const idx = tree.findIndex((n) => n.type === "desk" && n.id === deskId);
  if (idx < 0) return;
  const desk = tree[idx];
  const deskName = desk.name;
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
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath && deskName) {
    try {
      const { enqueueDeleteDir, triggerDrain } = await import("../sync/op-log.js");
      await enqueueDeleteDir({ path: deskName });
      triggerDrain(state);
    } catch (e) { console.warn("desks: delete enqueue failed:", e); }
  }
  // No metadata push needed on delete: enqueueDeleteDir removes the
  // folder including the `.hushdesk` inside, and other devices learn
  // about the deletion via the cursor delta.
}

/** Rewrite every `synced_files.relative_path` whose value starts with
 *  `oldPrefix` so it carries `newPrefix` instead. Used by `renameDesk`
 *  to keep the local sync map in step with the rename op the drain
 *  worker is about to push to Dropbox. */
async function rewriteSyncPathsPrefix(state, oldPrefix, newPrefix) {
  const { invoke } = await import("@tauri-apps/api/core");
  let files = [];
  try { files = await invoke("get_synced_files", { syncFolderId: "__dropbox_sync__" }) || []; }
  catch (e) { console.warn("desks rename: get_synced_files failed:", e); return; }
  for (const f of files) {
    const oldPath = f.relativePath || "";
    if (!oldPath.startsWith(oldPrefix)) continue;
    const newPath = newPrefix + oldPath.slice(oldPrefix.length);
    try {
      await invoke("rename_sync_file", {
        folderPath: state.settings.dropboxSyncPath || "",
        oldRelative: oldPath,
        newRelative: newPath,
        internalId: f.internalId,
      });
    } catch (e) { console.warn("desks rename: rename_sync_file failed:", oldPath, e); }
  }
}

/** Every special-node id of `kind` currently in the tree (one per desk).
 *  The bare legacy id is included as a fallback for the brief boot
 *  window before `migrateLegacyTreeIfNeeded` runs. */
export function allSpecialOfKind(state, kind) {
  const out = [kind];
  for (const d of (state.settings?.desks || [])) out.push(`${kind}:${d.id}`);
  return out;
}

/** Mutates `tree` in place to drop any orphan global specials, fold
 *  loose top-level non-desk nodes into the active (or first) desk, and
 *  ensure every desk carries Inbox/Images/Trash. No-ops on a flat tree
 *  with no desks — `migrateLegacyTreeIfNeeded` runs before this on
 *  boot and produces the desk to fold into. */
export function ensureDesksTreeSpecials(state, tree) {
  const desks = tree.filter((n) => n.type === "desk");
  const target = desks.find((d) => d.id === state.settings?.activeDeskId) || desks[0];
  if (target) {
    // A top-level non-desk node whose name matches a known desk is an
    // unfinished sync absorption (cursor delivered `<DeskName>/...` files
    // before / instead of applyDesksFile reaching the local tree). Folding
    // those into the active desk would nest them under the wrong path,
    // and the next `reconcileSync` would push physical Dropbox moves to
    // match — which is how `/Personal/School/...` appeared in the wild.
    // Leave them alone; `reconcileDesksWithStrayFolders` (re-run on every
    // boot via `migrateLegacyTreeIfNeeded`) will absorb them into the
    // correct desk.
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
    for (const id of ["__inbox__", "__images__", "__pdfs__", "__trash__"]) {
      const i = tree.findIndex((n) => n.id === id);
      if (i >= 0) tree.splice(i, 1);
    }
  }
  for (const d of desks) ensureDeskSpecials(d);
}

/** True when `node` looks like an unwrapped desk skeleton — a regular
 *  folder/project (i.e. not a special) that we should absorb into a
 *  freshly-created (or already-empty) desk of the same name. The
 *  caller already gates on `n.name === desk.name`, so any non-special
 *  folder/project that survives that name match is treated as the
 *  desk's stand-in: an earlier shape required an `Inbox` child, but
 *  desks whose Mac-side layout puts a project at the root (no Inbox)
 *  came down via initialSync's `insertIntoTree` as a plain folder
 *  with the project inside, and that variant is just as much an
 *  unwrapped desk as the Inbox-rooted one. */
function looksLikeUnwrappedDeskSkeleton(node) {
  if (!node) return false;
  if (node.type !== "folder" && node.type !== "project") return false;
  if (isSpecialNodeId(node.id)) return false;
  return true;
}

/** Walk the tree (top level + inside every desk) for a folder/project
 *  whose name matches `desk.name` and looks like a desk skeleton. The
 *  first hit gets removed from its parent and its children get merged
 *  into `desk` — Inbox/Images/Trash subfolders are re-namespaced under
 *  the desk's id (their contents merge into any existing per-desk
 *  specials). Returns true when something was absorbed. */
export function absorbMatchingFolder(state, desk) {
  const tree = state.fileTree;
  function findInArr(arr) {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!n) continue;
      if (n.name === desk.name && looksLikeUnwrappedDeskSkeleton(n)) {
        const [removed] = arr.splice(i, 1);
        return removed;
      }
      if (Array.isArray(n.children)) {
        const found = findInArr(n.children);
        if (found) return found;
      }
    }
    return null;
  }
  const folder = findInArr(tree);
  if (!folder) return false;
  const mergeKnownSpecial = (child, kind) => {
    const newId = specialNodeId(kind, desk.id);
    const existing = desk.children.find((x) => x.id === newId);
    if (existing) {
      existing.children = [...(existing.children || []), ...(child.children || [])];
    } else {
      child.id = newId;
      if (kind === "__inbox__") child.type = "project";
      desk.children.push(child);
    }
  };
  for (const c of (folder.children || [])) {
    if (!c) continue;
    if (isSpecialNodeId(c.id)) continue; // belongs to another desk
    if (c.name === "Inbox" && (c.type === "folder" || c.type === "project")) mergeKnownSpecial(c, "__inbox__");
    else if (c.name === "Images" && c.type === "folder") mergeKnownSpecial(c, "__images__");
    else if (c.name === "Trash" && c.type === "folder") mergeKnownSpecial(c, "__trash__");
    else desk.children.push(c);
  }
  ensureDeskSpecials(desk);
  return true;
}

/** Drop any `settings.desks` / `settings.desksMeta` entries whose id
 *  doesn't match a real desk in the tree. Idempotent — a clean install
 *  is a no-op. Used at boot to recover from leaked orphans (the apply
 *  path used to push new ids additively without removing the old). */
export async function pruneDesksRegistry(state) {
  const tree = state.fileTree || [];
  const treeIds = new Set(tree.filter((n) => n?.type === "desk").map((n) => n.id));
  const list = state.settings?.desks || [];
  const pruned = list.filter((d) => treeIds.has(d.id));
  if (pruned.length === list.length) return false;
  const meta = { ...(state.settings?.desksMeta || {}) };
  for (const key of Object.keys(meta)) if (!treeIds.has(key)) delete meta[key];
  await state.updateSettings({ desks: pruned, desksMeta: meta }, { fromSync: true });
  return true;
}

/** Walk every desk in the tree and absorb any same-named folder
 *  skeleton sitting beside or inside another desk. Used both at boot
 *  (to recover trees that were broken before this fix landed) and
 *  inside `applyDesksFile` after creating new desk nodes. Returns the
 *  number of absorptions performed. */
export function reconcileDesksWithStrayFolders(state) {
  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  let absorbed = 0;
  for (const d of desks) {
    while (absorbMatchingFolder(state, d)) absorbed++;
  }
  return absorbed;
}

/** Reassign a local desk's id to match an incoming desk that shares
 *  the same name. Used during sync apply when both devices created an
 *  identically-named desk independently — without this they'd accumulate
 *  duplicate desks. The local content stays in place; only the id
 *  (and the per-desk special ids) change. Returns the old → new id
 *  mapping so the caller can migrate `desksMeta` keyed by the old id. */
export function reassignDeskIdByName(state, incomingDesks) {
  const tree = state.fileTree || [];
  const renamed = new Map();
  const incomingIds = new Set(incomingDesks.map((d) => d?.id).filter(Boolean));
  for (const d of incomingDesks) {
    if (!d?.id) continue;
    if (tree.some((n) => n.type === "desk" && n.id === d.id)) continue;
    const match = tree.find((n) => n.type === "desk" && n.name === d.name && !incomingIds.has(n.id));
    if (!match) continue;
    const oldId = match.id;
    match.id = d.id;
    if (d.createdAt) match.createdAt = d.createdAt;
    for (const c of (match.children || [])) {
      const parsed = parseSpecialNodeId(c?.id);
      if (parsed) c.id = specialNodeId(parsed.kind, d.id);
    }
    renamed.set(oldId, d.id);
  }
  return renamed;
}

export async function setActiveDesk(state, deskId) {
  const desks = state.settings?.desks || [];
  if (!desks.some((d) => d.id === deskId)) return;
  if (state.settings?.activeDeskId === deskId) return;
  await state.updateSettings({ activeDeskId: deskId });
  state.emit("active-desk-changed", deskId);
}

/** Per-desk "last-opened file" slot. Lives on `desksMeta[deskId]` so
 *  it round-trips through `.hush/desks.json` like the per-desk style
 *  choice — `desks-sync.js` translates the local fileId ↔ Dropbox
 *  remote_id at serialize / apply time. Type routes the open path
 *  (document / notebook); projects stay local-per-device since their
 *  cross-device identity is path-based and out of scope here. */
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
  // Update the global MRU first (per-device, not synced) so the
  // Cmd+O picker can sort by recency even when the user hops between
  // desks. Capped so settings.json doesn't grow unbounded.
  if (fileId) {
    const prev = Array.isArray(state.settings?.recentFileIds) ? state.settings.recentFileIds : [];
    const next = [fileId, ...prev.filter((id) => id !== fileId)].slice(0, 50);
    if (next.length !== prev.length || next[0] !== prev[0]) {
      await state.updateSettings({ recentFileIds: next });
    }
  }

  const desk = getActiveDesk(state);
  if (!desk) return;
  const meta = { ...(state.settings?.desksMeta || {}) };
  const existing = meta[desk.id] || {};
  if (existing.lastFileId === fileId && existing.lastFileType === type) return;
  meta[desk.id] = { ...existing, lastFileId: fileId || null, lastFileType: fileId ? type : null };
  await state.updateSettings({ desksMeta: meta });
  pushDesksJson(state);
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
  pushDesksJson(state);
}

/** Boot migration. Pre-always-on installs persist a flat tree with
 *  bare `__inbox__` / `__images__` / `__trash__` ids at the top level.
 *  Wrap that into a default "Personal" desk so the rest of the app
 *  always sees the desks-on shape. Also runs `reconcileDesksWithStrayFolders`
 *  so a tree that was broken by an earlier sync (cursor delta arriving
 *  before desks.json) can self-heal on the next boot. Idempotent —
 *  bails when the tree already carries a desk node and no strays. */
export async function migrateLegacyTreeIfNeeded(state) {
  const tree = state.fileTree || [];
  if (tree.some((n) => n.type === "desk")) {
    if (!state.settings?.useDesks) {
      try { await state.updateSettings({ useDesks: true }); } catch (_) {}
    }
    if (reconcileDesksWithStrayFolders(state) > 0) {
      try { await state.saveFileTree(); } catch (_) {}
    }
    // Prune stale settings.desks entries that no longer point at any
    // tree desk. The Dropbox apply-desk path used to leak these on every
    // id-reassignment; this is the boot-time recovery for existing
    // installs that accumulated orphans before the fix landed.
    try { await pruneDesksRegistry(state); } catch (_) {}
    return false;
  }

  // Folders-only tree (no desks, no top-level files): the cursor seed
  // pulled content down with desk-shaped paths but the tree didn't
  // get its top-level segments minted as desk nodes (older client, or
  // a reseed that ran before the per-folder desk promotion landed).
  // Promote in place instead of wrapping — wrapping would invoke
  // `migrateSyncToDesk` which moves every Dropbox path under a
  // `Personal/` prefix and produces the `/Personal/Personal/...`
  // corruption pattern in the wild.
  const topLevelFiles = tree.filter((n) => n.type === "document" || n.type === "notebook");
  const topLevelFolders = tree.filter((n) => n.type === "folder" || n.type === "project");
  if (topLevelFolders.length > 0 && topLevelFiles.length === 0) {
    let activeId = null;
    for (const folder of topLevelFolders) {
      // Promote the folder node itself to a desk: stable id stays, but
      // type flips and the special children get re-namespaced.
      const deskId = folder.id;
      folder.type = "desk";
      folder.createdAt = folder.createdAt || Math.floor(Date.now() / 1000);
      if (Array.isArray(folder.children)) {
        for (const c of folder.children) {
          if (!c) continue;
          if (c.name === "Inbox" && (c.type === "folder" || c.type === "project")) {
            c.id = specialNodeId("__inbox__", deskId);
            c.type = "project";
          } else if (c.name === "Images" && c.type === "folder") {
            c.id = specialNodeId("__images__", deskId);
          } else if (c.name === "Trash" && c.type === "folder") {
            c.id = specialNodeId("__trash__", deskId);
          }
        }
      }
      ensureDeskSpecials(folder);
      if (!activeId) activeId = deskId;
    }
    const desksRegistry = topLevelFolders.map((d) => ({
      id: d.id, name: d.name, createdAt: d.createdAt,
    }));
    const meta = { ...(state.settings?.desksMeta || {}) };
    for (const d of topLevelFolders) {
      if (!meta[d.id]) meta[d.id] = { globalStyleId: null };
    }
    await state.updateSettings({
      useDesks: true, desks: desksRegistry,
      desksMeta: meta, activeDeskId: activeId,
    });
    await state.saveFileTree();
    state.emit?.("desks-changed");
    return true;
  }

  await enableDesks(state, "Personal");
  return true;
}


/** Push the canonical desk list to Dropbox once on boot so a device
 *  that just ran the legacy-tree migration (or that had never published
 *  desks.json before) finally surfaces its state to peers. Idempotent
 *  at the op-log layer (per-payload hash dedup). */
export async function wireDesksTauri(state) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    pushDesksJson(state);
  }
}
