/**
 * Desktop file collection — walk a container (a desk or a project) and
 * list every file that should appear on its Desktop.
 *
 * Entry kinds: "doc" | "notebook" | "pdf" | "stack" | "project".
 * Projects surface as a single entry (their Desktop renders as one
 * thumbnail) rather than contributing their children; plain folders are
 * transparent — their contents flatten into the parent Desktop.
 *
 * Skipped on purpose: Trash (deleted), Archive (explicitly parked out
 * of view), the Images special (assets, not files), Local Sync mounts
 * (no fileIds — outside the VC store), and image rows.
 */

import { findNode } from "../state/tree-helpers.js";
import { AppState } from "../state/state.js";

const startsWithId = (id, special) => id === special || String(id || "").startsWith(special + ":");
const isInboxId = (id) => startsWithId(id, AppState.INBOX_ID);
const isImagesId = (id) => startsWithId(id, AppState.IMAGES_ID);
const isPdfsId = (id) => startsWithId(id, AppState.PDFS_ID);
const isArchiveId = (id) => startsWithId(id, AppState.ARCHIVE_ID);
const isTrashId = (id) => startsWithId(id, AppState.TRASH_ID);

/** Order Desktop sections render in — the initial grid groups by kind. */
export const DESKTOP_KIND_ORDER = ["doc", "notebook", "pdf", "project", "stack"];

/** Resolve the container node for a Desktop. Accepts a desk id or a
 *  project node id. Returns null when it no longer exists. */
export function findDesktopContainer(state, containerId) {
  const deskNode = (state.fileTree || []).find((n) => n.type === "desk" && n.id === containerId);
  if (deskNode) return deskNode;
  const node = findNode(state.fileTree, containerId);
  return node && node.type === "project" ? node : null;
}

/** Human label for the Desktop header. */
export function desktopScopeName(state, containerId) {
  const node = findDesktopContainer(state, containerId);
  if (!node) return "Desktop";
  return node.name || (node.type === "desk" ? "Desk" : "Project");
}

/** Collect the Desktop entries for a container node. Each entry:
 *  `{ key, kind, fileId, nodeId, name, hasGutter? }` — `key` is the
 *  thumbnail cache key (fileId for files, node id for projects) and
 *  doubles as the identity the Desktop reconciles shapes against.
 *  Gutter notebooks (`node.gutter`) are attachments of their doc, not
 *  standalone files — excluded unless `opts.includeGutters`; the docs
 *  they pair with are flagged `hasGutter` either way (drives the
 *  "Open with Gutter Visible" hover control). */
export function collectDesktopFiles(state, containerId, opts = {}) {
  const container = findDesktopContainer(state, containerId);
  if (!container) return null;
  const entries = [];
  const seen = new Set();

  // Pre-scan for gutter pairings so doc entries can be flagged even
  // when the gutter notebooks themselves are excluded from the walk.
  const gutteredDocFileIds = new Set();
  const scanGutters = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === "notebook" && node.gutter && node.gutterForDoc) {
        gutteredDocFileIds.add(node.gutterForDoc);
      }
      if (node.children?.length) scanGutters(node.children);
    }
  };
  scanGutters(container.children);

  const push = (kind, node) => {
    const key = kind === "project" ? node.id : node.fileId;
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({
      key, kind, fileId: node.fileId || null, nodeId: node.id,
      name: node.name || "Untitled",
      // The sidebar row's highlight colour (a ROW_COLORS key), carried
      // through so the Desktop can tint the file's thumbnail to match.
      ...(node.bgColor ? { tint: node.bgColor } : {}),
      ...(kind === "doc" && gutteredDocFileIds.has(node.fileId) ? { hasGutter: true } : {}),
    });
  };

  const walk = (nodes) => {
    for (const node of nodes || []) {
      const id = node.id;
      if (isTrashId(id) || isArchiveId(id) || isImagesId(id)) continue;
      if (node.type === "local-sync" || node.syncFolderId) continue;
      switch (node.type) {
        case "document":
          if (node.fileId) push("doc", node);
          break;
        case "notebook":
          if (node.gutter && !opts.includeGutters) break;
          if (node.fileId) push("notebook", node);
          break;
        case "stack":
          if (node.fileId) push("stack", node);
          break;
        case "pdf":
          // Aliases share the original's fileId, so `seen` dedupes them.
          if (node.fileId) push("pdf", node);
          break;
        case "folder":
          walk(node.children);
          break;
        case "project":
          // The specials are typed as projects/folders — Inbox and the
          // PDFs folder are transparent containers, real projects are a
          // single thumbnail of their own Desktop.
          if (isInboxId(id) || isPdfsId(id) || node.pdfFolder) walk(node.children);
          else push("project", node);
          break;
        default:
          break;
      }
    }
  };

  walk(container.children);
  return { container, entries };
}
