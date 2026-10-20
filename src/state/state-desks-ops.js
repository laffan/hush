/**
 * Desk graph operations driven by the command palette:
 *   - `convertFolderToDesk(state, folderId)` makes a new internal desk
 *     from a copy of a folder (or project) and archives the original.
 *   - `collapseDeskToFolder(state, deskId)` demotes a top-level desk back
 *     to a regular folder placed inside another desk. Refuses to run
 *     while the source desk's Inbox or Trash hold any items — those
 *     specials are dropped on collapse, so silently merging their
 *     contents into the destination would be a data-loss surprise.
 *     Images survive the collapse as a plain folder so existing
 *     image refs still resolve.
 *
 * Both operations update `settings.desks` and the file tree.
 *
 * `convertFolderToDesk` takes a folder or project at any depth (the
 * sidebar's row menu offers it on every one; the palette picker lists
 * direct desk-children).
 */

import { findNode, removeNode, uniqueChildName } from "./tree-helpers.js";
import { specialNodeId, isSpecialNodeId, parseSpecialNodeId, ensureDeskSpecials, seedNewArchivesCollapsed, setDeskIcon } from "./state-desks.js";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Make a new desk out of a folder or project (anywhere inside a desk):
 *  a new **internal** desk named after it, holding a copy of everything
 *  in it, with the original moved into its desk's Archive — where it
 *  stays, untouched, until the user deletes it.
 *
 *  A copy, not a move, for two reasons. It is the only form that works
 *  whatever kind of desk the folder sits in: a folder inside a *local*
 *  desk lives in the user's own folder on disk, and the store will not
 *  pull files out of a registered root into a folderless desk (README-
 *  SYNC, rule 3) — the old in-place promotion therefore produced a desk
 *  that existed only in this window's memory, opened onto the desk it
 *  came from, and was gone after a restart. And the archived original is
 *  the way back if the result isn't what was wanted.
 *
 *  The copy is the "Copy Files from other Desks" copier's
 *  (`copy-from-desks-copy.js#runCopyPlan`): fresh fileIds, names kept,
 *  stacks repointed at the copied docs, PDFs referenced rather than
 *  duplicated. A top-level `Inbox` or `Archive` folder inside the source
 *  (what Collapse desk into folder leaves) fills the new desk's own
 *  Inbox / Archive; `Images` and `Trash` stay behind — images resolve by
 *  filename from any desk, and trash is trash. A folder's custom icon
 *  becomes the desk's. Resolves to the new desk's id. */
export async function convertFolderToDesk(state, folderId) {
  const tree = state.fileTree || [];
  let folder = null;
  let sourceDesk = null;
  for (const top of tree) {
    if (top.type !== "desk") continue;
    folder = findNode(top.children || [], folderId);
    if (folder) { sourceDesk = top; break; }
  }
  if (!folder) throw new Error("folder not found inside a desk");
  if (folder.type !== "folder" && folder.type !== "project") throw new Error("only folders or projects can convert");
  if (isSpecialNodeId(folder.id)) throw new Error("specials cannot convert");

  // Unsaved edits go to disk first, so the copy carries them.
  try { if (state.dirty) await state.saveCurrentFile(); } catch (_) {}

  const name = folder.name || "Untitled desk";
  const deskId = await state.createDesk(name);
  if (!deskId) throw new Error("couldn't create the desk");
  // The copier files PDFs under the *active* desk's PDFs folder, which
  // has to be the new one.
  await state.setActiveDesk(deskId);

  const plan = [];
  const add = (src, parentId) => {
    plan.push({ srcNodeId: src.id, parentId, index: plan.filter((p) => p.parentId === parentId).length,
      type: src.type, name: src.name });
  };
  const roleOf = { Inbox: "__inbox__", Archive: "__archive__" };
  for (const c of folder.children || []) {
    if (!c || isSpecialNodeId(c.id)) continue;
    const isContainer = c.type === "folder" || c.type === "project";
    if (isContainer && roleOf[c.name]) {
      for (const g of c.children || []) if (g) add(g, specialNodeId(roleOf[c.name], deskId));
      continue;
    }
    if (isContainer && (c.name === "Images" || c.name === "Trash")) continue;
    add(c, deskId);
  }
  const { runCopyPlan } = await import("../sidebar/copy-from-desks-copy.js");
  const { skipped } = await runCopyPlan(state, plan);

  // The original goes to its desk's Archive. Looked up again: the tree
  // has been saved (and possibly adopted from the store) since.
  const liveTree = state.fileTree || [];
  const liveDesk = liveTree.find((n) => n.type === "desk" && n.id === sourceDesk.id);
  const original = liveDesk ? findNode(liveDesk.children || [], folderId) : null;
  if (liveDesk && original) {
    seedNewArchivesCollapsed(state, ensureDeskSpecials(liveDesk));
    const archive = findNode(liveDesk.children || [], specialNodeId("__archive__", liveDesk.id));
    if (archive) {
      removeNode(liveTree, folderId);
      original.name = uniqueChildName(archive, original.name || "Untitled", original.type, original.id);
      if (!Array.isArray(archive.children)) archive.children = [];
      archive.children.unshift(original);
      await state.saveFileTree();
    }
  }
  if (folder.icon) await setDeskIcon(state, deskId, folder.icon);
  state.emit("desks-changed");
  state.emit("files-changed");
  try {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(`“${name}” is now a desk${skipped ? ` (${skipped} item${skipped === 1 ? "" : "s"} couldn't be copied)` : ""}`
      + ` — the original is in ${sourceDesk.name || "its desk"}'s Archive`, "info");
  } catch (_) {}
  return deskId;
}

/** Returns the per-desk specials that still hold items, keyed by the
 *  bare kind ("__inbox__" / "__trash__"). Used to gate the collapse
 *  operation — Inbox + Trash must be empty so dropping them on the way
 *  through doesn't quietly destroy data. */
function nonEmptyBlockingSpecials(desk) {
  const blocking = [];
  for (const c of (desk?.children || [])) {
    const parsed = parseSpecialNodeId(c?.id);
    if (!parsed) continue;
    if (parsed.kind !== "__inbox__" && parsed.kind !== "__trash__") continue;
    if ((c.children || []).length > 0) blocking.push(parsed.kind);
  }
  return blocking;
}

/** Demote a desk back into a regular folder placed inside another
 *  desk. Refuses while the source desk's Inbox or Trash carry any
 *  items — collapse trims those specials, so the caller has to clear
 *  them first. Images and other content survive as plain folders/
 *  projects with fresh ids. */
export async function collapseDeskToFolder(state, deskId) {
  const tree = state.fileTree || [];
  const deskIdx = tree.findIndex((n) => n.type === "desk" && n.id === deskId);
  if (deskIdx < 0) throw new Error("desk not found");
  const desk = tree[deskIdx];

  // A local desk operates from the user's own folder — collapsing it
  // would move that folder's contents into another desk's storage, and
  // the registered root would keep resurrecting the desk from disk.
  // Bring it internal first, then collapse.
  if (state.deskRoots?.[deskId]) {
    const err = new Error(
      "This desk lives in a local folder. Run “Make Desk Internal” first, then collapse it.",
    );
    err.code = "desk-collapse-blocked";
    throw err;
  }

  const blocking = nonEmptyBlockingSpecials(desk);
  if (blocking.length > 0) {
    const labels = blocking.map((k) => (k === "__inbox__" ? "Inbox" : "Trash"));
    const err = new Error(`Empty ${labels.join(" and ")} before collapsing this desk.`);
    err.code = "desk-collapse-blocked";
    err.blockingSpecials = labels;
    throw err;
  }

  // Pick a destination: active desk if it's not the one being collapsed,
  // otherwise the first remaining desk. Bail when there's no other desk.
  const otherDesks = tree.filter((n) => n.type === "desk" && n.id !== deskId);
  if (otherDesks.length === 0) throw new Error("cannot collapse the only desk");
  let target = otherDesks.find((d) => d.id === state.settings?.activeDeskId) || otherDesks[0];

  tree.splice(deskIdx, 1);

  // Demote the desk node into a folder. Per-desk Inbox + Trash are
  // dropped (already verified empty above). Images survives as a plain
  // folder when non-empty so its image refs still resolve via the
  // global Images-folder lookup.
  const folder = {
    id: uid(), type: "folder", name: desk.name || "Untitled desk",
    children: [], flagged: !!desk.flagged, createdAt: desk.createdAt,
    ...(state.settings?.desksMeta?.[deskId]?.icon ? { icon: state.settings.desksMeta[deskId].icon } : {}),
  };
  for (const c of (desk.children || [])) {
    if (!c) continue;
    const parsed = parseSpecialNodeId(c.id);
    if (parsed) {
      if (parsed.kind === "__inbox__" || parsed.kind === "__trash__") continue;
      if (!(c.children || []).length) continue;
      c.id = uid();
      folder.children.push(c);
    } else {
      folder.children.push(c);
    }
  }
  if (!Array.isArray(target.children)) target.children = [];
  target.children.push(folder);
  seedNewArchivesCollapsed(state, ensureDeskSpecials(target));

  // Update settings: drop the collapsed desk, retarget activeDeskId if it
  // matched, and clear any per-desk meta the desk owned.
  const desks = (state.settings.desks || []).filter((d) => d.id !== deskId);
  const meta = { ...(state.settings.desksMeta || {}) };
  delete meta[deskId];
  let activeDeskId = state.settings?.activeDeskId;
  if (activeDeskId === deskId) activeDeskId = target.id;

  await state.updateSettings({ desks, desksMeta: meta, activeDeskId });
  await state.saveFileTree();
  state.emit("desks-changed");
  state.emit("files-changed");
  if (activeDeskId !== deskId) state.emit("active-desk-changed", activeDeskId);
}

// ===== Command-palette pickers =====

/** Swap the palette into "pick a folder to convert" mode. The candidate
 *  set is direct desk-children (folders / projects, non-special); the
 *  sidebar's row menu reaches nested ones. */
export function enterConvertFolderPicker(palette, state, { typeIcons, fallbackIcon } = {}) {
  const candidates = [];
  for (const top of state.fileTree || []) {
    if (top.type !== "desk") continue;
    for (const c of (top.children || [])) {
      if (!c) continue;
      if (c.type !== "folder" && c.type !== "project") continue;
      if (isSpecialNodeId(c.id)) continue;
      candidates.push({ id: c.id, name: c.name || "Untitled", deskName: top.name || "" });
    }
  }
  const items = candidates.map((c) => ({
    id: "convert-" + c.id,
    label: `${c.name}  (${c.deskName})`,
    icon: typeIcons?.folder || fallbackIcon || null,
    shortcutKey: null,
    action: () => convertFolderToDesk(state, c.id).catch((e) => console.error("convert failed:", e)),
  }));
  palette.setItems(items, "Convert folder to desk…");
}

/** Swap the palette into "pick a desk to collapse" mode. Picking a desk
 *  asks for confirmation first (collapse drops the desk's Inbox/Trash
 *  specials, so it's not a silent no-op). The collapse gate (Inbox +
 *  Trash must be empty) is enforced inside `collapseDeskToFolder`; if it
 *  trips, surface the message via `window.alert` so the user knows what
 *  to clear before retrying. */
export function enterCollapseDeskPicker(palette, state, { fallbackIcon } = {}) {
  const desks = state.settings?.desks || [];
  const items = desks.map((d) => ({
    id: "collapse-" + d.id,
    label: d.name || "Untitled desk",
    icon: fallbackIcon || null,
    shortcutKey: null,
    action: () => {
      const name = d.name || "this desk";
      import("../sidebar/files-panel-shared.js").then(({ showConfirmModal }) => {
        showConfirmModal({
          title: `Collapse "${name}"`,
          message: `Collapse "${name}" into a folder?\n\nIt stops being a desk and becomes a regular folder; its Inbox and Trash are dropped.`,
          confirmLabel: "Collapse",
          onConfirm: () => collapseDeskToFolder(state, d.id).catch((e) => {
            if (e?.code === "desk-collapse-blocked") {
              window.alert(e.message || "Empty Inbox and Trash before collapsing this desk.");
            } else {
              console.error("collapse failed:", e);
            }
          }),
        });
      });
    },
  }));
  palette.setItems(items, "Collapse desk into folder…");
}

/** Reorder the desks to match `orderedIds` (an array of desk ids in the
 *  desired top-to-bottom order). Reorders both the file-tree desk nodes
 *  and the `settings.desks` registry so the two stay in lockstep, then
 *  persists and republishes. Ids missing from `orderedIds` keep their
 *  relative order at the tail; unknown ids are ignored. No-op when the
 *  order is already correct. */
export async function reorderDesks(state, orderedIds) {
  const tree = state.fileTree || [];
  const deskNodes = tree.filter((n) => n.type === "desk");
  if (deskNodes.length < 2) return;
  const byId = new Map(deskNodes.map((n) => [n.id, n]));
  const ordered = [];
  for (const id of orderedIds || []) {
    const n = byId.get(id);
    if (n && !ordered.includes(n)) ordered.push(n);
  }
  for (const n of deskNodes) if (!ordered.includes(n)) ordered.push(n);
  if (ordered.length !== deskNodes.length) return;
  // Bail if nothing actually moved.
  if (deskNodes.every((n, i) => n === ordered[i])) return;

  // Substitute the reordered desk nodes back into their top-level slots,
  // leaving any (rare) non-desk top-level node where it sits.
  let i = 0;
  state.fileTree = tree.map((n) => (n.type === "desk" ? ordered[i++] : n));

  // Mirror the order into the registry.
  const reg = state.settings?.desks || [];
  const regById = new Map(reg.map((d) => [d.id, d]));
  const newReg = ordered.map((n) => regById.get(n.id)).filter(Boolean);
  for (const d of reg) if (!newReg.includes(d)) newReg.push(d);

  await state.updateSettings({ desks: newReg });
  await state.saveFileTree();
  state.emit("desks-changed");
}

/** Drive the editor view to the desk's last-opened file when the user
 *  switches desks. Resolution priority: the per-desk last-file slot
 *  (synced via desks.json), then the first doc/notebook in that desk's
 *  Inbox, then a fresh empty doc in the Inbox. Without this, the active
 *  editor would keep showing the previous desk's file after a switch. */
export async function openLastFileForDesk(state, deskId) {
  const tree = state.fileTree || [];
  const desk = tree.find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;

  // Leaving a desk ends any forward-only writing session. The open*
  // helpers all no-op while ratchet mode is active, which would otherwise
  // strand the editor on the *previous* desk's file after the switch.
  if (state.ratchetMode && state.stopRatchet) state.stopRatchet();

  // 0. A Local Folder file was the most recent thing open in this desk.
  //    Local-sync files live on disk (not in the desk subtree), so they
  //    need their own restore path. The per-desk tree slot and this local
  //    slot are kept mutually exclusive (each open path clears the other),
  //    so whichever is set here is genuinely the most recent.
  const lastLocal = state.settings?.deskLastLocalSync?.[deskId];
  if (lastLocal?.folderId && lastLocal?.relPath) {
    const folders = state.settings?.localSyncFolders || [];
    if (folders.some((f) => f.id === lastLocal.folderId)) {
      try {
        const m = await import("../sync/local-sync.js");
        await m.openLocalEntry(state, lastLocal.folderId, lastLocal.relPath, lastLocal.name);
        return;
      } catch (e) { console.warn("desk restore: local file open failed:", e); }
    }
  }

  // 1–2. The desk's own last file, else the first thing in its Inbox.
  const landing = deskLandingFile(state, deskId);
  if (landing) {
    if (landing.type === "notebook") await state.openNotebook(landing.fileId);
    else if (landing.type === "pdf") await state.openPdf(landing.fileId);
    else if (landing.type === "stack") await state.openStack(landing.fileId);
    else await state.openFile(landing.fileId);
    return;
  }

  // 3. Empty desk — drop to the "no file selected" pane rather than
  //    continuing to show the previous desk's file (or spawning a
  //    throwaway Untitled doc). Mirrors the boot fallback in init().
  await state.clearActiveFile();
}

/** The tree file a desk lands on when it is switched to — or opened in
 *  a window of its own (multi-window.js#openDeskInNewWindow) — as
 *  `{ fileId, type }`, or null for an empty desk:
 *  1. the saved per-desk last file, verified still inside this desk's
 *     subtree — a remote rename / delete or a sync-translated payload
 *     that resolved to a file outside the desk shouldn't drag the editor
 *     away from the desk's own content. Every openable type (doc /
 *     notebook / PDF / stack), so the desk restores the exact surface
 *     the user last had;
 *  2. else the first doc or notebook in the desk's Inbox.
 *  A Local Folder last-open is `openLastFileForDesk`'s own step 0. */
export function deskLandingFile(state, deskId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return null;
  const last = state.getDeskLastFile?.(deskId);
  if (last?.fileId && last?.type) {
    const node = findNodeInSubtree(desk.children, (n) =>
      (n.type === "document" || n.type === "notebook" || n.type === "pdf" || n.type === "stack")
      && n.fileId === last.fileId
    );
    if (node) return { fileId: node.fileId, type: node.type };
  }
  const inboxId = `__inbox__:${desk.id}`;
  const inbox = (desk.children || []).find((n) => n.id === inboxId);
  const inboxKid = (inbox?.children || []).find((n) => n.type === "document" || n.type === "notebook");
  if (inboxKid?.fileId) return { fileId: inboxKid.fileId, type: inboxKid.type };
  return null;
}

/** Walk a tree subtree (depth-first) for the first node matching `test`. */
function findNodeInSubtree(nodes, test) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (test(n)) return n;
    const child = findNodeInSubtree(n.children, test);
    if (child) return child;
  }
  return null;
}
