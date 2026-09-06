/**
 * File view data — the read-only projection of the file tree both canvas
 * views draw from, plus the one place either of them opens a file.
 *
 * Nothing here mutates the tree. The views are representations: drag in
 * them moves an icon on a desk surface, never a node in the tree, so the
 * whole drag-commit hazard the files panel carries (`commitRenderedChildren`)
 * simply doesn't arise. Reordering still belongs to the list view.
 */

import {
  visibleTopLevel, isItemActive,
  isInboxId, isImagesId, isPdfsId, isArchiveId, isTrashId, isAnySpecialId,
} from "../sidebar/files-panel-rows.js";
import { ROW_COLORS } from "../sidebar/files-panel-row-menu.js";

/** Node kinds that hold other nodes. Specials (Inbox / Images / PDFs /
 *  Archive / Trash) are folders as far as either view is concerned. */
export function isContainer(item) {
  if (!item) return false;
  return item.type === "folder" || item.type === "project" || item.type === "desk"
    || isAnySpecialId(item.id);
}

/** Leaf nodes that open onto a surface. Images open a preview instead,
 *  and count as leaves too. */
export function isOpenable(item) {
  return !!item && (item.type === "document" || item.type === "notebook"
    || item.type === "pdf" || item.type === "stack" || item.type === "image");
}

/** A short kind key the views draw from — one glyph / block shape each. */
export function kindOf(item) {
  if (!item) return "document";
  if (isInboxId(item.id)) return "inbox";
  if (isImagesId(item.id)) return "images";
  if (isPdfsId(item.id)) return "pdfs";
  if (isArchiveId(item.id)) return "archive";
  if (isTrashId(item.id)) return "trash";
  if (item.type === "folder" && item.pdfFolder) return "pdfs";
  if (item.type === "notebook" && item.gutter) return "gutter";
  return item.type || "document";
}

/** The active desk's top level, as the views see it. Mirrors the list
 *  panel's own filter (`visibleTopLevel`) so the two never disagree
 *  about what belongs to this desk — including the "all desks" mode,
 *  where every desk surfaces as a top-level container. */
export function rootNodes(state) {
  try {
    return visibleTopLevel(state) || [];
  } catch {
    return [];
  }
}

/** Children of a container, with the noise the list panel also drops:
 *  an empty Images / PDFs folder earns no icon of its own. */
export function childrenOf(item) {
  const kids = (item && item.children) || [];
  return kids.filter((n) =>
    (!isImagesId(n.id) || (n.children && n.children.length > 0)) &&
    (!isPdfsId(n.id) || (n.children && n.children.length > 0)));
}

/** Total leaf count under a node — the number the desktop view shows on
 *  a closed folder, and the fallback weight the drone view lays out by. */
export function leafCount(item) {
  if (!isContainer(item)) return 1;
  let n = 0;
  for (const kid of childrenOf(item)) n += leafCount(kid);
  return n;
}

/** Bytes-ish for one leaf. Only documents carry their content in the
 *  boot library index (`FileSummary.content` is null for everything
 *  else — see README-TECHNICAL, "Startup"), so a notebook or PDF has no
 *  size to read here and falls back to a constant. Never call
 *  `list_files` from a view to improve on that: it's a hot path. */
export function leafSize(state, item) {
  if (!item || !item.fileId) return 0;
  const entry = (state.files || []).find((f) => f.id === item.fileId);
  if (entry && typeof entry.content === "string") return entry.content.length;
  return 2048;
}

/** Epoch ms of a leaf's last edit, or 0 when unknown. */
export function leafModified(state, item) {
  if (!item || !item.fileId) return 0;
  const entry = (state.files || []).find((f) => f.id === item.fileId);
  const m = entry?.modified || 0;
  // `FileSummary.modified` is seconds since the epoch on the Rust side.
  return m > 1e12 ? m : m * 1000;
}

/** A node's sidebar colour tint as a solid swatch, or null. Read from
 *  the same `ROW_COLORS` table the row menu paints from, so a desk
 *  colour-coded in the list arrives colour-coded on the canvas. */
export function tintOf(item) {
  if (!item || !item.bgColor) return null;
  return ROW_COLORS.find((c) => c.key === item.bgColor)?.swatch || null;
}

export { isItemActive };

/** Open a node onto its surface, exactly as a files-panel row click
 *  would. `hidePanel` follows the panel's own rule: an overlay-mode
 *  sidebar steps out of the way once something is open, an inset one
 *  stays. */
export function openNode(state, item, hidePanel) {
  if (!item) return;
  const dismiss = () => {
    const inset = document.getElementById("panel-overlay")?.classList.contains("panel-inset");
    if (!inset && hidePanel) hidePanel();
  };
  if (item.type === "image" && item.fileId) {
    import("../editor/image-preview.js")
      .then(({ openImagePreviewModal }) => openImagePreviewModal(item.fileId, item.name))
      .catch(() => {});
    return;
  }
  if (item.type === "project") { state.openProject(item.id); dismiss(); return; }
  if (!item.fileId) return;
  if (item.type === "notebook") state.openNotebook(item.fileId);
  else if (item.type === "pdf") state.openPdf(item.fileId);
  else if (item.type === "stack") state.openStack(item.fileId);
  else state.openFile(item.fileId);
  dismiss();
}
