/**
 * Boot-time desk repair — the migrate / reconcile cluster that runs
 * before anything else touches the tree. Extracted from state-desks.js
 * to keep each module under 700 lines; state-desks.js re-exports these
 * so callers keep importing from the one desks barrel.
 */

import {
  specialNodeId,
  isSpecialNodeId,
  ensureDeskSpecials,
  enableDesks,
} from "./state-desks.js";

/** True when `node` looks like an unwrapped desk skeleton — a regular
 *  folder/project (i.e. not a special) that we should absorb into a
 *  freshly-created (or already-empty) desk of the same name. The
 *  caller already gates on `n.name === desk.name`, so any non-special
 *  folder/project that survives that name match is treated as the
 *  desk's stand-in: an earlier shape required an `Inbox` child, but
 *  desks whose layout puts a project at the root (no Inbox) landed as
 *  a plain folder with the project inside, and that variant is just as
 *  much an unwrapped desk as the Inbox-rooted one. */
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

/** Two-way reconcile between the tree's desk nodes (source of truth
 *  for existence) and the `settings.desks` registry (what the desk
 *  switcher and active-desk lookup read). Idempotent — a clean install
 *  is a no-op. Used at boot to recover both drift directions:
 *
 *  - **Prune** registry entries whose id doesn't match a real tree desk
 *    (leaked orphans from interrupted deletes or the removed sync
 *    layer).
 *  - **Backfill** registry entries for tree desks the registry doesn't
 *    know about. In the desk-folder world this is a first-class seam,
 *    not just drift recovery: `load_forest` adopts any desk folder it
 *    finds on disk (a handoff copied into `desks/`, a desk synced in
 *    by a file provider), which lands a desk node in the tree with no
 *    matching registry write. Without the backfill the registry stays
 *    short forever: the all-desks view still shows every desk (it
 *    reads the tree) but the desk switcher — gated on
 *    `settings.desks.length >= 2` — never appears in single-desk mode.
 *
 *  Also re-points a dangling `activeDeskId` at the first desk so the
 *  switcher header and per-desk lookups don't resolve to nothing.
 *  Backfilled desks get a `desksMeta` stub; the portable meta pull
 *  (sync/desk-meta.js, disk wins) fills in their real style / last
 *  file / stickies from `.hushdesk` right after boot. */
export async function syncDesksRegistryWithTree(state) {
  const tree = state.fileTree || [];
  const treeDesks = tree.filter((n) => n?.type === "desk");
  const treeIds = new Set(treeDesks.map((n) => n.id));
  const list = state.settings?.desks || [];
  const pruned = list.filter((d) => treeIds.has(d.id));
  const known = new Set(pruned.map((d) => d.id));
  const missing = treeDesks.filter((n) => !known.has(n.id));
  const activeId = state.settings?.activeDeskId;
  const activeOk = !!activeId && treeIds.has(activeId);
  if (pruned.length === list.length && !missing.length && (activeOk || !treeDesks.length)) return false;

  const desks = [
    ...pruned,
    ...missing.map((n) => ({
      id: n.id,
      name: n.name,
      createdAt: n.createdAt || Math.floor(Date.now() / 1000),
    })),
  ];
  const meta = { ...(state.settings?.desksMeta || {}) };
  for (const key of Object.keys(meta)) if (!treeIds.has(key)) delete meta[key];
  for (const n of missing) if (!meta[n.id]) meta[n.id] = { globalStyleId: null };
  const activeDeskId = activeOk ? activeId : (treeDesks[0]?.id || null);
  await state.updateSettings({ desks, desksMeta: meta, activeDeskId }, { fromSync: true });
  if (missing.length) state.emit("desks-changed");
  return true;
}

/** Walk every desk in the tree and absorb any same-named folder
 *  skeleton sitting beside or inside another desk. Used at boot to
 *  recover trees that were broken before this fix landed. Returns the
 *  number of absorptions performed. */
export function reconcileDesksWithStrayFolders(state) {
  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  let absorbed = 0;
  for (const d of desks) {
    while (absorbMatchingFolder(state, d)) absorbed++;
  }
  return absorbed;
}

/** Boot migration. Pre-always-on installs persist a flat tree with
 *  bare `__inbox__` / `__images__` / `__trash__` ids at the top level.
 *  Wrap that into a default "Personal" desk so the rest of the app
 *  always sees the desks-on shape. Also runs `reconcileDesksWithStrayFolders`
 *  so a tree that was broken by the removed sync layer can self-heal
 *  on the next boot. Idempotent — bails when the tree already carries
 *  a desk node and no strays. */
export async function migrateLegacyTreeIfNeeded(state) {
  const tree = state.fileTree || [];
  if (tree.some((n) => n.type === "desk")) {
    if (!state.settings?.useDesks) {
      try { await state.updateSettings({ useDesks: true }); } catch (_) {}
    }
    if (reconcileDesksWithStrayFolders(state) > 0) {
      try { await state.saveFileTree(); } catch (_) {}
    }
    // Reconcile the settings.desks registry with the tree in both
    // directions — prune stale entries pointing at no tree desk, and
    // backfill entries for tree desks the registry lost track of
    // (adopted / handed-off desk folders land in the tree first). The
    // backfill is what keeps the desk switcher visible in single-desk
    // mode when the registry drifted short.
    try { await syncDesksRegistryWithTree(state); } catch (_) {}
    return false;
  }

  // Folders-only tree (no desks, no top-level files) — an older client
  // or the removed sync layer left top-level folders that were never
  // minted as desk nodes. Promote each folder in place instead of
  // wrapping the whole tree under a new "Personal" desk (wrapping would
  // double-nest the content).
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
