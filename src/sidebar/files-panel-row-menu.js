/**
 * Hamburger row menu for the files-panel tree. Renders the hamburger
 * button HTML, builds the list of entries that apply to a given node,
 * and pops a floating dropdown anchored to the clicked button when the
 * user opens it.
 *
 * Split out of files-panel.js so the panel file stays under the 700-line
 * cap. Callers wire `dispatchRowAction` so the actual action handlers
 * (rename / duplicate / delete / …) keep living alongside the rest of
 * the panel's row-handling code.
 */

import { findNode, findParentOfNode } from "../state/tree-helpers.js";
import { AppState } from "../state/state.js";

export const ROW_COLORS = [
  { key: "red",    rgba: "rgba(255, 82, 82, 0.13)",   swatch: "#ef5350" },
  { key: "orange", rgba: "rgba(255, 152, 0, 0.13)",   swatch: "#ff9800" },
  { key: "yellow", rgba: "rgba(255, 235, 59, 0.15)",  swatch: "#ffeb3b" },
  { key: "green",  rgba: "rgba(76, 175, 80, 0.13)",   swatch: "#4caf50" },
  { key: "teal",   rgba: "rgba(0, 188, 212, 0.13)",   swatch: "#00bcd4" },
  { key: "blue",   rgba: "rgba(66, 165, 245, 0.13)",  swatch: "#42a5f5" },
  { key: "indigo", rgba: "rgba(92, 107, 192, 0.15)",  swatch: "#5c6bc0" },
  { key: "purple", rgba: "rgba(171, 71, 188, 0.13)",  swatch: "#ab47bc" },
  { key: "pink",   rgba: "rgba(236, 64, 122, 0.13)",  swatch: "#ec407a" },
];

export function rowColorRgba(key) {
  if (!key) return null;
  const entry = ROW_COLORS.find(c => c.key === key);
  return entry ? entry.rgba : null;
}

const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith(AppState.INBOX_ID + ":");
const isImagesId = (id) => id === AppState.IMAGES_ID || id?.startsWith(AppState.IMAGES_ID + ":");
const isTrashId = (id) => id === AppState.TRASH_ID || id?.startsWith(AppState.TRASH_ID + ":");

const HAMBURGER_SVG = `<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

/** Render the actions cell for a row — a single hamburger button when
 *  there's at least one entry, empty string otherwise. The button only
 *  carries the open-menu intent; the full entry list is rebuilt on
 *  demand inside `openRowMenu`. */
export function renderRowMenuButton(nodeId, nodeType, inTrash, item, inProject) {
  const entries = getMenuEntries(nodeId, nodeType, inTrash, item, inProject);
  if (entries.length === 0) return "";
  return `<span class="tree-actions" data-node-id="${nodeId}">
    <button class="tree-action-menu" data-tree-action="open-menu" data-tooltip="Menu" aria-label="Menu">${HAMBURGER_SVG}</button>
  </span>`;
}

/** Flagged-folder rows surface only the unflag action behind the same
 *  hamburger affordance for visual consistency. */
export function renderFlagOnlyMenuButton(nodeId) {
  return `<span class="tree-actions" data-node-id="${nodeId}">
    <button class="tree-action-menu" data-tree-action="open-menu" data-menu-flag-only="1" data-tooltip="Menu" aria-label="Menu">${HAMBURGER_SVG}</button>
  </span>`;
}

/** Compute the list of menu entries that apply to a given tree row.
 *  Each entry: `{ action, label, targetType? }`. */
function getMenuEntries(nodeId, nodeType, inTrash, item, inProject) {
  if (isTrashId(nodeId)) return [{ action: "empty-trash", label: "Empty Trash" }];
  if (item?.syncFolderId && item.type === "folder") return [];

  const isSpecial = isInboxId(nodeId) || isImagesId(nodeId);
  const isDoc = nodeType === "document";
  const isImage = nodeType === "image";
  const isContainer = nodeType === "folder" || nodeType === "project";
  // Docs auto-derive their name from first line while still "Untitled".
  // Once content has locked in a name, expose rename like notebooks do.
  const docRenameable = isDoc && item?.name && item.name !== "Untitled";

  const entries = [];
  // Containers carry the "New Doc / New Notebook" entries at the top so
  // the most common action on a folder/project is the first thing in
  // the menu. Inbox is internally typed as a project so it lands here
  // too — natural since it's where new files live by default. Images
  // is also typed as project but the new-here actions don't make sense
  // there (it only holds image refs), so it's explicitly skipped.
  if (isContainer && !inTrash && !isImagesId(nodeId)) {
    entries.push({ action: "new-doc-here", label: "New Doc" });
    entries.push({ action: "new-notebook-here", label: "New Notebook" });
  }

  if (!isSpecial && !inTrash && !isImage) {
    entries.push({ action: "flag", label: item?.flagged ? "Unflag" : "Flag" });
  }
  if (!(isSpecial || (isDoc && !docRenameable))) {
    entries.push({ action: "rename", label: "Rename" });
  }
  if (isDoc && inProject && !inTrash) {
    entries.push({ action: "use-as-note", label: item?.useAsNote ? "Stop using as note" : "Use as note" });
  }
  if (!isSpecial && isContainer && !item?.syncFolderId) {
    const target = nodeType === "folder" ? "project" : "folder";
    entries.push({ action: "convert-container", label: `Convert to ${target}`, targetType: target });
  }
  if (nodeType === "project" && !isSpecial && !inTrash) {
    entries.push({ action: "convert-project-to-doc", label: "Convert to Doc" });
  }
  if (isDoc && !inTrash && !inProject) {
    entries.push({ action: "convert-doc-to-project", label: "Convert to Project" });
  }
  if (isContainer && !inTrash && !isImagesId(nodeId)) {
    entries.push({ action: "open-as-stack", label: "Open as Stack" });
  }
  if (!(isSpecial || isImage || nodeType === "pdf")) {
    entries.push({ action: "duplicate", label: "Duplicate" });
  }
  if (!isSpecial) {
    entries.push({ action: "delete", label: "Delete" });
  }
  return entries;
}

let openMenuEl = null;

export function closeRowMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener("mousedown", onDocMousedownCloseMenu, true);
  document.removeEventListener("keydown", onDocKeydownCloseMenu, true);
  window.removeEventListener("blur", closeRowMenu);
}

function onDocMousedownCloseMenu(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeRowMenu();
}
function onDocKeydownCloseMenu(e) {
  if (e.key === "Escape") closeRowMenu();
}

/** Open the labeled dropdown for `nodeId`, anchored beneath the clicked
 *  hamburger button. `dispatchRowAction` is the panel's own action
 *  router — keeping the dispatch path single-source so menu clicks and
 *  any future inline button clicks land in the same handler table. */
export function openRowMenu(anchorBtn, nodeId, state, flagOnly, dispatchRowAction) {
  closeRowMenu();
  let entries;
  let node = null;
  if (flagOnly) {
    entries = [{ action: "flag", label: "Unflag" }];
  } else if (isTrashId(nodeId)) {
    entries = [{ action: "empty-trash", label: "Empty Trash" }];
  } else {
    node = findNode(state.fileTree, nodeId);
    if (!node) return;
    const inTrash = state.isInTrash(nodeId);
    const parent = node.type === "document" ? findParentOfNode(state.fileTree, nodeId) : null;
    const inProject = !!parent && parent.type === "project"
      && parent.id !== "__inbox__" && !parent.id?.startsWith("__inbox__:");
    entries = getMenuEntries(nodeId, node.type, inTrash, node, inProject);
  }
  if (!entries.length) return;

  const menu = document.createElement("div");
  menu.className = "tree-row-menu";

  // Color palette — first row of the menu for all non-trash nodes
  if (node && !isTrashId(nodeId) && !flagOnly) {
    const palette = document.createElement("div");
    palette.className = "tree-row-menu-colors";
    // Clear swatch
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tree-row-color-swatch tree-row-color-clear" + (!node?.bgColor ? " active" : "");
    clear.title = "Clear color";
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRowMenu();
      dispatchRowAction("set-color", nodeId, { colorKey: null });
    });
    palette.appendChild(clear);
    for (const c of ROW_COLORS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "tree-row-color-swatch" + (node?.bgColor === c.key ? " active" : "");
      sw.style.setProperty("--swatch-color", c.swatch);
      sw.title = c.key[0].toUpperCase() + c.key.slice(1);
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        closeRowMenu();
        dispatchRowAction("set-color", nodeId, { colorKey: c.key });
      });
      palette.appendChild(sw);
    }
    menu.appendChild(palette);
  }

  for (const ent of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tree-row-menu-item";
    item.dataset.treeAction = ent.action;
    if (ent.targetType) item.dataset.targetType = ent.targetType;
    item.textContent = ent.label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeRowMenu();
      dispatchRowAction(ent.action, nodeId, { anchor: anchorBtn, targetType: ent.targetType });
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  // Position the menu just below the hamburger, right-aligned to it,
  // and clamped inside the viewport.
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 6) top = Math.max(6, rect.top - menuH - 4);
  let left = rect.right - menuW;
  if (left < 6) left = 6;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  menu.style.top = top + "px";
  menu.style.left = left + "px";
  openMenuEl = menu;

  // Defer the listeners by one frame so the click that opened the menu
  // doesn't immediately close it via the mousedown-outside handler.
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onDocMousedownCloseMenu, true);
    document.addEventListener("keydown", onDocKeydownCloseMenu, true);
    window.addEventListener("blur", closeRowMenu);
  });
}
