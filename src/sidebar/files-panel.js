/**
 * Files panel — nested tree view with folders, projects and documents
 * Uses SortableList for drag-and-drop reordering
 * Special nodes: Inbox (pinned top), Trash (pinned bottom), Flagged (virtual)
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "../state/state.js";
import { collectFlaggedItems, findAncestorIds, normalizeProjectChildren, enforceSpecialPositions, findParentOfNode } from "../state/tree-helpers.js";
import { isDropboxConnected } from "../sync/sync-polling.js";
import { createPane } from "../pane/pane-manager.js";
import { paneIndicatorsFor, attachPaneIndicatorTooltip } from "./files-panel-pane-indicators.js";
import { typeIcons, escHtml, attachLeafHoverHandlers, showPromptModal, googleLinkBadgeHtml } from "./files-panel-shared.js";
import { refreshTooltips } from "../tooltips.js";
import { renderLocalSyncSection, getLocalSyncContainer } from "./files-panel-local-sync.js";
import { renderRowMenuButton, renderFlagOnlyMenuButton, openRowMenu } from "./files-panel-row-menu.js";
import { collectVisibleDocs, handleDocMultiClick, installDragSelect } from "./files-panel-multi-select.js";
import {
  handleRename, handleRevealInFinder, handleConvertContainer,
  handleDuplicate, handleDelete, handleEmptyTrash, handleOpenAsStack,
  handleConvertProjectToDoc, handleConvertDocToProject,
} from "./files-panel-actions.js";
import {
  isTabMarkerItem, augmentTreeWithTabs, stripTabMarkersFromTree,
  renderTabMarkerRow, openDocAtTab,
} from "./files-panel-tabs.js";

let sortableInstance = null;
let flaggedContainerEl = null;
let storedHidePanel = null;
let storedState = null;

// Per-desk specials: `<kind>:<deskId>`; bare ids only surface for the
// one boot tick before `migrateLegacyTreeIfNeeded` runs.
const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith(AppState.INBOX_ID + ":");
const isImagesId = (id) => id === AppState.IMAGES_ID || id?.startsWith(AppState.IMAGES_ID + ":");
const isPdfsId = (id) => id === AppState.PDFS_ID || id?.startsWith(AppState.PDFS_ID + ":");
const isTrashId = (id) => id === AppState.TRASH_ID || id?.startsWith(AppState.TRASH_ID + ":");
const isAnySpecialId = (id) => isInboxId(id) || isImagesId(id) || isPdfsId(id) || isTrashId(id);
const allSpecialIds = (s, k) => [k, ...(s.settings?.desks || []).map(d => `${k}:${d.id}`)];
// Render the active desk's children only (the desk wrapper stays out
// of the panel). Pre-migration boot tick falls back to the raw tree.
const visibleTopLevel = (s) => {
  const desks = s.fileTree.filter(n => n.type === "desk");
  const active = desks.find(n => n.id === s.settings?.activeDeskId) || desks[0];
  const children = active ? (active.children || []) : s.fileTree;
  return children.filter(n => !isPdfsId(n.id) || (n.children && n.children.length > 0));
};

function getIcon(item) {
  if (isInboxId(item.id)) return typeIcons.inbox;
  if (isImagesId(item.id)) return typeIcons.images;
  if (isPdfsId(item.id)) return typeIcons.pdf;
  if (isTrashId(item.id)) return typeIcons.trash;
  // Individual image nodes render without an icon so the sidebar stays
  // readable — hovering the row is the primary affordance anyway.
  if (item.type === "image") return "";
  if (item.syncFolderId && item.type === "folder") {
    // Legacy synced folder nodes — show broken icon if Dropbox disconnected
    if (!isDropboxConnected()) return typeIcons.syncedFolderBroken;
    return typeIcons.syncedFolder;
  }
  // Plain folders read fine in the tree without a leading glyph; the
  // disclosure arrow alone signals containerhood. The Add (+) popup
  // still uses typeIcons.folder so the create-action chip stays
  // identifiable.
  if (item.type === "folder") return "";
  if (item.flagged) {
    return typeIcons[item.type + "Flagged"] || typeIcons[item.type] || typeIcons.document;
  }
  if (item.type === "pdf") return item.flagged ? typeIcons.pdfFlagged : typeIcons.pdf;
  if (item.lockedStyleId && item.type === "document") return typeIcons.documentLocked;
  return typeIcons[item.type] || typeIcons.document;
}

/** Multi-window numeral badges for a tree row: one chip per window
 *  currently displaying this file. Documents/notebooks key off `fileId`,
 *  projects off the tree-node `id`. Returns "" when fewer than two
 *  Hush windows are open or no window matches. */
function windowBadgesHtml(item, state) {
  const list = state.windowList || [];
  if (list.length < 2) return "";
  const key = item.type === "project" ? item.id : item.fileId;
  if (!key) return "";
  const matches = list.filter(w => w.fileType === item.type && w.fileId === key);
  return matches.map(w => `<span class="tree-window-badge">${w.number}</span>`).join("");
}

const actionButtons = renderRowMenuButton;
const flagOnlyButton = renderFlagOnlyMenuButton;

let _pdfSyncModule = null;
async function getPdfSync() {
  if (!_pdfSyncModule) _pdfSyncModule = await import("../sync/pdf-sync.js");
  return _pdfSyncModule;
}

function buildPdfRowHtml(item, icon, state, inTrash, inProject) {
  let title = item.name;
  let subtitle = "";
  let progressHtml = "";
  let extraClass = "";
  try {
    const mod = _pdfSyncModule;
    if (mod) {
      const meta = mod.getPdfMeta(item.fileId);
      if (meta) {
        title = meta.title || item.name;
        const parts = [];
        if (meta.firstAuthor) parts.push(meta.firstAuthor);
        if (meta.year) parts.push(meta.year);
        subtitle = parts.join(", ");
      }
      const downloaded = mod.isPdfDownloaded(item.fileId);
      if (!downloaded) {
        extraClass = " pdf-pending";
        const progress = mod.getPdfDownloadProgress(item.fileId);
        if (progress != null) {
          progressHtml = `<span class="pdf-dl-progress">${progress}%</span>`;
        }
      }
    }
  } catch {}
  const buttons = actionButtons(item.id, item.type, inTrash, item, inProject);
  return `${icon}<span class="tree-item-pdf${extraClass}"><span class="tree-item-pdf-title">${escHtml(title)}</span>${subtitle ? `<span class="tree-item-pdf-subtitle">${escHtml(subtitle)}</span>` : ""}${progressHtml}</span>${windowBadgesHtml(item, state)}${buttons}`;
}

export function createFilesPanel(container, state, hidePanel) {
  storedHidePanel = hidePanel;
  storedState = state;
  initFilesPanelTabSync(state);
  getPdfSync();
  container.innerHTML = "";

  // (Create buttons moved to the footer's Add popup — see add-popup.js)

  // Flagged section — its own container, separate from SortableList
  flaggedContainerEl = document.createElement("ul");
  flaggedContainerEl.className = "tree-list-root flagged-section-root";
  container.appendChild(flaggedContainerEl);

  // Sortable list container
  const listContainer = document.createElement("ul");
  listContainer.className = "tree-list-root";
  container.appendChild(listContainer);

  // Local Sync section — rendered below the flagged + files trees so the
  // mount roots sit beneath the active desk's normal tree. Each entry
  // is a top-level disclosure that expands to its on-disk contents,
  // populated asynchronously.
  const localSyncContainer = document.createElement("ul");
  localSyncContainer.className = "tree-list-root local-sync-root";
  container.appendChild(localSyncContainer);
  renderLocalSyncSection(localSyncContainer, state, hidePanel, refreshFilesPanel);

  // Destroy previous instance
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  const sortedTree = augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state))));

  sortableInstance = new SortableList(listContainer, {
    data: sortedTree,
    getId: (item) => item.id,
    getChildren: (item) => item.children || [],
    setChildren: (item, children) => { item.children = children; },
    canNest: (item) => (item.type === "folder" || item.type === "project" || item.type === "desk") && !isImagesId(item.id) && !isPdfsId(item.id),
    canDrop: (draggedItem, targetItem) => {
      // Tab markers are synthetic — they can never be a drop target
      // and the dragged item can never be one (canDrag blocks them).
      if (isTabMarkerItem(targetItem)) return false;
      // Images must stay inside the Images folder — root-level drops
      // (targetItem === null) are rejected for them too.
      if (draggedItem.type === "image") {
        return !!targetItem && isImagesId(targetItem.id);
      }
      // PDFs live exclusively in the __pdfs__ folder — no reparenting.
      if (draggedItem.type === "pdf") return false;
      // Desks can't be nested; root-level drops are rejected since
      // every node must live inside a desk.
      if (draggedItem.type === "desk") return targetItem === null;
      if (targetItem === null) return false;
      if (isImagesId(targetItem.id)) return draggedItem.type === "image";
      if (isPdfsId(targetItem.id)) return false;
      if (targetItem.type === "folder") return true;
      if (targetItem.type === "desk") return ["document", "notebook", "stack", "folder", "project"].includes(draggedItem.type);
      if (targetItem.type === "project") return ["document", "notebook", "stack", "project"].includes(draggedItem.type);
      return false;
    },
    canDrag: (item) => {
      // Special nodes and desk containers themselves can't be dragged.
      if (isTabMarkerItem(item)) return false;
      return !isAnySpecialId(item.id) && item.type !== "desk";
    },
    enableKeyboard: false,
    dragStartDelay: 180,

    renderItem: (item, context) => {
      if (isTabMarkerItem(item)) {
        return renderTabMarkerRow(item, (entry) => {
          if (state.selectedDocIds.length) state.clearSelectedDocs();
          void openDocAtTab(state, entry.fileId, entry.tabOffset);
          if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        });
      }
      const icon = getIcon(item);
      const isActive = isItemActive(item, state);
      const inTrash = state.isInTrash(item.id);
      const _p = item.type === "document" ? findParentOfNode(state.fileTree, item.id) : null;
      const inProject = !!_p && _p.type === "project" && _p.id !== "__inbox__" && !_p.id?.startsWith("__inbox__:");
      const isMultiSelected = (item.type === "document" || item.type === "notebook") && item.fileId
        && Array.isArray(state.selectedDocIds) && state.selectedDocIds.includes(item.fileId);
      // The `.multi-selected` class lives on the outer `.sl-item`, not
      // the inner row, so SortableList's renderer can find it and
      // re-apply on each render() without us having to coordinate. We
      // also stamp `data-file-id` on the row so the multi-select event
      // listener can toggle the highlight in place without rebuilding
      // the whole panel (a rebuild during an active drag-select would
      // strand the cached row refs in `session.rows` on detached
      // elements and freeze the capture mid-gesture).
      if (context?.li) {
        context.li.classList.toggle("multi-selected", !!isMultiSelected);
        if (item.fileId) context.li.dataset.fileId = item.fileId;
      }
      const row = document.createElement("span");
      row.className = "tree-item-row" + (isActive ? " active" : "");

      if (item.type === "pdf" && item.fileId && !isPdfsId(item.id)) {
        const pdfHtml = buildPdfRowHtml(item, icon, state, inTrash, inProject);
        row.innerHTML = pdfHtml;
      } else {
        row.innerHTML = `${icon}${googleLinkBadgeHtml(item, state)}<span class="tree-item-name">${escHtml(item.name)}</span>${windowBadgesHtml(item, state)}${actionButtons(item.id, item.type, inTrash, item, inProject)}`;
      }
      if (item.type === "image" && item.fileId) attachImageTooltipToRow(row, item.fileId, item.name);
      const indicators = paneIndicatorsFor(item, state);
      if (!indicators) return row;
      const wrap = document.createElement("span");
      wrap.className = "tree-item-cell";
      wrap.append(row, indicators);
      return wrap;
    },

    onClick: (item, event) => {
      // Tab markers attach their own click handler inside
      // `renderTabMarkerRow` — SortableList's pointer flow bails on
      // non-draggable items, so onClick never fires for them.
      // Docs AND notebooks participate in the shift / cmd-click
      // multi-select — the listing view branches on type to call the
      // right open method. Anything else (folder, project, image, …)
      // falls through to its normal click handler and clears any
      // active selection on the way.
      const isMultiSelectable = (item.type === "document" || item.type === "notebook" || item.type === "pdf" || item.type === "stack") && item.fileId;
      if (isMultiSelectable) {
        if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          const visible = collectVisibleDocs(
            state, visibleTopLevel, sortFlaggedItems,
            sortableInstance?.state?.collapsedIds,
          );
          handleDocMultiClick(item, event, state, visible);
          refreshList(state);
          return;
        }
        // Plain click — drop any active multi-select and open via the
        // type-appropriate path.
        if (state.selectedDocIds.length) state.clearSelectedDocs();
        if (item.type === "notebook") state.openNotebook(item.fileId);
        else if (item.type === "pdf") state.openPdf(item.fileId);
        else if (item.type === "stack") state.openStack(item.fileId);
        else state.openFile(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        return;
      }
      // Non-doc / non-notebook click — clear any active selection so
      // the user isn't left in a "selection exists but I can't see
      // it" state when they navigate to a folder / project / etc.
      if (state.selectedDocIds.length) state.clearSelectedDocs();
      // Clicking anywhere on a folder-like row toggles its collapsed state.
      // This applies to Inbox, Images, Trash, and any user-created folder.
      // User projects still open into project view.
      const isFolderLike = item.type === "folder" || isInboxId(item.id) || isPdfsId(item.id) || item.type === "desk";
      if (isFolderLike) {
        if (sortableInstance) sortableInstance.toggle(item.id);
        return;
      }
      // Doc rows are handled above; the remaining types each have their
      // own open / preview path.
      if (item.type === "notebook" && item.fileId) {
        state.openNotebook(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "project") {
        state.openProject(item.id);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "image" && item.fileId) {
        openImagePreview(item.fileId, item.name);
      }
    },

    // Images can always escape the panel (no Cmd required) so the drop
    // lands in whatever editor/notebook is under the pointer.
    forceDragOutside: (item) => item && item.type === "image",

    onDragOutside: (item, clientX, clientY, pointerEvent) => {
      if (item.type === "image" && item.fileId) {
        import("../pane/text-drag.js").then(({ dropSidebarImageAt }) => {
          dropSidebarImageAt(item.fileId, clientX, clientY);
        });
        return;
      }
      const dragId = item.type === "project" ? item.id : item.fileId;
      const eligible = (item.type === "document" || item.type === "notebook" || item.type === "pdf" || item.type === "stack" || item.type === "project") && dragId;
      if (!eligible) return;
      // Alt/Option-drag onto an open stack → add as stack item
      const altHeld = pointerEvent?.altKey;
      if (altHeld && state.currentStackFileId) {
        import("../stack/stack-bridge.js").then(({ getStackInstance }) => {
          const inst = getStackInstance();
          if (inst) inst.handleFileDrop(dragId, item.type, item.name);
        });
        return;
      }
      // Cmd-drag (default) → create floating pane
      createPane(dragId, item.name, item.type, clientX, clientY);
    },

    onChange: (newData) => {
      // Tab markers are synthetic — strip them before any tree write
      // so the persisted file tree never inherits one. The augmenter
      // re-adds them on the next render.
      const cleaned = stripTabMarkersFromTree(newData);
      enforceSpecialPositions(cleaned);
      normalizeProjectChildren(cleaned);
      const active = state.fileTree.find(n => n.type === "desk" && n.id === state.settings?.activeDeskId)
        || state.fileTree.find(n => n.type === "desk");
      if (active) active.children = cleaned; else state.fileTree = cleaned;
      state.saveFileTree();
      state.reconcileSync();
      state.syncProjectOrdering(state.currentProjectId || null);
      if (state.currentProjectId) state.openProject(state.currentProjectId);
    },
  });

  // Ensure each Inbox is expanded by default (one global when desks
  // are off, one per desk when on).
  for (const id of allSpecialIds(state, AppState.INBOX_ID)) {
    if (sortableInstance.state.collapsedIds.has(id)) {
      sortableInstance.state.collapsedIds.delete(id);
    }
  }

  // Trash and Images stay collapsed unless the user explicitly opens them
  // (mirroring each other — both are "drawer" special nodes at the tail).
  for (const id of allSpecialIds(state, AppState.TRASH_ID)) sortableInstance.state.collapsedIds.add(id);
  for (const id of allSpecialIds(state, AppState.IMAGES_ID)) sortableInstance.state.collapsedIds.add(id);
  for (const id of allSpecialIds(state, AppState.PDFS_ID)) sortableInstance.state.collapsedIds.add(id);
  sortableInstance.render();

  // Render the virtual Flagged folder
  renderFlaggedSection(state);

  // Delegated action handlers
  listContainer.addEventListener("click", onActionClick);
  flaggedContainerEl.addEventListener("click", onActionClick);
  attachPaneIndicatorTooltip(listContainer);
  // Option-click on a row opens the Send-to-desk modal (when desks on).
  import("./send-to-desk-modal.js").then((m) => m.attachDeskShortcuts(listContainer, state));
  // Drag-select gutter on the panel's left edge — pointerdown inside
  // the 16 px strip arms a bounding-box selection over doc rows. Any
  // pointerdown elsewhere in the panel keeps routing through the
  // existing SortableList click / drag pipeline.
  installDragSelect(container, state);
}

function dispatchRowAction(action, nodeId, opts) {
  if (!storedState) return;
  const refresh = () => refreshList(storedState);
  if (action === "rename") {
    handleRename(nodeId, opts?.anchor || null, storedState, refresh);
  } else if (action === "duplicate") {
    handleDuplicate(nodeId, storedState, refresh);
  } else if (action === "convert-container") {
    handleConvertContainer(nodeId, opts?.targetType, storedState, refresh);
  } else if (action === "delete") {
    handleDelete(nodeId, storedState, refresh);
  } else if (action === "flag") {
    storedState.toggleFlagged(nodeId).then(refresh);
  } else if (action === "use-as-note") {
    storedState.toggleUseAsNote(nodeId).then(refresh);
  } else if (action === "reveal-in-finder") {
    handleRevealInFinder(nodeId, storedState);
  } else if (action === "empty-trash") {
    handleEmptyTrash(storedState, refresh);
  } else if (action === "open-as-stack") {
    handleOpenAsStack(nodeId, storedState, refresh);
  } else if (action === "convert-project-to-doc") {
    handleConvertProjectToDoc(nodeId, storedState, refresh);
  } else if (action === "convert-doc-to-project") {
    handleConvertDocToProject(nodeId, storedState, refresh);
  } else if (action === "new-doc-here") {
    storedState.newFile(nodeId).then(refresh);
  } else if (action === "new-notebook-here") {
    showPromptModal({
      title: "New notebook",
      label: "Name",
      placeholder: "New Notebook",
      initialValue: "New Notebook",
      confirmLabel: "Create",
      onConfirm: async (name) => {
        await storedState.createNotebook(name, nodeId);
        refresh();
      },
    });
  }
}

function onActionClick(e) {
  const actionBtn = e.target.closest("[data-tree-action]");
  if (!actionBtn) return;
  e.stopPropagation();

  const action = actionBtn.dataset.treeAction;
  const actionsEl = actionBtn.closest(".tree-actions");
  const nodeId = actionsEl?.dataset.nodeId;
  if (!nodeId || !storedState) return;

  if (action === "open-menu") {
    const flagOnly = actionBtn.dataset.menuFlagOnly === "1";
    openRowMenu(actionBtn, nodeId, storedState, flagOnly, dispatchRowAction);
    return;
  }
  dispatchRowAction(action, nodeId, { anchor: actionBtn, targetType: actionBtn.dataset.targetType });
}


// ===== Virtual Flagged Folder =====

let flaggedCollapsed = false;
// Per-node collapse state for nested entries inside the Flagged section.
// Keyed by the real tree node id — not stored cross-session, matching
// how the main tree's SortableList handles collapse.
const flaggedNodeCollapsed = new Set();

function renderFlaggedSection(state) {
  if (!flaggedContainerEl) return;
  flaggedContainerEl.innerHTML = "";

  const flaggedItems = collectFlaggedItems(state.fileTree);
  if (flaggedItems.length === 0) return;

  // Create the flagged folder as a regular li that looks like a folder
  const folderLi = document.createElement("li");
  folderLi.className = "sl-item flagged-virtual-folder";
  folderLi.dataset.id = "__flagged__";

  const contentWrapper = document.createElement("div");
  contentWrapper.className = "sl-item-content";

  // Fold arrow
  const foldArrow = document.createElement("button");
  foldArrow.className = "sl-fold-arrow";
  foldArrow.type = "button";
  foldArrow.textContent = flaggedCollapsed ? "\u25B6\uFE0E" : "\u25BC";
  foldArrow.setAttribute("aria-label", flaggedCollapsed ? "Expand" : "Collapse");
  foldArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    flaggedCollapsed = !flaggedCollapsed;
    renderFlaggedSection(state);
  });
  contentWrapper.appendChild(foldArrow);

  // Label
  const label = document.createElement("span");
  label.className = "sl-item-label";
  const mainLabel = document.createElement("span");
  mainLabel.className = "sl-item-main-label";
  const row = document.createElement("span");
  row.className = "tree-item-row";
  row.innerHTML = `${typeIcons.flaggedFolder}<span class="tree-item-name">Flagged</span>`;
  mainLabel.appendChild(row);
  label.appendChild(mainLabel);
  contentWrapper.appendChild(label);
  folderLi.appendChild(contentWrapper);

  // Render children if not collapsed
  if (!flaggedCollapsed) {
    const childList = document.createElement("ul");
    childList.className = "sl-list";
    for (const item of flaggedItems) {
      childList.appendChild(renderFlaggedNode(item, state, /*isBubbled=*/false));
    }
    folderLi.appendChild(childList);
  }

  flaggedContainerEl.appendChild(folderLi);
}

/**
 * Render one node inside the Flagged section. Folders/projects render
 * their children nested underneath, matching the main file tree layout.
 * `isBubbled` is true for descendants of a flagged folder — those get
 * no unflag button (clicking it would flag them independently).
 */
function renderFlaggedNode(item, state, isBubbled) {
  const li = document.createElement("li");
  li.className = "sl-item flagged-link-item";
  li.dataset.id = item.id;

  const itemContent = document.createElement("div");
  itemContent.className = "sl-item-content";

  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  const isCollapsed = flaggedNodeCollapsed.has(item.id);
  if (hasChildren) li.classList.add("has-children");
  if (hasChildren && isCollapsed) li.classList.add("collapsed");

  const foldBtn = document.createElement("button");
  foldBtn.className = "sl-fold-arrow" + (hasChildren ? "" : " sl-fold-empty");
  foldBtn.type = "button";
  if (hasChildren) {
    foldBtn.textContent = isCollapsed ? "\u25B6\uFE0E" : "\u25BC";
    foldBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (flaggedNodeCollapsed.has(item.id)) flaggedNodeCollapsed.delete(item.id);
      else flaggedNodeCollapsed.add(item.id);
      renderFlaggedSection(state);
    });
  } else {
    foldBtn.tabIndex = -1;
  }
  itemContent.appendChild(foldBtn);

  const itemLabel = document.createElement("span");
  itemLabel.className = "sl-item-label";
  const itemMain = document.createElement("span");
  itemMain.className = "sl-item-main-label";
  const itemRow = document.createElement("span");
  itemRow.className = "tree-item-row";
  // Only items directly flagged by the user get the unflag button —
  // descendants of a flagged folder bubble up without one.
  const button = (item.flagged && !isBubbled) ? flagOnlyButton(item.id) : "";
  itemRow.innerHTML = `${getIcon(item)}<span class="tree-item-name">${escHtml(item.name)}</span>${button}`;
  itemMain.appendChild(itemRow);
  itemLabel.appendChild(itemMain);
  itemContent.appendChild(itemLabel);
  li.appendChild(itemContent);

  attachLeafHoverHandlers(li);

  // Click the row: for docs/notebooks/projects, open + reveal. For
  // folders, toggle the nested children in place.
  itemContent.addEventListener("click", (e) => {
    if (e.target.closest("[data-tree-action]")) return;
    if (e.target.closest(".sl-fold-arrow")) return;
    if (item.type === "folder") {
      if (flaggedNodeCollapsed.has(item.id)) flaggedNodeCollapsed.delete(item.id);
      else flaggedNodeCollapsed.add(item.id);
      renderFlaggedSection(state);
      return;
    }
    revealAndOpen(item, state);
  });

  // Nested children (for a flagged folder or any of its sub-folders)
  if (hasChildren && !isCollapsed) {
    const childUl = document.createElement("ul");
    childUl.className = "sl-list";
    for (const child of item.children) {
      childUl.appendChild(renderFlaggedNode(child, state, /*isBubbled=*/true));
    }
    li.appendChild(childUl);
  }

  return li;
}

function revealAndOpen(item, state) {
  // Expand all ancestors in the sortable list so the item is visible
  const ancestors = findAncestorIds(state.fileTree, item.id);
  if (ancestors && sortableInstance) {
    for (const aid of ancestors) {
      sortableInstance.state.collapsedIds.delete(aid);
    }
    sortableInstance.render();
    renderFlaggedSection(state);
  }

  // Open the item
  const isInset = document.querySelector("#panel-overlay")?.classList.contains("panel-inset");
  if (item.type === "document" && item.fileId) {
    state.openFile(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "notebook" && item.fileId) {
    state.openNotebook(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "pdf" && item.fileId) {
    state.openPdf(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "project") {
    state.openProject(item.id);
    if (!isInset && storedHidePanel) storedHidePanel();
  }
}


function sortFlaggedItems(tree) {
  return tree.map(node => {
    if (!node.children || node.children.length === 0) return node;
    const sortedChildren = sortFlaggedItems(node.children);
    if (node.type === "folder") {
      const flagged = sortedChildren.filter(c => c.flagged);
      const unflagged = sortedChildren.filter(c => !c.flagged);
      return { ...node, children: [...flagged, ...unflagged] };
    }
    return { ...node, children: sortedChildren };
  });
}

function isItemActive(item, state) {
  if (item.type === "document" && item.fileId) {
    return item.fileId === state.currentFileId && !state.currentProjectId;
  }
  if (item.type === "notebook" && item.fileId) {
    return item.fileId === state.currentNotebookFileId;
  }
  if (item.type === "pdf" && item.fileId) {
    return item.fileId === state.currentPdfFileId;
  }
  if (item.type === "project") return item.id === state.currentProjectId;
  return false;
}

function refreshList(state) {
  if (sortableInstance) {
    const sorted = augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state))));
    sortableInstance.setData(sorted);
  }
  renderFlaggedSection(state);
  // Any rows we might have had a tooltip open over may have been re-
  // rendered or removed — drop the tooltip so it can't linger.
  import("../editor/image-preview.js").then(({ hideImageTooltip }) => hideImageTooltip());
  // Newly-rendered rows carry `data-tooltip` markers; the global gate's
  // walk only runs on settings change, so re-apply here so freshly added
  // hover-action buttons pick up the user's Show Tooltips setting.
  refreshTooltips();
}

/** Debounced refresh triggered by `doc-content-changed`. Editing a doc
 *  shouldn't repaint the panel on every keystroke, but tab markers
 *  added or renamed mid-session should land in the sidebar without
 *  forcing the user to switch files. 600 ms keeps the cadence calm
 *  while still feeling live. */
let _tabRefreshTimer = null;
function scheduleTabRefresh(state) {
  if (_tabRefreshTimer) clearTimeout(_tabRefreshTimer);
  _tabRefreshTimer = setTimeout(() => {
    _tabRefreshTimer = null;
    refreshList(state);
  }, 600);
}

export function refreshFilesPanel(state) {
  refreshList(state);
  // Re-render the local-sync section as well so newly added/removed
  // folders or watcher-pushed changes land in the panel. Prefer the
  // cached reference, but fall back to a live DOM query so the refresh
  // still works if the cached container got out of sync (e.g. the panel
  // was rebuilt from outside createFilesPanel).
  const cached = getLocalSyncContainer();
  const root = cached?.isConnected ? cached : document.querySelector(".local-sync-root");
  if (root && storedState && storedHidePanel) {
    renderLocalSyncSection(root, storedState, storedHidePanel, refreshFilesPanel);
  }
}

/** Wire one-shot state listeners that keep the synthetic tab-marker
 *  rows in sync with the active editor. Idempotent — calling more
 *  than once is a no-op so the boot path can call it safely. */
let _tabSyncWired = false;
export function initFilesPanelTabSync(state) {
  if (_tabSyncWired) return;
  _tabSyncWired = true;
  state.on("doc-content-changed", () => scheduleTabRefresh(state));
}

async function openImagePreview(filename, name) {
  const { openImagePreviewModal } = await import("../editor/image-preview.js");
  openImagePreviewModal(filename, name);
}

function attachImageTooltipToRow(rowEl, filename, name) {
  import("../editor/image-preview.js").then(({ attachImageHoverTooltip }) => attachImageHoverTooltip(rowEl, filename, name));
}
