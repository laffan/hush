/**
 * Picker-mode helpers for the command palette. Each one swaps the
 * palette's command list with a different set (files, notebooks, …) so
 * the palette can act as a fuzzy file picker for follow-up flows
 * without spawning a separate modal.
 *
 * Extracted from `command-palette.js` so that file stays under the
 * 700-line cap. The pickers are pure: every call takes the palette
 * handle (`{ setItems(items, placeholder) }`) plus the app state, and
 * does not touch any module-local state of `command-palette.js`.
 */
import {
  contextIdForFile, copyPanesBetweenContexts, getActivePaneId,
  clearPanesForContext, getInitialPanePosition,
} from "./pane/pane-manager.js";
import { panes } from "./pane/pane-state.js";
import { setPanesHiddenForContext } from "./state/state-panes.js";
import { paneIndicatorsFor } from "./sidebar/files-panel-pane-indicators.js";
import { DEFAULT_WIDTH as PANE_DEFAULT_WIDTH, TITLEBAR_HEIGHT as PANE_TITLEBAR_HEIGHT } from "./pane/pane-state.js";
import { sendSelectedToFile } from "./selection-extract.js";
import { addNotebookAsGutter } from "./project/gutter-commands.js";
import { typeIcons } from "./sidebar/files-panel-shared.js";
import { collectFileLeaves, activeDeskSubtree } from "./command-palette-helpers.js";
import { getDeskRecentFileIds } from "./state/recent-files.js";
import deskRaw from "./sidebar/sidebar_icons/desk.svg?raw";

/** Pane lands centred on its (x,y) anchor — pre-shift by half the
 *  default pane size so the click-point coordinate (returned by
 *  `getInitialPanePosition`) lines up with the pane's top-left. */
export function paneAnchorClickPoint(state) {
  const pos = getInitialPanePosition(state);
  return { x: pos.x + PANE_DEFAULT_WIDTH / 2, y: pos.y + PANE_TITLEBAR_HEIGHT / 2 };
}

/** Mirror of pane-manager's getCurrentContext — used by the pane-copy
 *  picker. Returns "" when nothing is open. */
function activeContextIdFor(s) {
  if (s.currentNotebookFileId) return "nb:" + s.currentNotebookFileId;
  if (s.currentProjectId) return "pj:" + s.currentProjectId;
  if (s.currentFileId) return "doc:" + s.currentFileId;
  return "";
}

/** Ask the user for a name before spawning a notebook. Shared between
 *  every "new notebook" entry point. Lazy-imports the modal helper so
 *  the bundle splits cleanly. */
export function promptNewNotebookName(onConfirm) {
  import("./sidebar/files-panel-shared.js").then(({ showPromptModal }) => {
    showPromptModal({
      title: "New notebook",
      label: "Name",
      placeholder: "New Notebook",
      initialValue: "New Notebook",
      confirmLabel: "Create",
      onConfirm,
    });
  });
}

export function promptNewStackName(onConfirm) {
  import("./sidebar/files-panel-shared.js").then(({ showPromptModal }) => {
    showPromptModal({
      title: "New stack",
      label: "Name",
      placeholder: "New Stack",
      initialValue: "New Stack",
      confirmLabel: "Create",
      onConfirm,
    });
  });
}

export function enterNotebookGutterPicker(palette, state) {
  const leaves = collectFileLeaves(activeDeskSubtree(state))
    .filter((f) => f.type === "notebook");
  const items = leaves.map((f) => ({
    id: "gutter-notebook-" + f.id,
    label: f.name,
    icon: typeIcons.notebook,
    shortcutKey: null,
    // Copies the chosen notebook into the project as its gutter (converting
    // a bare doc into a project first, with a warning).
    action: () => addNotebookAsGutter(state, f),
  }));
  palette.setItems(items, "Add notebook as gutter…");
}

/** Copy or switch the current document's panes into another doc/notebook.
 *  `switchAfter` is true for *Switch panes to Document* — clears the
 *  source after copying and opens the target so the panes ride along. */
export function enterPaneCopyPicker(palette, state, switchAfter) {
  const currentFileId = state.currentNotebookFileId || state.currentFileId;
  const items = collectFileLeaves(activeDeskSubtree(state))
    .filter((f) => (f.type === "document" || f.type === "notebook") && f.fileId !== currentFileId)
    .map((f) => ({
      id: "pane-copy-target-" + f.id,
      label: f.name,
      icon: f.type === "notebook" ? typeIcons.notebook : typeIcons.document,
      shortcutKey: null,
      action: async () => {
        const sourceCtx = activeContextIdFor(state);
        const targetCtx = contextIdForFile(f.fileId, f.type);
        if (!sourceCtx || !targetCtx || sourceCtx === targetCtx) return;
        if (switchAfter) await setPanesHiddenForContext(state, targetCtx, false);
        await copyPanesBetweenContexts(sourceCtx, targetCtx);
        if (switchAfter) {
          clearPanesForContext(sourceCtx);
          if (f.type === "notebook") state.openNotebook(f.fileId);
          else state.openFile(f.fileId);
        }
      },
    }));
  palette.setItems(items, switchAfter ? "Switch panes to…" : "Copy panes to…");
}

/** Open a file picker filtered to documents (in doc mode) or notebooks
 *  (in notebook mode), excluding the currently-open file, and append the
 *  current selection to whichever the user picks. */
export function enterSendSelectedPicker(palette, state) {
  const inNotebook = !!state.currentNotebookFileId;
  const wantedType = inNotebook ? "notebook" : "document";
  const currentId = inNotebook ? state.currentNotebookFileId : state.currentFileId;
  const leaves = collectFileLeaves(activeDeskSubtree(state))
    .filter((f) => f.type === wantedType && f.fileId !== currentId);
  const items = leaves.map((f) => ({
    id: "send-target-" + f.id,
    label: f.name,
    icon: f.type === "notebook" ? typeIcons.notebook : typeIcons.document,
    shortcutKey: null,
    action: () => sendSelectedToFile(state, f),
  }));
  const placeholder = inNotebook ? "Send selection to notebook…" : "Send selection to document…";
  palette.setItems(items, placeholder);
}

/** Replace the palette's command list with one row per desk so the
 *  "Switch Desks" flow runs inside the command palette — same look and
 *  arrow-key / return navigation as the file picker. The active desk is
 *  marked "current" and picking it is a no-op. */
export function enterDeskPicker(palette, state) {
  const desks = state.settings?.desks || [];
  const activeId = state.settings?.activeDeskId;
  const items = desks.map((d) => ({
    id: "desk-pick-" + d.id,
    label: (d.name || "Untitled desk") + (d.id === activeId ? "  (current)" : ""),
    icon: deskRaw,
    shortcutKey: null,
    action: async () => {
      if (d.id === activeId || typeof state.setActiveDesk !== "function") return;
      try { await state.setActiveDesk(d.id); } catch (e) { console.error("setActiveDesk failed:", e); }
    },
  }));
  palette.setItems(items, "Switch to desk…");
}

/** Replace the palette's command list with file rows that pipe back into
 *  `onPick(fileLeaf)` on selection. Used by both "Open…" commands.
 *  `includeProjects` is opt-in because the floating-pane path doesn't
 *  support project types — only the main editor can host the joined view. */
export function enterFilePicker(palette, state, placeholder, onPick, { includeProjects = false } = {}) {
  let leaves = collectFileLeaves(activeDeskSubtree(state));
  if (!includeProjects) leaves = leaves.filter((f) => f.type !== "project");
  // Sort MRU-first; files not in the MRU keep their tree order behind it.
  // The MRU is per-desk, matching the desk-scoped leaf list above.
  const recents = getDeskRecentFileIds(state, state.getActiveDesk?.()?.id || null);
  const rank = new Map(recents.map((id, i) => [id, i]));
  leaves = leaves.slice().sort((a, b) => (rank.get(a.fileId) ?? Infinity) - (rank.get(b.fileId) ?? Infinity));
  const items = leaves.map((f) => ({
    id: "file-" + f.id, label: f.name, shortcutKey: null,
    icon: typeIcons[f.type] || typeIcons.document,
    paneIndicators: paneIndicatorsFor({ fileId: f.fileId, type: f.type }, state),
    action: () => onPick(f),
  }));
  palette.setItems(items, placeholder);
}

/** Re-export so command-palette.js can keep using a single import path
 *  for the active-pane helper alongside the pickers it drives. */
export { getActivePaneId };
