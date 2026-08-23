/**
 * Files panel — per-row rendering helpers extracted from files-panel.js.
 * Special-id predicates, the active-desk top-level filter, the row icon
 * picker, and the PDF row HTML. Everything here is pure
 * or import-driven (no files-panel module state), so both the main tree and
 * the Flagged section can import from it without coupling back.
 */

import { AppState } from "../state/state.js";
import { findParentOfNode, enforceSpecialPositions } from "../state/tree-helpers.js";
import { typeIcons, escHtml } from "./files-panel-shared.js";
import { renderRowMenuButton, renderFlagOnlyMenuButton } from "./files-panel-row-menu.js";
import { isTabMarkerItem } from "./files-panel-tabs.js";
import { isHeadingItem } from "./files-panel-headings.js";

// Per-desk specials: `<kind>:<deskId>`; bare ids only surface for the
// one boot tick before `migrateLegacyTreeIfNeeded` runs.
export const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith(AppState.INBOX_ID + ":");
export const isImagesId = (id) => id === AppState.IMAGES_ID || id?.startsWith(AppState.IMAGES_ID + ":");
export const isPdfsId = (id) => id === AppState.PDFS_ID || id?.startsWith(AppState.PDFS_ID + ":");
export const isArchiveId = (id) => id === AppState.ARCHIVE_ID || id?.startsWith(AppState.ARCHIVE_ID + ":");
export const isTrashId = (id) => id === AppState.TRASH_ID || id?.startsWith(AppState.TRASH_ID + ":");
export const isAnySpecialId = (id) => isInboxId(id) || isImagesId(id) || isPdfsId(id) || isArchiveId(id) || isTrashId(id);
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

/** The desk `visibleTopLevel` renders from (null in all-desks mode or a
 *  pre-migration flat tree). The files panel records this at render time
 *  so its drag onChange writes back into the desk the rows came from —
 *  never whichever desk happens to be active at drop time. Must mirror
 *  `visibleTopLevel`'s desk pick exactly. */
export const renderedDeskIdFor = (s) => {
  if (isAllDesksMode(s)) return null;
  const desks = s.fileTree.filter((n) => n.type === "desk");
  const active = desks.find((n) => n.id === s.settings?.activeDeskId) || desks[0];
  return active?.id || null;
};

/** Write a drag-reordered single-desk row list back into the desk it was
 *  rendered from. Returns false — commit nothing, caller re-renders —
 *  when the tree has desks but the rendered one is gone (deleted, or the
 *  tree was replaced under the panel); committing into whatever desk is
 *  active at drop time instead once transplanted another desk's children
 *  into a fresh local desk and orphaned the folder's real files. */
export function commitRenderedChildren(state, renderedDeskId, cleaned) {
  const hasDesks = state.fileTree.some((n) => n.type === "desk");
  const rendered = renderedDeskId
    ? state.fileTree.find((n) => n.type === "desk" && n.id === renderedDeskId)
    : null;
  if (hasDesks && !rendered) return false;
  if (rendered) {
    // The rows must actually belong to this desk. Per-desk specials
    // carry their desk's id (`__inbox__:<deskId>`), so a row set whose
    // specials name a *different* desk means the panel's rendered rows
    // and its recorded desk drifted apart — committing would transplant
    // one desk's entire contents into another (the bug where a desk
    // switch refreshed the rows but not the recorded id). Refuse; the
    // caller re-renders from the real tree.
    const foreign = cleaned.some((n) => {
      const owner = specialIdDeskOf(n?.id);
      return owner && owner !== renderedDeskId;
    });
    if (foreign) return false;
    // Re-add specials the render filtered out (empty Images / PDFs).
    const present = new Set(cleaned.map((n) => n.id));
    for (const orig of (rendered.children || [])) {
      if (isAnySpecialId(orig.id) && !present.has(orig.id)) cleaned.push(orig);
    }
  }
  enforceSpecialPositions(cleaned);
  if (rendered) rendered.children = cleaned;
  else state.fileTree = cleaned;
  return true;
}

/** The desk id a namespaced special id belongs to, or null. */
function specialIdDeskOf(id) {
  const m = typeof id === "string" && id.match(/^__[a-z]+__:(.+)$/);
  return m ? m[1] : null;
}

// Skip predicate for outline-number labels (specials + synthetic rows).
export const numberSkip = (n) => isAnySpecialId(n.id) || isTabMarkerItem(n) || isHeadingItem(n);

/** A doc has a paired gutter when one of its project siblings is a gutter
 *  notebook stamped for this doc. Such docs show their pane icons on the
 *  gutter row (inline), so their own below-row strip is suppressed. */
export function hasPairedGutter(state, docItem) {
  if (docItem.type !== "document" || !docItem.fileId) return false;
  const sibs = findParentOfNode(state.fileTree, docItem.id)?.children;
  return Array.isArray(sibs)
    && sibs.some((c) => c.type === "notebook" && c.gutter && c.gutterForDoc === docItem.fileId);
}

/** A week, in seconds — the age at which an Inbox row's timestamp turns
 *  red. The Inbox is a staging area, not a home: a file still sitting
 *  there a week after it was last touched is the thing the colour is
 *  for. */
const INBOX_STALE_SECONDS = 7 * 24 * 60 * 60;

/** Is this row a file sitting directly in a desk's Inbox? Rows there get
 *  the two-line treatment below; everywhere else in the tree a filename
 *  is a filename. */
export function isInboxItem(tree, item) {
  if (!item?.fileId) return false;
  if (item.type !== "document" && item.type !== "notebook" && item.type !== "stack") return false;
  return isInboxId(findParentOfNode(tree, item.id)?.id);
}

/** "3 minutes ago" … "12 Mar" — the file's last edit, at the coarsest
 *  granularity that still says something. Recent enough to be about
 *  *this session* reads in relative terms; older than that and the date
 *  is the more useful fact. */
function formatEditedAt(seconds) {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (age < 60) return "just now";
  if (age < 3600) { const m = Math.floor(age / 60); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  if (age < 86400) { const h = Math.floor(age / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  if (age < INBOX_STALE_SECONDS) { const d = Math.floor(age / 86400); return `${d} day${d === 1 ? "" : "s"} ago`; }
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

/** The stacked name + "last edited" line an Inbox row wears instead of a
 *  plain filename. Returns "" when the library listing has no mtime for
 *  this file — a PDF (whose bytes never go through `list_files`) or a
 *  file created this tick and not yet re-listed. */
export function inboxNameHtml(state, item, nameHtml) {
  const modified = state.files?.find((f) => f.id === item.fileId)?.modified;
  if (typeof modified !== "number" || !modified) return "";
  const stale = (Math.floor(Date.now() / 1000) - modified) > INBOX_STALE_SECONDS;
  const when = escHtml(formatEditedAt(modified));
  return `<span class="tree-item-name tree-item-inbox">`
    + `<span class="tree-item-inbox-name">${nameHtml}</span>`
    + `<span class="tree-item-inbox-edited${stale ? " stale" : ""}">${when}</span>`
    + `</span>`;
}

export function getIcon(item) {
  if (item.type === "desk") return typeIcons.desk;
  if (isInboxId(item.id)) return typeIcons.inbox;
  if (isImagesId(item.id)) return typeIcons.images;
  if (isPdfsId(item.id)) return typeIcons.pdf;
  if (isArchiveId(item.id)) return typeIcons.archive;
  if (isTrashId(item.id)) return typeIcons.trash;
  // Individual image nodes render without an icon so the sidebar stays
  // readable — hovering the row is the primary affordance anyway.
  if (item.type === "image") return "";
  // A project's gutter notebook reads as an attachment of the doc it sits
  // directly beneath — its icon is the notebook dot-grid bracketed by a
  // vertical rule on each side.
  if (item.type === "notebook" && item.gutter) return typeIcons.gutter;
  // A proofread notebook is a PDF cut into a canvas — worth telling
  // apart from an ordinary notebook at a glance, since a desk can end
  // up holding one per paper.
  if (item.type === "notebook" && item.proofread) return typeIcons.proofNotebook;
  // A project's own PDFs folder reads as a PDF container.
  if (item.type === "folder" && item.pdfFolder) return typeIcons.pdf;
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

export const actionButtons = renderRowMenuButton;
export const flagOnlyButton = renderFlagOnlyMenuButton;

/** Is this row the file/project currently open in the main editor?
 *  Drives the active-row underline. (Moved from files-panel.js for the
 *  line cap.) */
export function isItemActive(item, state) {
  if (item.type === "document" && item.fileId) {
    return item.fileId === state.currentFileId && !state.currentProjectId;
  }
  if (item.type === "notebook" && item.fileId) {
    return item.fileId === state.currentNotebookFileId;
  }
  if (item.type === "pdf" && item.fileId) {
    return item.fileId === state.currentPdfFileId;
  }
  if (item.type === "stack" && item.fileId) {
    return item.fileId === state.currentStackFileId;
  }
  if (item.type === "project") return item.id === state.currentProjectId;
  return false;
}

/* Flagged rows are NOT floated to the top of their folder any more, and
 * a sort like that must not come back as a tree transform.
 *
 * It read as display-only — a pure function returning a cloned tree —
 * but the clone was what seeded the SortableList, and the list's
 * `onChange` writes its data straight back to `state.fileTree` and
 * saves. So the float was real: flag an item, drag anything in the
 * sidebar afterwards, and the flagged item's borrowed position became
 * its persisted one. Unrecoverably, too — the original interleaving is
 * gone once the partition is committed. It also decided which file some
 * open paths land on, `openLastFileForDesk`'s "first child of the desk's
 * Inbox" fallback among them, which is flags choosing what opens.
 *
 * Flagged items still surface at the top of the sidebar, in the
 * dedicated Flagged section (`files-panel-flagged.js`) — that is the
 * affordance, and it costs the file order nothing. Anything that wants
 * the in-folder float back has to do it in the rendering layer, without
 * permuting the data the list commits from.
 */

let _pdfSyncModule = null;
export async function getPdfSync() {
  if (!_pdfSyncModule) _pdfSyncModule = await import("../sync/pdf-sync.js");
  return _pdfSyncModule;
}

export function buildPdfRowHtml(item, icon, inTrash, inProject) {
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
  return `${icon}<span class="tree-item-pdf${extraClass}"><span class="tree-item-pdf-title">${escHtml(title)}</span>${subtitle ? `<span class="tree-item-pdf-subtitle">${escHtml(subtitle)}</span>` : ""}${progressHtml}</span>${buttons}`;
}
