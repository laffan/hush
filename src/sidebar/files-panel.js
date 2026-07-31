/**
 * Files panel — nested tree view with folders, projects and documents.
 * SortableList drag-and-drop; special nodes: Inbox (top), Trash (bottom), Flagged (virtual).
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "../state/state.js";
import { findNode, findNodeByFileId, normalizeProjectChildren, enforceSpecialPositions, findParentOfNode, reapplyGutterMarkers } from "../state/tree-helpers.js";
import { createPane } from "../pane/pane-manager.js";
import { paneIndicatorsFor, attachPaneIndicatorTooltip } from "./files-panel-pane-indicators.js";
import { escHtml, showPromptModal, googleLinkBadgeHtml, computeNumberLabels, DRAG_HANDLE_SVG } from "./files-panel-shared.js";
import {
  isInboxId, isImagesId, isPdfsId, isTrashId, isAnySpecialId, allSpecialIds,
  visibleTopLevel, renderedDeskIdFor, commitRenderedChildren, isAllDesksMode, numberSkip, hasPairedGutter, getIcon, windowBadgesHtml,
  actionButtons, getPdfSync, buildPdfRowHtml, sortFlaggedItems,
  isItemActive,
} from "./files-panel-rows.js";
import { normalizePdfProjectAliases } from "../state/state-pdf-aliases.js";
import { refreshTooltips } from "../tooltips.js";
import { renderLocalSyncSection, getLocalSyncContainer, onLocalDropExternal, positionLocalSync as positionLocalSyncImpl } from "./files-panel-local-sync.js";
import { openRowMenu } from "./files-panel-row-menu.js";
import { collectVisibleDocs, handleDocMultiClick, installDragSelect } from "./files-panel-multi-select.js";
import {
  handleRename, handleRevealInFinder, handleConvertContainer,
  handleDuplicate, handleDelete, handleEmptyTrash, handleOpenAsStack,
  handleConvertProjectToDoc, handleConvertDocToProject,
  handleRestore, handlePermanentDelete, handleDeskAction,
} from "./files-panel-actions.js";
import { isTabMarkerItem, augmentTreeWithTabs, stripTabMarkersFromTree, renderTabMarkerRow, openDocAtTab } from "./files-panel-tabs.js";
import { isHeadingItem, augmentTreeWithHeadings, stripHeadingsFromTree, renderHeadingRow, openDocAtHeading } from "./files-panel-headings.js";
import { renderFlaggedSection } from "./files-panel-flagged.js";

let sortableInstance = null;
let flaggedContainerEl = null;
let storedHidePanel = null;
let storedState = null;
// Refs used to relocate the Local Folders section (nested in the active
// desk in the all-desks view; at the panel root in single-desk view).
let panelRootEl = null;
let treeListEl = null;
let localSyncRootEl = null;

// Outline-number labels for rows inside a project with `showNumbers`.
let numberLabels = new Map();

// Desk the sortable was seeded from — onChange commits into THIS desk
// (commitRenderedChildren), never the currently-active one.
let renderedDeskId = null;

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

  // Local Sync section — top-level disclosures that expand to on-disk
  // contents async. `positionLocalSync` nests it inside the active desk
  // in the all-desks view after the tree renders.
  const localSyncContainer = document.createElement("ul");
  localSyncContainer.className = "tree-list-root local-sync-root";
  container.appendChild(localSyncContainer);
  panelRootEl = container;
  treeListEl = listContainer;
  localSyncRootEl = localSyncContainer;
  renderLocalSyncSection(localSyncContainer, state, hidePanel, refreshFilesPanel);

  // Destroy previous instance
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  reapplyGutterMarkers(state.fileTree);
  renderedDeskId = renderedDeskIdFor(state);
  const sortedTree = augmentTreeWithHeadings(state, augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state)))));
  numberLabels = computeNumberLabels(sortedTree, numberSkip, isInboxId);

  sortableInstance = new SortableList(listContainer, {
    data: sortedTree,
    getId: (item) => item.id,
    getChildren: (item) => item.children || [],
    setChildren: (item, children) => { item.children = children; },
    canNest: (item) => (item.type === "folder" || item.type === "project" || item.type === "desk") && !isImagesId(item.id) && !isPdfsId(item.id),
    canDrop: (draggedItem, targetItem) => {
      // Tab markers and heading rows are synthetic — they can never be a
      // drop target and the dragged item can never be one (canDrag blocks them).
      if (isTabMarkerItem(targetItem) || isHeadingItem(targetItem)) return false;
      // Images stay inside the Images folder; desks can't nest
      // (root-level drops only).
      if (draggedItem.type === "image") return !!targetItem && isImagesId(targetItem.id);
      // PDFs accept exactly one reparenting gesture: dropping on a real
      // project (or a project's own PDFs folder) — the drop becomes an
      // alias there and the original returns to the desk's PDFs folder
      // (normalizePdfProjectAliases converts the move in onChange).
      if (draggedItem.type === "pdf") {
        if (!targetItem) return false;
        if (targetItem.pdfFolder) return true;
        return targetItem.type === "project" && !isInboxId(targetItem.id);
      }
      if (draggedItem.type === "desk") return targetItem === null;
      // Desk root (null): allowed single-desk, rejected all-desks (desk list).
      if (targetItem === null) return !isAllDesksMode(state);
      if (isImagesId(targetItem.id)) return draggedItem.type === "image";
      if (isPdfsId(targetItem.id)) return false;
      if (targetItem.pdfFolder) return false; // only PDFs (handled above)
      if (targetItem.type === "folder") return true;
      if (targetItem.type === "desk") return ["document", "notebook", "stack", "folder", "project"].includes(draggedItem.type);
      if (targetItem.type === "project") return ["document", "notebook", "stack", "project"].includes(draggedItem.type);
      return false;
    },
    canDrag: (item) => {
      if (isTabMarkerItem(item) || isHeadingItem(item)) return false;
      // In the all-desks view, desk rows are reorderable; everywhere else
      // the desk container itself stays put.
      if (item.type === "desk") return isAllDesksMode(state);
      return !isAnySpecialId(item.id);
    },
    // Multi-drag: if the dragged row belongs to a multi-selection, return
    // the node ids of the *other* selected files so they move together.
    getDraggedSiblings: (moved) => {
      const sel = state.selectedDocIds || [];
      if (sel.length < 2 || !moved?.fileId || !sel.includes(moved.fileId)) return [];
      return sel.filter((fid) => fid !== moved.fileId)
        .map((fid) => findNodeByFileId(state.fileTree, fid)).filter(Boolean).map((n) => n.id);
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
      if (isHeadingItem(item)) {
        return renderHeadingRow(item, (entry) => {
          if (state.selectedDocIds.length) state.clearSelectedDocs();
          void openDocAtHeading(state, entry.fileId, entry.headingOffset);
          if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        });
      }
      const icon = getIcon(item);
      const isActive = isItemActive(item, state);
      const inTrash = state.isInTrash(item.id);
      const _p = item.type === "document" ? findParentOfNode(state.fileTree, item.id) : null;
      const inProject = !!_p && _p.type === "project" && _p.id !== "__inbox__" && !_p.id?.startsWith("__inbox__:");
      const isMultiSelected = (item.type === "document" || item.type === "notebook" || item.type === "pdf") && item.fileId
        && Array.isArray(state.selectedDocIds) && state.selectedDocIds.includes(item.fileId);
      // `.multi-selected` lives on the outer `.sl-item` so it survives
      // re-renders; `data-file-id` lets the listener toggle it without a
      // full rebuild (which would strand cached row refs mid-drag-select).
      if (context?.li) {
        context.li.classList.toggle("multi-selected", !!isMultiSelected);
        if (item.fileId) context.li.dataset.fileId = item.fileId;
      }
      const isDesk = item.type === "desk";
      const isActiveDesk = isDesk && item.id === state.settings?.activeDeskId;
      const row = document.createElement("span");
      row.className = "tree-item-row" + (isActive ? " active" : "")
        + (isDesk ? " desk-row" : "") + (isActiveDesk ? " active-desk" : "");

      if (item.type === "pdf" && item.fileId && !isPdfsId(item.id)) {
        const pdfHtml = buildPdfRowHtml(item, icon, state, inTrash, inProject);
        row.innerHTML = pdfHtml;
      } else {
        const numLabel = numberLabels.get(item.id);
        const numPrefix = numLabel ? `<span class="tree-item-number">${escHtml(numLabel)}</span> ` : "";
        // Gutter notebooks are stored as `<docName>-gutter` but read as "Gutter".
        const displayName = (item.type === "notebook" && item.gutter) ? "Gutter" : item.name;
        // Reorder handle pinned right (left of the menu button). Active
        // desk: an inverted pill wrapping icon + name (icon strokes follow
        // currentColor, so they recolor to the pill text).
        const deskHandle = isDesk ? `<span class="desk-drag-handle" data-tooltip="Drag to reorder">${DRAG_HANDLE_SVG}</span>` : "";
        const trailing = `${windowBadgesHtml(item, state)}${deskHandle}${actionButtons(item.id, item.type, inTrash, item, inProject)}`;
        if (isActiveDesk) {
          row.innerHTML = `<span class="desk-active-pill">${icon}<span class="desk-active-name">${escHtml(displayName)}</span></span>${trailing}`;
        } else {
          row.innerHTML = `${icon}${googleLinkBadgeHtml(item, state)}<span class="tree-item-name">${numPrefix}${escHtml(displayName)}</span>${trailing}`;
        }
      }
      if (item.type === "image" && item.fileId) attachImageTooltipToRow(row, item.fileId, item.name);
      const indicators = paneIndicatorsFor(item, state);
      if (!indicators) return row;
      // The gutter row carries the doc's pane icons INLINE, appended inside the
      // name span so they sit directly after the "Gutter" text (not pushed to
      // the row's right edge by the name's flex:1).
      if (item.type === "notebook" && item.gutter) {
        row.querySelector(".tree-item-name")?.append(indicators);
        return row;
      }
      // A doc with a gutter shows its pane icons on the gutter row, not below
      // itself — drop the doc's own strip.
      if (item.type === "document" && hasPairedGutter(state, item)) return row;
      const wrap = document.createElement("span");
      wrap.className = "tree-item-cell";
      wrap.append(row, indicators);
      return wrap;
    },

    onClick: (item, event) => {
      // Docs / notebooks / pdfs / stacks participate in multi-select;
      // everything else falls through and clears any active selection.
      const isMultiSelectable = (item.type === "document" || item.type === "notebook" || item.type === "pdf" || item.type === "stack") && item.fileId;
      if (isMultiSelectable) {
        if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          const visible = collectVisibleDocs(state, visibleTopLevel, sortFlaggedItems, sortableInstance?.state?.collapsedIds);
          handleDocMultiClick(item, event, state, visible);
          refreshList(state);
          return;
        }
        if (state.selectedDocIds.length) state.clearSelectedDocs();
        if (item.type === "notebook") state.openNotebook(item.fileId);
        else if (item.type === "pdf") state.openPdf(item.fileId);
        else if (item.type === "stack") state.openStack(item.fileId);
        else state.openFile(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        return;
      }
      // Folder / project / image click: drop any selection, then route
      // folder-likes to a collapse toggle and the rest to their opener.
      if (state.selectedDocIds.length) state.clearSelectedDocs();
      const isFolderLike = item.type === "folder" || isInboxId(item.id) || isPdfsId(item.id) || item.type === "desk";
      if (isFolderLike) {
        if (sortableInstance) sortableInstance.toggle(item.id);
        return;
      }
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

    onDropExternal: (item, ev) => onLocalDropExternal(state, item, ev), // drop onto a Local Sync folder → move to disk
    onCollapseChange: (ids) => {
      state.updateSettings({ collapsedFolderIds: ids }); // persist folder open/closed state
      // The toggle re-rendered the tree — re-nest Local Folders after.
      queueMicrotask(() => positionLocalSync(state));
    },
    // Drag-end snap-backs and external/outside drops re-render the list
    // without an onChange, which would strand the Local Folders section
    // (it lives inside the list, just above Trash) — re-place it after.
    onDragEnd: () => { queueMicrotask(() => positionLocalSync(state)); },
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
      // Tab markers and heading rows are synthetic — strip them before any
      // tree write so the persisted tree never inherits one (re-added on render).
      const cleaned = stripHeadingsFromTree(stripTabMarkersFromTree(newData));
      if (isAllDesksMode(state)) {
        // The top level *is* the desk list. Re-pin specials inside each
        // desk (a cross-desk move can land an item beside Inbox/Trash).
        for (const desk of cleaned) {
          if (desk?.type !== "desk" || !Array.isArray(desk.children)) continue;
          enforceSpecialPositions(desk.children);
          normalizeProjectChildren(desk.children);
        }
        state.fileTree = cleaned;
        normalizePdfProjectAliases(state.fileTree);
        // Mirror any desk-row reorder into the settings.desks registry.
        const orderedIds = cleaned.filter(n => n.type === "desk").map(n => n.id);
        const reg = state.settings?.desks || [];
        const regById = new Map(reg.map(d => [d.id, d]));
        const newReg = orderedIds.map(id => regById.get(id)).filter(Boolean);
        for (const d of reg) if (!newReg.includes(d)) newReg.push(d);
        if (newReg.some((d, i) => d !== reg[i])) state.updateSettings({ desks: newReg });
        state.saveFileTree();
        state.reconcileSync();
        state.syncProjectOrdering(state.currentProjectId || null);
        if (state.currentProjectId) state.openProject(state.currentProjectId);
        queueMicrotask(() => positionLocalSync(state)); // re-nest Local Folders after the re-render
        return;
      }
      normalizeProjectChildren(cleaned);
      // Commit into the desk this list was rendered from; bail + re-render
      // if it's gone (see commitRenderedChildren).
      if (!commitRenderedChildren(state, renderedDeskId, cleaned)) {
        refreshList(state);
        return;
      }
      normalizePdfProjectAliases(state.fileTree);
      state.saveFileTree();
      state.reconcileSync();
      state.syncProjectOrdering(state.currentProjectId || null);
      if (state.currentProjectId) state.openProject(state.currentProjectId);
    },
  });

  // Restore persisted folder collapse state. On first run (no persisted
  // set) apply the defaults: Inbox open, Trash / Images / PDFs / Archive
  // collapsed (existing installs collapse Archive once, see state-desks).
  const persistedCollapsed = state.settings?.collapsedFolderIds;
  if (Array.isArray(persistedCollapsed)) {
    for (const id of persistedCollapsed) sortableInstance.state.collapsedIds.add(id);
  } else {
    for (const k of [AppState.TRASH_ID, AppState.IMAGES_ID, AppState.PDFS_ID, AppState.ARCHIVE_ID])
      for (const id of allSpecialIds(state, k)) sortableInstance.state.collapsedIds.add(id);
  }
  sortableInstance.render();
  positionLocalSync(state);

  // Render the virtual Flagged folder (files-panel-flagged.js — the refs
  // let its fold / reveal interactions re-render and expand the tree).
  renderFlaggedSection(state, {
    container: flaggedContainerEl,
    hidePanel: storedHidePanel,
    getSortable: () => sortableInstance,
  });

  // Delegated action handlers
  listContainer.addEventListener("click", onActionClick);
  flaggedContainerEl.addEventListener("click", onActionClick);
  attachPaneIndicatorTooltip(listContainer);
  // Option-click on a row opens the Send-to-desk modal (when desks on).
  import("./send-to-desk-modal.js").then((m) => m.attachDeskShortcuts(listContainer, state));
  // Drag-select gutter on the panel's left edge — a pointerdown in the
  // 16 px strip arms a bounding-box selection over doc rows.
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
  } else if (action === "view-shelf") {
    // The two takeover views are mutually exclusive — opening the shelf
    // dismisses an open Desktop and vice versa.
    import("../desktop/desktop-view.js").then((m) => m.closeDesktop()).catch(() => {});
    import("../pdf/pdf-shelf.js").then((m) => m.openPdfShelf(storedState, nodeId));
  } else if (action === "view-desktop") {
    import("../desktop/desktop-view.js").then((m) => m.openDesktop(storedState, nodeId));
  } else if (action === "open-as-stack") {
    handleOpenAsStack(nodeId, storedState, refresh);
  } else if (action === "convert-project-to-doc") {
    handleConvertProjectToDoc(nodeId, storedState, refresh);
  } else if (action === "convert-doc-to-project") {
    handleConvertDocToProject(nodeId, storedState, refresh);
  } else if (action === "split-at-headings") {
    import("./split-at-headings-modal.js").then((m) => m.openSplitAtHeadingsModal(storedState, nodeId));
  } else if (action === "convert-headings-to-tabs") {
    import("./convert-headings-to-tabs-modal.js").then((m) => m.openConvertHeadingsToTabsModal(storedState, nodeId));
  } else if (action === "toggle-numbering") {
    const node = findNode(storedState.fileTree, nodeId);
    if (node) {
      node.showNumbers = !node.showNumbers;
      storedState.saveFileTree();
      storedState.emit("files-changed");
    }
  } else if (action === "set-color") {
    const node = findNode(storedState.fileTree, nodeId);
    if (node) {
      if (opts?.colorKey) node.bgColor = opts.colorKey;
      else delete node.bgColor;
      storedState.saveFileTree();
      refresh();
    }
    return;
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
  } else if (action === "restore") {
    handleRestore(nodeId, storedState, refresh);
  } else if (action === "permanent-delete") {
    handlePermanentDelete(nodeId, storedState, refresh);
  } else if (action === "set-active-desk" || action === "rename-desk" || action === "delete-desk") {
    handleDeskAction(action, nodeId, storedState);
  } else if (action === "make-desk-local") {
    import("../sync/desk-roots.js").then((m) => m.makeDeskLocal(storedState, nodeId).then(refresh));
  } else if (action === "make-desk-internal") {
    import("../sync/desk-roots.js").then((m) => m.makeDeskInternal(storedState, nodeId).then(refresh));
  } else if (action === "reveal-desk-folder") {
    import("../sync/desk-roots.js").then((m) => m.revealDeskRoot(storedState, nodeId));
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

/** Re-place the Local Folders section above Trash. Thin wrapper over the
 *  impl in files-panel-local-sync.js (which owns the localSync container). */
function positionLocalSync(state) { positionLocalSyncImpl(state, treeListEl, panelRootEl); }

function refreshList(state) {
  if (sortableInstance) {
    reapplyGutterMarkers(state.fileTree);
    const sorted = augmentTreeWithHeadings(state, augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state)))));
    numberLabels = computeNumberLabels(sorted, numberSkip, isInboxId);
    sortableInstance.setData(sorted);
  }
  positionLocalSync(state);
  renderFlaggedSection(state, {
    container: flaggedContainerEl,
    hidePanel: storedHidePanel,
    getSortable: () => sortableInstance,
  });
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
  // refreshList already repositioned the local-sync container (nesting it
  // inside the active desk in all-desks mode); render its contents into it.
  const cached = getLocalSyncContainer() || localSyncRootEl;
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
