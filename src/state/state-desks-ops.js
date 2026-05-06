/**
 * Desk graph operations driven by the command palette:
 *   - `convertFolderToDesk(state, folderId)` promotes a desk-child folder
 *     (or project) into a top-level desk. Inner Inbox/Trash/Images
 *     subfolders matched by name become per-desk specials.
 *   - `collapseDeskToFolder(state, deskId)` demotes a top-level desk back
 *     to a regular folder placed inside another desk. Per-desk specials
 *     become plain folders/projects (fresh ids).
 *
 * Both operations:
 *   - update `settings.desks` and the file tree,
 *   - push `.hush/desks.json` so other devices learn the new shape,
 *   - enqueue Dropbox path renames so the remote layout follows.
 *
 * `convertFolderToDesk` only supports direct desk-children for now —
 * nested-folder converts would need multi-segment path rewrites we
 * haven't generalized yet.
 */

import { specialNodeId, isSpecialNodeId, parseSpecialNodeId, ensureDeskSpecials } from "./state-desks.js";

const SYNC_FOLDER_ID = "__dropbox_sync__";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Promote a folder/project (direct child of a desk) into its own
 *  top-level desk. The folder's children come along; inner Inbox /
 *  Trash / Images subfolders (matched by name) become per-desk
 *  specials. */
export async function convertFolderToDesk(state, folderId) {
  if (!state?.settings?.useDesks) throw new Error("desks not enabled");
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

  // Dropbox: paths like "<parentDeskName>/<folderName>/..." become
  // "<folderName>/...". Skip when Dropbox isn't connected.
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    const oldPrefix = `${parentDesk.name}/${deskName}/`;
    const newPrefix = `${deskName}/`;
    await rewriteSyncPaths(state, (p) => p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : null);
  }

  pushDesksJson(state);
}

/** Demote a desk back into a regular folder placed inside another
 *  desk. Per-desk specials become plain folders/projects with fresh
 *  ids; the destination desk's own specials are left untouched. */
export async function collapseDeskToFolder(state, deskId) {
  if (!state?.settings?.useDesks) throw new Error("desks not enabled");
  const tree = state.fileTree || [];
  const deskIdx = tree.findIndex((n) => n.type === "desk" && n.id === deskId);
  if (deskIdx < 0) throw new Error("desk not found");
  const desk = tree[deskIdx];

  // Pick a destination: active desk if it's not the one being collapsed,
  // otherwise the first remaining desk. Bail when there's no other desk.
  const otherDesks = tree.filter((n) => n.type === "desk" && n.id !== deskId);
  if (otherDesks.length === 0) throw new Error("cannot collapse the only desk");
  let target = otherDesks.find((d) => d.id === state.settings?.activeDeskId) || otherDesks[0];

  tree.splice(deskIdx, 1);

  // Demote the desk node into a folder. Inner per-desk specials become
  // regular folders/projects with fresh non-special ids so subsequent
  // checks via `isSpecialNodeId` see them as ordinary nodes.
  const folder = {
    id: uid(), type: "folder", name: desk.name || "Untitled desk",
    children: [], flagged: !!desk.flagged, createdAt: desk.createdAt,
  };
  for (const c of (desk.children || [])) {
    if (!c) continue;
    const parsed = parseSpecialNodeId(c.id);
    if (parsed) {
      // Empty per-desk specials get dropped — they'd just clutter the
      // resulting folder. Non-empty ones survive as plain folders/projects.
      if (!(c.children || []).length) continue;
      c.id = uid();
      // Inbox stays a project so its joined-buffer behaviour is preserved
      // if the user later promotes it again or moves it around.
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

  // Dropbox: paths under "<deskName>/..." gain a "<targetDeskName>/" prefix.
  if (state.settings?.dropboxEnabled && state.settings?.dropboxSyncPath) {
    const oldPrefix = `${desk.name}/`;
    const newPrefix = `${target.name}/${desk.name}/`;
    await rewriteSyncPaths(state, (p) => p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : null);
  }

  pushDesksJson(state);
}

/** Generic Dropbox path rewriter. `transform(oldPath)` returns the new
 *  path or null/undefined to skip. Each non-skip becomes one
 *  `enqueueRename` op so the existing op-log handles retries / drain. */
async function rewriteSyncPaths(state, transform) {
  try {
    const files = await tauriInvoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID }) || [];
    if (files.length === 0) return 0;
    const { enqueueRename, triggerDrain } = await import("../sync/op-log.js");
    let moved = 0;
    for (const f of files) {
      const oldPath = f.relativePath || "";
      if (!oldPath) continue;
      const newPath = transform(oldPath);
      if (!newPath || newPath === oldPath) continue;
      try {
        await enqueueRename({ internalId: f.internalId, fromPath: oldPath, toPath: newPath });
        await tauriInvoke("rename_sync_file", {
          folderPath: state.settings.dropboxSyncPath || "",
          oldRelative: oldPath, newRelative: newPath, internalId: f.internalId,
        });
        moved++;
      } catch (e) { console.warn("desk op: rename enqueue failed:", oldPath, e); }
    }
    if (moved > 0 && typeof triggerDrain === "function") triggerDrain(state);
    return moved;
  } catch (e) {
    console.warn("desk op: get_synced_files failed:", e);
    return 0;
  }
}

function pushDesksJson(state) {
  import("../sync/desks-sync.js")
    .then((m) => m.pushDesksToDropbox(state))
    .catch((e) => console.warn("desk op: meta push failed:", e));
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

/** Swap the palette into "pick a desk to collapse" mode. */
export function enterCollapseDeskPicker(palette, state, { fallbackIcon } = {}) {
  const desks = state.settings?.desks || [];
  const items = desks.map((d) => ({
    id: "collapse-" + d.id,
    label: d.name || "Untitled desk",
    icon: fallbackIcon || null,
    shortcutKey: null,
    action: () => collapseDeskToFolder(state, d.id).catch((e) => console.error("collapse failed:", e)),
  }));
  palette.setItems(items, "Collapse desk into folder…");
}
