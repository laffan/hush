/**
 * Desk graph operations driven by the command palette:
 *   - `convertFolderToDesk(state, folderId)` promotes a desk-child folder
 *     (or project) into a top-level desk. Inner Inbox/Trash/Images
 *     subfolders matched by name become per-desk specials.
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
 * `convertFolderToDesk` only supports direct desk-children for now —
 * nested-folder converts would need multi-segment path rewrites we
 * haven't generalized yet.
 */

import { specialNodeId, isSpecialNodeId, parseSpecialNodeId, ensureDeskSpecials } from "./state-desks.js";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Promote a folder/project (direct child of a desk) into its own
 *  top-level desk. The folder's children come along; inner Inbox /
 *  Trash / Images subfolders (matched by name) become per-desk
 *  specials. */
export async function convertFolderToDesk(state, folderId) {
  const tree = state.fileTree || [];

  // Locate parent desk + the folder under it. Direct-children only.
  let parentDesk = null;
  let folder = null;
  for (const top of tree) {
    if (top.type !== "desk") continue;
    const idx = (top.children || []).findIndex((c) => c?.id === folderId);
    if (idx >= 0) { parentDesk = top; folder = top.children[idx]; break; }
  }
  if (!folder) throw new Error("folder must be a direct child of a desk");
  if (folder.type !== "folder" && folder.type !== "project") throw new Error("only folders or projects can convert");
  if (isSpecialNodeId(folder.id)) throw new Error("specials cannot convert");

  // Detach from parent desk.
  parentDesk.children = (parentDesk.children || []).filter((c) => c?.id !== folderId);

  // Reshape into a desk.
  const deskId = uid();
  const deskName = folder.name || "Untitled desk";
  const createdAt = folder.createdAt || Math.floor(Date.now() / 1000);
  const desk = {
    id: deskId, type: "desk", name: deskName,
    children: [], flagged: !!folder.flagged, createdAt,
  };
  for (const c of (folder.children || [])) {
    if (!c) continue;
    if (isSpecialNodeId(c.id)) { desk.children.push(c); continue; }
    if (c.name === "Inbox" && (c.type === "folder" || c.type === "project")) {
      c.id = specialNodeId("__inbox__", deskId); c.type = "project";
      desk.children.push(c);
    } else if (c.name === "Images" && c.type === "folder") {
      c.id = specialNodeId("__images__", deskId);
      desk.children.push(c);
    } else if (c.name === "Trash" && c.type === "folder") {
      c.id = specialNodeId("__trash__", deskId);
      desk.children.push(c);
    } else {
      desk.children.push(c);
    }
  }
  ensureDeskSpecials(desk);
  tree.push(desk);

  const desks = [...(state.settings.desks || []), { id: deskId, name: deskName, createdAt }];
  await state.updateSettings({ desks });
  await state.saveFileTree();
  state.emit("desks-changed");
  state.emit("files-changed");
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
  ensureDeskSpecials(target);

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
 *  set is direct desk-children only (folders / projects, non-special),
 *  since the path-rewrite logic in `convertFolderToDesk` only handles
 *  one nesting level. */
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

  // 1. Try the saved per-desk last file. Verify it still exists in this
  //    desk's subtree — a remote rename / delete or a sync-translated
  //    payload that resolved to a file outside the desk shouldn't drag
  //    the editor away from the desk's own content. Honour every openable
  //    type (doc / notebook / PDF / stack) so the desk restores the exact
  //    surface the user last had, not just docs and notebooks.
  const last = state.getDeskLastFile?.(deskId);
  if (last?.fileId && last?.type) {
    const node = findNodeInSubtree(desk.children, (n) =>
      (n.type === "document" || n.type === "notebook" || n.type === "pdf" || n.type === "stack")
      && n.fileId === last.fileId
    );
    if (node) {
      if (node.type === "notebook") await state.openNotebook(node.fileId);
      else if (node.type === "pdf") await state.openPdf(node.fileId);
      else if (node.type === "stack") await state.openStack(node.fileId);
      else await state.openFile(node.fileId);
      return;
    }
  }

  // 2. First child of the desk's Inbox.
  const inboxId = `__inbox__:${desk.id}`;
  const inbox = (desk.children || []).find((n) => n.id === inboxId);
  const inboxKid = (inbox?.children || []).find((n) => n.type === "document" || n.type === "notebook");
  if (inboxKid?.fileId) {
    if (inboxKid.type === "notebook") await state.openNotebook(inboxKid.fileId);
    else await state.openFile(inboxKid.fileId);
    return;
  }

  // 3. Empty desk — drop to the "no file selected" pane rather than
  //    continuing to show the previous desk's file (or spawning a
  //    throwaway Untitled doc). Mirrors the boot fallback in init().
  await state.clearActiveFile();
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
