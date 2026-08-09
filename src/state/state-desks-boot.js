/**
 * Boot-time desk repair — the migrate / reconcile cluster that runs
 * before anything else touches the tree. Extracted from state-desks.js
 * to keep each module under 700 lines; state-desks.js re-exports these
 * so callers keep importing from the one desks barrel.
 */

import {
  specialNodeId,
  isSpecialNodeId,
  parseSpecialNodeId,
  ensureDeskSpecials,
  enableDesks,
} from "./state-desks.js";
import { logActivity } from "../activity-log.js";

/** True when `node` looks like an unwrapped desk skeleton — the husk an
 *  interrupted desk absorption leaves behind, which we want folded back
 *  into the real desk of the same name.
 *
 *  The bar is deliberately high, and this is the second time it has
 *  moved. It was once "a folder with an `Inbox` child"; that missed
 *  desks whose layout put a project at the root, so it was relaxed to
 *  "any non-special folder or project". That relaxation was the bug: the
 *  only other test is a *name* match against a desk, so any ordinary
 *  folder or project a user happened to name after one of their desks
 *  qualified — and got torn out of the desk it lived in, its children
 *  scattered into the other desk's root. A project called "Personal"
 *  filed under a "School" desk is a perfectly normal thing to have.
 *
 *  So: carrying one of the desk-layout folders (Inbox / Images /
 *  Archive / Trash) still counts as a skeleton wherever it sits, and a
 *  bare folder/project only counts at the **top level**, where it has no
 *  desk to belong to in the first place. Content nested inside a real
 *  desk is that desk's, full stop. */
function looksLikeUnwrappedDeskSkeleton(node, { topLevel }) {
  if (!node) return false;
  if (node.type !== "folder" && node.type !== "project") return false;
  if (isSpecialNodeId(node.id)) return false;
  if (topLevel) return true;
  const SPECIAL_NAMES = new Set(["Inbox", "Images", "Archive", "Trash"]);
  return (node.children || []).some(
    (c) => c && SPECIAL_NAMES.has(c.name) && (c.type === "folder" || c.type === "project"),
  );
}

/** Look for a folder/project whose name matches `desk.name` and looks
 *  like a desk skeleton: at the top level of the forest, or as a direct
 *  child of a desk. The first hit gets removed from its parent and its
 *  children get merged into `desk` — Inbox/Images/Trash subfolders are
 *  re-namespaced under the desk's id (their contents merge into any
 *  existing per-desk specials). Returns true when something was absorbed.
 *
 *  Only those two depths are searched. A deep walk of every desk's
 *  subtree is what let this reach into unrelated content — see
 *  `looksLikeUnwrappedDeskSkeleton`. A genuine unwrapped desk is never
 *  buried five folders down; it sits where a desk would. */
export function absorbMatchingFolder(state, desk) {
  const tree = state.fileTree;
  function takeMatch(arr, topLevel) {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!n || n === desk) continue;
      if (n.name === desk.name && looksLikeUnwrappedDeskSkeleton(n, { topLevel })) {
        return arr.splice(i, 1)[0];
      }
    }
    return null;
  }
  let folder = takeMatch(tree, true);
  if (!folder) {
    for (const top of tree) {
      if (top.type !== "desk" || !Array.isArray(top.children)) continue;
      folder = takeMatch(top.children, false);
      if (folder) break;
    }
  }
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
    // A special carrying another desk's id: its *contents* still merge
    // into this desk's matching special. Skipping the node outright (the
    // old behaviour) dropped it and everything under it on the floor —
    // the folder had already been spliced out of the tree, so those
    // children simply stopped existing.
    const foreign = parseSpecialNodeId(c.id);
    if (foreign) { mergeKnownSpecial(c, foreign.kind); continue; }
    if (c.name === "Inbox" && (c.type === "folder" || c.type === "project")) mergeKnownSpecial(c, "__inbox__");
    else if (c.name === "Images" && c.type === "folder") mergeKnownSpecial(c, "__images__");
    else if (c.name === "Archive" && c.type === "folder") mergeKnownSpecial(c, "__archive__");
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
  // Prune *and* de-duplicate. A registry row is a desk id, so two rows
  // carrying one id are one desk shown twice — the switcher listing
  // "Letters, Letters, Letters" after a forest picked the same folder up
  // under several registrations. The forest can't do that any more (see
  // desk_identity.rs), but the rows it already wrote are still in
  // settings and nothing else would ever clear them.
  const known = new Set();
  const pruned = list.filter((d) => treeIds.has(d.id) && !known.has(d.id) && known.add(d.id));
  const missing = treeDesks.filter((n) => !known.has(n.id) && known.add(n.id));
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
  // `desksMeta` is *kept* for ids the tree doesn't currently show. It
  // holds the desk's style choice, last-open file and stickies, and a
  // tree can be short for reasons that have nothing to do with deletion:
  // a local desk whose folder hasn't been re-granted access yet, an
  // iCloud sidecar that isn't downloaded, a boot that raced the roots
  // resolver. Deleting the meta on that signal threw away real settings
  // the desk needed back a second later; a few stale keys cost nothing.
  // `deleteDesk` still clears the entry it owns.
  const meta = { ...(state.settings?.desksMeta || {}) };
  for (const n of missing) if (!meta[n.id]) meta[n.id] = { globalStyleId: null };
  const activeDeskId = activeOk ? activeId : (treeDesks[0]?.id || null);
  if (pruned.length !== list.length) {
    const kept = new Set(pruned); // same row objects, so identity is the test
    logActivity("desks", "warn", "Desk registry pruned", {
      dropped: list.filter((d) => !kept.has(d)).map((d) => `${d.name} (${d.id})`),
      treeDesks: treeDesks.map((d) => d.name),
    });
  }
  await state.updateSettings({ desks, desksMeta: meta, activeDeskId }, { fromSync: true });
  if (missing.length) state.emit("desks-changed");
  return true;
}

/** Walk every desk in the tree and absorb any same-named folder
 *  skeleton sitting beside it (top level) or directly inside another
 *  desk. Used at boot to recover trees that were broken before this fix
 *  landed. Returns the number of absorptions performed. */
export function reconcileDesksWithStrayFolders(state) {
  const desks = (state.fileTree || []).filter((n) => n.type === "desk");
  let absorbed = 0;
  for (const d of desks) {
    // Bounded: each absorb removes a node, so this always terminates —
    // but a boot pass is not the place to find out otherwise.
    let guard = 0;
    while (absorbMatchingFolder(state, d) && guard++ < 50) {
      absorbed++;
      logActivity("desks", "warn", `Absorbed a stray "${d.name}" skeleton into its desk`, {
        deskId: d.id,
      });
    }
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
/** True when the *store* already holds desks even though the tree we were
 *  handed shows none. That gap is not a legacy install waiting to be
 *  migrated — it's a read that came back short, and on iPad it has a
 *  routine cause: a local desk's folder is reached through a
 *  security-scoped bookmark that boot hasn't resolved yet, or its
 *  `.hush/tree.json` is an iCloud placeholder that hasn't downloaded.
 *  `load_forest` skips a desk it can't read, so the forest arrives empty
 *  and the migration below would happily mint a *brand-new* "Personal"
 *  desk beside the real ones — which then compete for the same name at
 *  every later repair pass. Ask the store directly before assuming. */
async function storeAlreadyHasDesks(state) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const diag = await invoke("desk_store_diagnostics");
    return Array.isArray(diag?.desks) && diag.desks.length > 0;
  } catch (_) {
    // Can't tell. The registry is the next best witness: a desk we have
    // settings for is a desk that existed.
    return (state.settings?.desks || []).length > 0;
  }
}

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

  // Before treating a desk-less tree as a legacy install, make sure the
  // store agrees there are no desks. If it doesn't, this read came back
  // short and creating anything now would fabricate a desk beside the
  // user's real ones — leave the tree alone and let the desk-roots
  // lifecycle reload it once the folders are reachable.
  if (await storeAlreadyHasDesks(state)) {
    logActivity("desks", "error", "Tree loaded with no desks but the store has some — skipping migration", {
      registryDesks: (state.settings?.desks || []).map((d) => d.name),
    });
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
