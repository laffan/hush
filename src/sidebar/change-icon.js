/**
 * The two ways into the Change icon picker (ui/icon-picker-modal.js),
 * and where each one keeps the choice:
 *
 * - **Folders and projects** — `node.icon`, a tree-node field like
 *   `bgColor`, saved with the tree (`TreeNode.icon` in wire.rs).
 * - **Desks** — `desksMeta[deskId].icon`, written through to the desk's
 *   `.hushdesk` (sync/desk-meta.js) so it travels with the folder like
 *   the desk's style. Reached from the palette's "Change Desk Icon" and
 *   from a desk row's menu in the all-desks view.
 */

import { findNode } from "../state/tree-helpers.js";
import { setDeskIcon } from "../state/state-desks.js";
import { deskIconName } from "../ui/custom-icons.js";
import { openIconPicker } from "../ui/icon-picker-modal.js";
import { typeIcons } from "./files-panel-shared.js";

/** Change the icon of the folder or project `nodeId`. */
export function changeNodeIcon(state, nodeId) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (node.type === "desk") { changeDeskIcon(state, nodeId); return; }
  if (node.type !== "folder" && node.type !== "project") return;
  openIconPicker({
    title: "Change icon",
    subject: node.name || "Untitled",
    current: node.icon || null,
    defaultIcon: typeIcons[node.type],
    onPick: (name) => {
      // Looked up again: the tree may have been replaced (a sync pull)
      // while the picker was open.
      const live = findNode(state.fileTree, nodeId);
      if (!live) return;
      if (name) live.icon = name;
      else delete live.icon;
      state.saveFileTree();
      state.emit("files-changed");
    },
  });
}

/** Change the icon of desk `deskId` (default: the active desk). */
export function changeDeskIcon(state, deskId) {
  const id = deskId || state.getActiveDesk?.()?.id;
  if (!id) return;
  const desk = (state.settings?.desks || []).find((d) => d.id === id);
  openIconPicker({
    title: "Change desk icon",
    subject: desk?.name || "Untitled desk",
    current: deskIconName(state, id),
    defaultIcon: typeIcons.desk,
    onPick: (name) => { void setDeskIcon(state, id, name); },
  });
}
