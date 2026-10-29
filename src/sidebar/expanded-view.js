/**
 * Expanded view — any folder, project or Inbox can show its files as
 * cards: each direct child (not the files further in) framed, with its
 * preview (inbox-preview.js — a document's last words, a notebook's
 * snapshot, a stack's files), its docked panes, its cards and its
 * last-edited time. The expand button left of a row's menu turns it on
 * or off for that container.
 *
 * Remembered per container across sessions: `settings.expandedViews`,
 * container id → true / false. With no entry, an Inbox is expanded (it
 * was the only expanded view before there was a choice — a desk whose
 * old "Show Inbox Item Preview" was off, `inboxPreviewByDesk`, keeps its
 * Inbox collapsed) and everything else is not.
 */
import { AppState } from "../state/state.js";
import { findParentOfNode } from "../state/tree-helpers.js";

const isInboxId = (id) => id === AppState.INBOX_ID || id?.startsWith?.(AppState.INBOX_ID + ":");
const NOT_EXPANDABLE = [AppState.TRASH_ID, AppState.PDFS_ID, AppState.IMAGES_ID];

/** "Expand" (arrows out) and "collapse" (arrows in). */
export const EXPAND_SVG = `<svg viewBox="0 0 16 16"><path d="M9.5 2.5H13.5V6.5 M13.5 2.5L9 7 M6.5 13.5H2.5V9.5 M2.5 13.5L7 9"/></svg>`;
export const COLLAPSE_SVG = `<svg viewBox="0 0 16 16"><path d="M13 7H9V3 M9 7L13.5 2.5 M3 9H7V13 M7 9L2.5 13.5"/></svg>`;

/** Whether a row can take the expanded view: an Inbox, a folder or a
 *  project — not the Trash, the PDFs or Images folders, a desk, or
 *  anything in the Trash. */
export function canExpandView(item, inTrash) {
  if (!item?.id || inTrash) return false;
  if (NOT_EXPANDABLE.some((p) => item.id === p || item.id.startsWith(p + ":"))) return false;
  if (item.pdfFolder) return false;
  return isInboxId(item.id) || item.type === "folder" || item.type === "project";
}

export function isExpandedView(state, containerId) {
  const map = state.settings?.expandedViews;
  if (map && typeof map === "object" && typeof map[containerId] === "boolean") return map[containerId];
  if (!isInboxId(containerId)) return false;
  const deskId = containerId.includes(":") ? containerId.slice(containerId.indexOf(":") + 1) : state.settings?.activeDeskId;
  return state.settings?.inboxPreviewByDesk?.[deskId] !== false;
}

/** Whether `item` shows as a card: a document, notebook or stack whose
 *  parent is in the expanded view. */
export function inExpandedView(state, item) {
  if (!item?.fileId || !["document", "notebook", "stack"].includes(item.type)) return false;
  const parent = findParentOfNode(state.fileTree, item.id);
  return !!parent && isExpandedView(state, parent.id);
}

export function toggleExpandedView(state, containerId) {
  const map = state.settings?.expandedViews && typeof state.settings.expandedViews === "object" ? state.settings.expandedViews : {};
  return state.updateSettings({ expandedViews: { ...map, [containerId]: !isExpandedView(state, containerId) } });
}

/** The expand / collapse button for a container's row. */
export function expandViewButton(state, item) {
  const on = isExpandedView(state, item.id);
  const label = on ? "Collapse view" : "Expanded view";
  return `<button class="tree-action-expand${on ? " active" : ""}" data-tree-action="toggle-expanded-view" data-tooltip="${label}" aria-label="${label}" aria-pressed="${on}">${on ? COLLAPSE_SVG : EXPAND_SVG}</button>`;
}
