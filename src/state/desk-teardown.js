/**
 * Closing the surfaces a desk owned, when that desk leaves the app.
 *
 * Removing a desk from the tree and the registry doesn't touch what's on
 * screen. Archiving the desk you were working in used to leave its
 * document open in the editor — and its floating panes hanging around —
 * while the sidebar had already moved on to a different desk, so the
 * window showed two desks at once and only one of them still existed.
 *
 * `tearDownDeskSurfaces` closes everything that belonged to the departing
 * desk and reports whether the active surface was one of them, so the
 * caller knows it has to land the editor somewhere.
 *
 * Deliberately narrow: it closes *views*, never data. A pane whose file
 * lives in another desk is left alone, and so is a Desktop showing a
 * project that isn't going anywhere.
 */

import { logActivity } from "../activity-log.js";

/** Every fileId reachable under a desk node. */
export function collectDeskFileIds(deskNode) {
  const ids = new Set();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n?.fileId) ids.add(n.fileId);
      walk(n.children);
    }
  };
  walk(deskNode?.children);
  return ids;
}

/** Every tree-node id under a desk node (containers included) — what the
 *  takeover views are keyed by. */
function collectDeskNodeIds(deskNode) {
  const ids = new Set();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n?.id) ids.add(n.id);
      walk(n.children);
    }
  };
  walk(deskNode?.children);
  return ids;
}

/**
 * Close the panes and takeover views backed by `deskNode`, and report
 * whether the editor's own surface belonged to it.
 *
 * Returns `{ ownedActiveSurface }`. It doesn't clear the active surface
 * itself: the caller is about to switch desks, and letting the desk
 * switch do the opening keeps one path responsible for what the editor
 * shows next (`openLastFileForDesk`, which falls through to the empty
 * "no file selected" pane when the incoming desk has nothing).
 */
export async function tearDownDeskSurfaces(state, deskNode) {
  if (!deskNode) return { ownedActiveSurface: false };
  const fileIds = collectDeskFileIds(deskNode);
  const nodeIds = collectDeskNodeIds(deskNode);

  const ownedActiveSurface =
    (state.currentFileId && fileIds.has(state.currentFileId))
    || (state.currentNotebookFileId && fileIds.has(state.currentNotebookFileId))
    || (state.currentPdfFileId && fileIds.has(state.currentPdfFileId))
    || (state.currentStackFileId && fileIds.has(state.currentStackFileId))
    || (state.currentProjectId && nodeIds.has(state.currentProjectId));

  // Stop the autosave loop chasing a file whose desk is leaving. The
  // 2 s tick, and `openFile`'s own "flush before switching" step, would
  // both write into a desk folder that no longer exists — `locate` fails
  // and the content lands in the staging area as a stray file. The
  // caller flushes real edits *before* the desk goes; by here there's
  // nothing left to save.
  if (ownedActiveSurface) state.dirty = false;

  // Floating panes. A pane outlives the sidebar row that spawned it, so
  // nothing else would ever close these.
  let closedPanes = 0;
  try {
    const [{ panes }, { closePane }] = await Promise.all([
      import("../pane/pane-state.js"),
      import("../pane/pane-manager.js"),
    ]);
    const victims = [];
    for (const [id, p] of panes) {
      if (p?.fileId && fileIds.has(p.fileId)) victims.push(id);
    }
    for (const id of victims) closePane(id);
    closedPanes = victims.length;
  } catch (_) { /* panes unavailable in this window */ }

  // Takeover views, but only when they're showing something from this
  // desk — a Desktop open on another desk's project is still valid.
  try {
    const m = await import("../desktop/desktop-view.js");
    if (m.isDesktopOpen() && nodeIds.has(m.currentDesktopContainerId())) m.closeDesktop();
  } catch (_) { /* desktop view not loaded */ }
  try {
    const m = await import("../pdf/pdf-shelf.js");
    if (typeof m.currentShelfContainerId === "function" && nodeIds.has(m.currentShelfContainerId())) {
      m.closePdfShelf();
    }
  } catch (_) { /* shelf not loaded */ }

  logActivity("desks", "info", `Closed surfaces belonging to "${deskNode.name}"`, {
    deskId: deskNode.id,
    files: fileIds.size,
    closedPanes,
    ownedActiveSurface: !!ownedActiveSurface,
  });
  return { ownedActiveSurface: !!ownedActiveSurface };
}
