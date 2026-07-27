/**
 * Recent Files panel — sidebar block above the footer that lists the 50
 * most-recently-opened files **in the active desk**. Toggled via
 * Settings > General > Show Recent Files (or the command palette
 * Show/Hide entries). The panel's height is user-resizable by dragging
 * its top border.
 *
 * The list is desk-scoped on both ends: rows come from the active desk's
 * own MRU (`settings.recentFileIdsByDesk`, see state/recent-files.js) and
 * each id is resolved against that desk's subtree, so a file that has
 * since moved to another desk drops out rather than opening across the
 * switcher.
 *
 * Each row shows the file's type icon + name. Hover surfaces two minimal
 * icons: remove (drops the file from the desk's MRU) and flag (toggles
 * the tree node's `flagged` state). No dropdown menu.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";
import { getDeskRecentFileIds, setDeskRecentFileIds } from "../state/recent-files.js";
import { typeIcons } from "./files-panel-shared.js";

const MIN_HEIGHT = 60;
const MAX_HEIGHT_FRAC = 0.7;

/** Build the panel DOM and attach listeners. Caller mounts the returned
 *  element above the panel-overlay-footer when `state.settings.showRecentFiles`
 *  is true. */
export function createRecentFilesPanel(state) {
  const panel = document.createElement("div");
  panel.className = "recent-files-panel";

  const resizer = document.createElement("div");
  resizer.className = "recent-files-resizer";

  const header = document.createElement("div");
  header.className = "recent-files-header";
  header.textContent = "Recent";

  const list = document.createElement("div");
  list.className = "recent-files-list";

  panel.appendChild(resizer);
  panel.appendChild(header);
  panel.appendChild(list);

  function applyHeight(h) {
    panel.style.height = `${h}px`;
  }
  applyHeight(state.settings.recentFilesPanelHeight || 150);

  // Top-edge drag-to-resize. Mirrors the sidebar grip's pattern: capture
  // pointer, disable transitions, write through to settings on release.
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const max = window.innerHeight * MAX_HEIGHT_FRAC;
    const onMove = (me) => {
      const next = Math.max(MIN_HEIGHT, Math.min(max, startH - (me.clientY - startY)));
      applyHeight(next);
    };
    const onUp = () => {
      resizer.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      state.updateSettings({ recentFilesPanelHeight: panel.offsetHeight })
        .catch((err) => console.warn("Save recent panel height failed:", err));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  function render() {
    list.innerHTML = "";
    const deskId = state.getActiveDesk?.()?.id || null;
    // Resolve against the active desk's subtree only — an id that has
    // wandered to another desk (or been deleted) simply drops out.
    const scope = activeDeskChildren(state, deskId);
    const ids = getDeskRecentFileIds(state, deskId);
    let rendered = 0;
    for (const fileId of ids) {
      if (rendered >= 50) break;
      const node = findNodeByFileId(scope, fileId);
      if (!node) continue;
      list.appendChild(buildRow(state, node, fileId, deskId, render));
      rendered++;
    }
    if (rendered === 0) {
      const empty = document.createElement("div");
      empty.className = "recent-files-empty";
      empty.textContent = "No recent files yet.";
      list.appendChild(empty);
    }
  }

  // Repaint on file opens (MRU shifts), settings changes (flagged flips,
  // remove from list), tree edits (renames, deletes), and desk switches
  // (the whole list is desk-scoped, so it swaps wholesale).
  const onChange = () => render();
  state.on("settings-changed", onChange);
  state.on("files-changed", onChange);
  state.on("file-opened", onChange);
  state.on("notebook-open", onChange);
  state.on("active-desk-changed", onChange);
  state.on("desks-changed", onChange);

  panel._destroy = () => {
    state.off("settings-changed", onChange);
    state.off("files-changed", onChange);
    state.off("file-opened", onChange);
    state.off("notebook-open", onChange);
    state.off("active-desk-changed", onChange);
    state.off("desks-changed", onChange);
  };

  render();
  return panel;
}

/** The active desk's children, or the whole tree on a (transient)
 *  desk-less boot so the panel never blanks out mid-migration. */
function activeDeskChildren(state, deskId) {
  const tree = state.fileTree || [];
  if (!deskId) return tree;
  const desk = tree.find((n) => n.type === "desk" && n.id === deskId);
  return desk ? (desk.children || []) : [];
}

function buildRow(state, node, fileId, deskId, refresh) {
  const row = document.createElement("div");
  row.className = "recent-files-row";
  if (node.flagged) row.classList.add("flagged");

  const iconWrap = document.createElement("span");
  iconWrap.className = "recent-files-icon";
  const iconKey = pickIconKey(node);
  iconWrap.innerHTML = typeIcons[iconKey] || typeIcons.document;
  row.appendChild(iconWrap);

  const label = document.createElement("span");
  label.className = "recent-files-label";
  label.textContent = node.name || "Untitled";
  row.appendChild(label);

  const actions = document.createElement("span");
  actions.className = "recent-files-actions";

  const flagBtn = document.createElement("button");
  flagBtn.type = "button";
  flagBtn.className = "recent-files-action recent-files-flag";
  flagBtn.title = node.flagged ? "Unflag" : "Flag";
  flagBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 13V2.5l5 1.5 5-1.5V11l-5 1.5L3 11z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>';
  flagBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFlag(state, node.id);
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "recent-files-action recent-files-remove";
  removeBtn.title = "Remove from recent";
  removeBtn.innerHTML = '<svg viewBox="0 0 16 16"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeFromRecent(state, deskId, fileId);
  });

  actions.appendChild(flagBtn);
  actions.appendChild(removeBtn);
  row.appendChild(actions);

  row.addEventListener("click", () => {
    state.openFile(fileId);
  });

  return row;
}

function pickIconKey(node) {
  const flagged = !!node.flagged;
  if (node.type === "notebook") return flagged ? "notebookFlagged" : "notebook";
  if (node.type === "pdf") return flagged ? "pdfFlagged" : "pdf";
  if (node.type === "stack") return "document"; // stacks reuse doc icon in MRU
  if (node.type === "project") return flagged ? "projectFlagged" : "project";
  return flagged ? "documentFlagged" : "document";
}

function removeFromRecent(state, deskId, fileId) {
  const cur = getDeskRecentFileIds(state, deskId);
  setDeskRecentFileIds(state, deskId, cur.filter((id) => id !== fileId))
    .catch((e) => console.warn("Remove from recent failed:", e));
}

function toggleFlag(state, nodeId) {
  // Reuse the tree-edit path so flagged ripples through Flagged section,
  // sync, etc.
  if (typeof state.toggleFlagged === "function") return state.toggleFlagged(nodeId);
}
