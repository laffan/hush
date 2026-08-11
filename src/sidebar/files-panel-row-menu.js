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

/** Build the color-palette element used by both the row menu and the
 *  multi-select view. `currentKey` highlights the active swatch (pass
 *  `null` to highlight "clear", or `undefined` to highlight nothing —
 *  used by the multi-select view when the selection has mixed colors).
 *  `onPick(colorKey)` fires with the chosen key, or `null` for clear. */
export function createColorPalette(currentKey, onPick) {
  const palette = document.createElement("div");
  palette.className = "tree-row-menu-colors";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "tree-row-color-swatch tree-row-color-clear" + (currentKey === null ? " active" : "");
  clear.title = "Clear color";
  clear.addEventListener("click", (e) => { e.stopPropagation(); onPick(null); });
  palette.appendChild(clear);
  for (const c of ROW_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "tree-row-color-swatch" + (currentKey === c.key ? " active" : "");
    sw.style.setProperty("--swatch-color", c.swatch);
    sw.title = c.key[0].toUpperCase() + c.key.slice(1);
    sw.addEventListener("click", (e) => { e.stopPropagation(); onPick(c.key); });
    palette.appendChild(sw);
  }
  return palette;
}

const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith(AppState.INBOX_ID + ":");
const isImagesId = (id) => id === AppState.IMAGES_ID || id?.startsWith(AppState.IMAGES_ID + ":");
const isPdfsId = (id) => id === AppState.PDFS_ID || id?.startsWith(AppState.PDFS_ID + ":");
const isArchiveId = (id) => id === AppState.ARCHIVE_ID || id?.startsWith(AppState.ARCHIVE_ID + ":");
const isTrashId = (id) => id === AppState.TRASH_ID || id?.startsWith(AppState.TRASH_ID + ":");

const HAMBURGER_SVG = `<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

// Icon-row glyphs — the flag / rename / delete trio surfaced as a strip
// of icon buttons at the top of the row menu. Flag reuses the sidebar's
// wavy-flag glyph; delete reuses the trash-can from typeIcons.
const MENU_ICONS = {
  flag: `<svg viewBox="0 0 16 16"><path d="M3 10s1-1 3-1 4 2 6 2 3-1 3-1V2s-1 1-3 1-4-2-6-2-3 1-3 1z" /><line x1="3" y1="14" x2="3" y2="10" /></svg>`,
  rename: `<svg viewBox="0 0 16 16"><path d="M11 2l3 3-8.5 8.5L2 14l.5-3.5z" /><line x1="9.5" y1="3.5" x2="12.5" y2="6.5" /></svg>`,
  delete: `<svg viewBox="0 0 16 16"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
};

// The actions promoted from labeled entries to the icon row. Only the
// standard single-word labels move up — context-specific delete labels
// ("Remove from Project") stay as labeled entries so their meaning
// isn't lost behind a trash glyph.
const ICON_ROW_LABELS = { flag: ["Flag", "Unflag"], rename: ["Rename"], delete: ["Delete"] };
// temp/temp-icons/shelf-icon.svg, restroked to currentColor (2×2 grid).
const SHELF_SVG = `<svg viewBox="0 0 24 24"><path d="M14 20.4V14.6C14 14.2686 14.2686 14 14.6 14H20.4C20.7314 14 21 14.2686 21 14.6V20.4C21 20.7314 20.7314 21 20.4 21H14.6C14.2686 21 14 20.7314 14 20.4Z"/><path d="M3 20.4V14.6C3 14.2686 3.26863 14 3.6 14H9.4C9.73137 14 10 14.2686 10 14.6V20.4C10 20.7314 9.73137 21 9.4 21H3.6C3.26863 21 3 20.7314 3 20.4Z"/><path d="M14 9.4V3.6C14 3.26863 14.2686 3 14.6 3H20.4C20.7314 3 21 3.26863 21 3.6V9.4C21 9.73137 20.7314 10 20.4 10H14.6C14.2686 10 14 9.73137 14 9.4Z"/><path d="M3 9.4V3.6C3 3.26863 3.26863 3 3.6 3H9.4C9.73137 3 10 3.26863 10 3.6V9.4C10 9.73137 9.73137 10 9.4 10H3.6C3.26863 10 3 9.73137 3 9.4Z"/></svg>`;

/** Render the actions cell for a row — a single hamburger button when
 *  there's at least one entry, empty string otherwise. The button only
 *  carries the open-menu intent; the full entry list is rebuilt on
 *  demand inside `openRowMenu`. PDFs folders (the desk special and a
 *  project's own) additionally get a dedicated shelf button to the
 *  left of the hamburger. */
export function renderRowMenuButton(nodeId, nodeType, inTrash, item, inProject) {
  const entries = getMenuEntries(nodeId, nodeType, inTrash, item, inProject);
  const isShelfRow = !inTrash && (isPdfsId(nodeId) || item?.pdfFolder === true);
  // Real projects carry a Desktop button in the same slot — the canvas
  // overview of everything inside them. The specials are internally
  // typed as projects but aren't Desktops. (Desk-wide Desktops were
  // tried and shelved — Desktops are a project feature for now.)
  const isDesktopRow = !inTrash
    && nodeType === "project" && !isInboxId(nodeId) && !isImagesId(nodeId)
    && !isArchiveId(nodeId) && !item?.pdfFolder && !item?.syncFolderId;
  const shelfBtn = isShelfRow
    ? `<button class="tree-action-shelf" data-tree-action="view-shelf" data-tooltip="View Shelf" aria-label="View Shelf">${SHELF_SVG}</button>`
    : isDesktopRow
      ? `<button class="tree-action-shelf" data-tree-action="view-desktop" data-tooltip="View Desktop" aria-label="View Desktop">${SHELF_SVG}</button>`
      : "";
  if (entries.length === 0 && !shelfBtn) return "";
  const menuBtn = entries.length
    ? `<button class="tree-action-menu" data-tree-action="open-menu" data-tooltip="Menu" aria-label="Menu">${HAMBURGER_SVG}</button>`
    : "";
  return `<span class="tree-actions" data-node-id="${nodeId}">
    ${shelfBtn}${menuBtn}
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
  // Desk rows (only rendered in the all-desks view) carry their own
  // small action set — set-active is the headline action since the
  // active desk owns theme / Cmd+N / which Local Folders show.
  if (nodeType === "desk") {
    return [
      { action: "set-active-desk", label: "Set as Active" },
      { action: "rename-desk", label: "Rename" },
      // Archive, not Delete: the desk is zipped into an internal archive
      // and can be brought back as a new desk at any time (see
      // sidebar/desk-archive.js).
      { action: "archive-desk", label: "Archive" },
    ];
  }
  if (isTrashId(nodeId)) return [{ action: "empty-trash", label: "Empty Trash" }];
  if (item?.syncFolderId && item.type === "folder") return [];

  if (inTrash) {
    return [
      { action: "restore", label: "Remove from trash" },
      { action: "permanent-delete", label: "Permanently Delete" },
    ];
  }

  // A project's own PDFs folder holds aliases only — the shelf lives on
  // the row's dedicated button (Delete just drops the references).
  if (item?.pdfFolder) {
    return [{ action: "delete", label: "Remove from Project" }];
  }
  // A PDF alias row is a reference — removing it never touches the
  // desk's copy, so no Flag / Delete-to-Trash noise.
  if (item?.pdfAlias) {
    return [{ action: "delete", label: "Remove from Project" }];
  }

  const isSpecial = isInboxId(nodeId) || isImagesId(nodeId) || isPdfsId(nodeId) || isArchiveId(nodeId);
  const isDoc = nodeType === "document";
  const isImage = nodeType === "image";
  const isPdf = nodeType === "pdf";
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
  // there (it only holds image refs), so it's explicitly skipped —
  // as is the PDFs folder (PDFs arrive via Zotero only).
  if (isContainer && !isImagesId(nodeId) && !isPdfsId(nodeId) && !isArchiveId(nodeId)) {
    entries.push({ action: "new-doc-here", label: "New Doc" });
    entries.push({ action: "new-notebook-here", label: "New Notebook" });
  }

  if (!isSpecial && !isImage) {
    entries.push({ action: "flag", label: item?.flagged ? "Unflag" : "Flag" });
  }
  if (!(isSpecial || isPdf || (isDoc && !docRenameable))) {
    entries.push({ action: "rename", label: "Rename" });
  }
  if (isDoc && inProject) {
    entries.push({ action: "use-as-note", label: item?.useAsNote ? "Stop using as note" : "Use as note" });
  }
  if (!isSpecial && isContainer && !item?.syncFolderId) {
    const target = nodeType === "folder" ? "project" : "folder";
    entries.push({ action: "convert-container", label: `Convert to ${target}`, targetType: target });
  }
  if (nodeType === "project" && !isSpecial) {
    entries.push({ action: "convert-project-to-doc", label: "Convert to Doc" });
    entries.push({ action: "toggle-numbering", label: item?.showNumbers ? "Hide numbers" : "Show numbers" });
  }
  if (isDoc && !inProject) {
    entries.push({ action: "convert-doc-to-project", label: "Convert to Project" });
  }
  // Split at Headings works on any doc. Standalone docs become a new
  // project; a doc already inside a project splits into sibling docs.
  if (isDoc) {
    entries.push({ action: "split-at-headings", label: "Split Headings to Files" });
    entries.push({ action: "convert-headings-to-tabs", label: "Convert Headings to Tabs" });
  }
  if (isContainer && !isImagesId(nodeId) && !isArchiveId(nodeId)) {
    entries.push({ action: "open-as-stack", label: "Open as Stack" });
  }
  if (!(isSpecial || isImage || isPdf)) {
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
    // Local-desk actions need runtime state (the roots map), so they
    // join here rather than in the static entry builder.
    if (node.type === "desk" && typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
      const isLocal = !!state.deskRoots?.[nodeId];
      // A local desk takes its name from its folder — rename the folder,
      // not the desk. Drop the entry rather than letting it fail.
      if (isLocal) entries = entries.filter((e) => e.action !== "rename-desk");
      // No Finder to reveal into on iOS.
      const canReveal = !/iPad|iPhone|iPod/.test(navigator.userAgent || "")
        && !(/Mac/i.test(navigator.platform || "") && (navigator.maxTouchPoints || 0) > 0);
      const insertAt = entries.findIndex((e) => e.action === "archive-desk");
      const extra = isLocal
        ? [
            ...(canReveal ? [{ action: "reveal-desk-folder", label: "Reveal Folder" }] : []),
            { action: "make-desk-internal", label: "Make Internal" },
          ]
        : [{ action: "make-desk-local", label: "Make Local…" }];
      entries.splice(insertAt < 0 ? entries.length : insertAt, 0, ...extra);
    }
  }
  if (!entries.length) return;

  const menu = document.createElement("div");
  menu.className = "tree-row-menu";

  // Partition: the standard flag / rename / delete actions render as a
  // strip of icon buttons at the top; everything else keeps its labeled
  // list entry below.
  const iconEntries = [];
  const listEntries = [];
  for (const ent of entries) {
    const iconable = ICON_ROW_LABELS[ent.action]?.includes(ent.label);
    (iconable ? iconEntries : listEntries).push(ent);
  }

  if (iconEntries.length) {
    const iconRow = document.createElement("div");
    iconRow.className = "tree-row-menu-icons";
    for (const ent of iconEntries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tree-row-menu-icon-btn tree-row-menu-icon-${ent.action}`;
      if (ent.action === "flag" && ent.label === "Unflag") btn.classList.add("active");
      btn.dataset.treeAction = ent.action;
      btn.title = ent.label;
      btn.setAttribute("aria-label", ent.label);
      btn.innerHTML = MENU_ICONS[ent.action];
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeRowMenu();
        dispatchRowAction(ent.action, nodeId, { anchor: anchorBtn, targetType: ent.targetType });
      });
      iconRow.appendChild(btn);
    }
    menu.appendChild(iconRow);
  }

  for (const ent of listEntries) {
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

  // Color palette — last row of the menu for all non-trash nodes
  // (skipped for trashed items too — their menu is just destructive
  // actions, coloring them adds noise)
  if (node && !isTrashId(nodeId) && !flagOnly && !state.isInTrash(nodeId)) {
    menu.appendChild(createColorPalette(node.bgColor || null, (colorKey) => {
      closeRowMenu();
      dispatchRowAction("set-color", nodeId, { colorKey });
    }));
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
