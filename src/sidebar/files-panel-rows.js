/**
 * Files panel — per-row rendering helpers extracted from files-panel.js.
 * Special-id predicates, the active-desk top-level filter, the row icon
 * picker, multi-window badges, and the PDF row HTML. Everything here is pure
 * or import-driven (no files-panel module state), so both the main tree and
 * the Flagged section can import from it without coupling back.
 */

import { AppState } from "../state/state.js";
import { findParentOfNode } from "../state/tree-helpers.js";
import { isDropboxConnected } from "../sync/sync-polling.js";
import { typeIcons, escHtml } from "./files-panel-shared.js";
import { renderRowMenuButton, renderFlagOnlyMenuButton } from "./files-panel-row-menu.js";
import { isTabMarkerItem } from "./files-panel-tabs.js";

// Per-desk specials: `<kind>:<deskId>`; bare ids only surface for the
// one boot tick before `migrateLegacyTreeIfNeeded` runs.
export const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith(AppState.INBOX_ID + ":");
export const isImagesId = (id) => id === AppState.IMAGES_ID || id?.startsWith(AppState.IMAGES_ID + ":");
export const isPdfsId = (id) => id === AppState.PDFS_ID || id?.startsWith(AppState.PDFS_ID + ":");
export const isTrashId = (id) => id === AppState.TRASH_ID || id?.startsWith(AppState.TRASH_ID + ":");
export const isAnySpecialId = (id) => isInboxId(id) || isImagesId(id) || isPdfsId(id) || isTrashId(id);
export const allSpecialIds = (s, k) => [k, ...(s.settings?.desks || []).map(d => `${k}:${d.id}`)];

/** True when the user has chosen the "show all desks" panel view. */
export const isAllDesksMode = (s) =>
  s.settings?.deskDisplayMode === "all" && s.fileTree.some(n => n.type === "desk");

// Render the active desk's children only (the desk wrapper stays out
// of the panel). In "show all desks" mode every desk surfaces as a
// top-level row instead. Pre-migration boot tick falls back to the raw
// tree.
export const visibleTopLevel = (s) => {
  const desks = s.fileTree.filter(n => n.type === "desk");
  if (isAllDesksMode(s)) return desks;
  const active = desks.find(n => n.id === s.settings?.activeDeskId) || desks[0];
  const children = active ? (active.children || []) : s.fileTree;
  // The PDFs and Images folders only earn a row once they hold something —
  // an empty specials folder is just noise pinned above Trash.
  return children.filter(n =>
    (!isPdfsId(n.id) || (n.children && n.children.length > 0)) &&
    (!isImagesId(n.id) || (n.children && n.children.length > 0)));
};

// Skip predicate for outline-number labels (specials + tab markers).
export const numberSkip = (n) => isAnySpecialId(n.id) || isTabMarkerItem(n);

/** A doc has a paired gutter when one of its project siblings is a gutter
 *  notebook stamped for this doc. Such docs show their pane icons on the
 *  gutter row (inline), so their own below-row strip is suppressed. */
export function hasPairedGutter(state, docItem) {
  if (docItem.type !== "document" || !docItem.fileId) return false;
  const sibs = findParentOfNode(state.fileTree, docItem.id)?.children;
  return Array.isArray(sibs)
    && sibs.some((c) => c.type === "notebook" && c.gutter && c.gutterForDoc === docItem.fileId);
}

export function getIcon(item) {
  if (item.type === "desk") return typeIcons.desk;
  if (isInboxId(item.id)) return typeIcons.inbox;
  if (isImagesId(item.id)) return typeIcons.images;
  if (isPdfsId(item.id)) return typeIcons.pdf;
  if (isTrashId(item.id)) return typeIcons.trash;
  // Individual image nodes render without an icon so the sidebar stays
  // readable — hovering the row is the primary affordance anyway.
  if (item.type === "image") return "";
  // A project's gutter notebook reads as an attachment of the doc it sits
  // directly beneath — its icon is the notebook dot-grid bracketed by a
  // vertical rule on each side.
  if (item.type === "notebook" && item.gutter) return typeIcons.gutter;
  if (item.syncFolderId && item.type === "folder") {
    // Legacy synced folder nodes — show broken icon if Dropbox disconnected
    if (!isDropboxConnected()) return typeIcons.syncedFolderBroken;
    return typeIcons.syncedFolder;
  }
  // Plain folders read fine without a leading glyph — the disclosure
  // arrow alone signals containerhood.
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
export function windowBadgesHtml(item, state) {
  const list = state.windowList || [];
  if (list.length < 2) return "";
  const key = item.type === "project" ? item.id : item.fileId;
  if (!key) return "";
  const matches = list.filter(w => w.fileType === item.type && w.fileId === key);
  return matches.map(w => `<span class="tree-window-badge">${w.number}</span>`).join("");
}

export const actionButtons = renderRowMenuButton;
export const flagOnlyButton = renderFlagOnlyMenuButton;

let _pdfSyncModule = null;
export async function getPdfSync() {
  if (!_pdfSyncModule) _pdfSyncModule = await import("../sync/pdf-sync.js");
  return _pdfSyncModule;
}

export function buildPdfRowHtml(item, icon, state, inTrash, inProject) {
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
