/**
 * Gutter command flows — the .hushproject-owned entry points for pairing a
 * gutter notebook to a document.
 *
 * A gutter notebook can only live inside a project (the project's joined
 * buffer is the doc surface it tracks), so both flows funnel through a
 * project:
 *
 *   addGutter(state)            — "Add Gutter": converts the current bare
 *                                 doc into a project (with a warning), then
 *                                 creates a fresh notebook inside it, marks
 *                                 it as the project's gutter, and promotes it.
 *   addNotebookAsGutter(...)    — "Add notebook as gutter": same, but copies
 *                                 a chosen existing notebook's content into
 *                                 the project as the gutter (with a warning).
 *
 * Keeping the orchestration here (rather than in command-palette-pickers.js)
 * means the project module owns the whole gutter story.
 */

import { panes, DEFAULT_WIDTH as PANE_DEFAULT_WIDTH, TITLEBAR_HEIGHT as PANE_TITLEBAR_HEIGHT } from "../pane/pane-state.js";
import { createPane, getInitialPanePosition, closePane } from "../pane/pane-manager.js";
import { findNode, findNodeByFileId } from "../state/tree-helpers.js";
import { useActivePaneAsGutter } from "./gutter.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Awaited confirmation modal. `window.confirm` doesn't reliably block in the
 *  Tauri webview (it can return truthy immediately while the dialog shows
 *  async), which let the doc→project conversion + gutter creation run *before*
 *  the user actually confirmed. This resolves only once the user chooses. */
function confirmModal(message, confirmLabel = "Continue") {
  return new Promise((resolve) => {
    import("../sidebar/files-panel-shared.js").then(({ showConfirmModal }) => {
      showConfirmModal({
        title: "Add Gutter",
        message,
        confirmLabel,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    }).catch(() => resolve(false));
  });
}

/** Context the current surface would host a gutter in — a project (the
 *  joined buffer) or, transitionally, a bare doc. */
export function currentGutterContext(state) {
  if (state.currentProjectId) return "pj:" + state.currentProjectId;
  if (state.currentFileId) return "doc:" + state.currentFileId;
  return "";
}

/** The notebook child currently assigned as the active project's gutter (the
 *  persistent pairing), or null. The assignment survives closing the gutter
 *  pane — that's what makes "Open Gutter" possible.
 *
 *  Reads the in-memory `state.gutterAssignments` map first (survives
 *  `get_file_tree` reloads within a session), falling back to the persisted
 *  tree-node `gutter` flag (which seeds the map on a fresh session / after a
 *  restart). Stale map entries — pointing at a notebook that's been moved or
 *  deleted — are cleaned up here. */
export function assignedGutterChild(state) {
  if (!state.currentProjectId) return null;
  const node = findNode(state.fileTree, state.currentProjectId);
  if (!node || node.type !== "project") return null;
  const children = node.children || [];
  const map = state.gutterAssignments || (state.gutterAssignments = {});
  const mappedId = map[state.currentProjectId];
  if (mappedId) {
    const child = children.find((c) => c.type === "notebook" && c.fileId === mappedId);
    if (child) return child;
    delete map[state.currentProjectId]; // assigned notebook is gone
  }
  const marked = children.find((c) => c.type === "notebook" && c.gutter && c.fileId);
  if (marked) { map[state.currentProjectId] = marked.fileId; return marked; }
  return null;
}

/** The live (on-screen) gutter pane for the active surface, or null. */
export function liveGutterPane(state) {
  const ctx = currentGutterContext(state);
  if (!ctx) return null;
  for (const [, p] of panes) {
    if (p.gutter && p.ownerContext === ctx) return p;
  }
  return null;
}

/** Hide the "Add Gutter" / "Add notebook as gutter" entries on surfaces that
 *  can't host a gutter (notebook / stack / pdf), or once the active project
 *  already has a gutter assigned (then Open / Close Gutter take over). */
export function gutterAddHidden(state) {
  if (state.currentNotebookFileId || state.currentStackFileId || state.currentPdfFileId) return true;
  if (!state.currentProjectId && !state.currentFileId) return true;
  return !!assignedGutterChild(state);
}

/** "Open Gutter" shows only when a gutter is assigned but not on screen. */
export function gutterOpenHidden(state) {
  return !assignedGutterChild(state) || !!liveGutterPane(state);
}

/** "Close Gutter" shows only when a gutter pane is on screen. */
export function gutterCloseHidden(state) {
  return !liveGutterPane(state);
}

/** Pane lands centred on its (x,y) anchor — pre-shift by half the default
 *  pane size so the click-point coordinate lines up with the top-left. */
function anchorPoint(state) {
  const pos = getInitialPanePosition(state);
  return { x: pos.x + PANE_DEFAULT_WIDTH / 2, y: pos.y + PANE_TITLEBAR_HEIGHT / 2 };
}

/** Spawn a notebook pane in the active project and promote it to a gutter.
 *  `useActivePaneAsGutter` keys off `activePaneId`, which `createPane`'s
 *  focusPane() sets — a microtask wait lets focus settle first. */
export async function promoteNotebookPaneAsGutter(state, fileId, name) {
  const { x, y } = anchorPoint(state);
  await createPane(fileId, name, "notebook", x, y);
  await Promise.resolve();
  useActivePaneAsGutter();
}

/** Ensure we're inside a project. A bare doc is converted in place (with a
 *  confirm); returns the project id, or "" if the user cancelled / no doc. */
async function ensureProjectContext(state, convertMessage) {
  if (state.currentProjectId) return state.currentProjectId;
  if (!state.currentFileId) return "";
  const node = findNodeByFileId(state.fileTree, state.currentFileId);
  if (!node) return "";
  if (!(await confirmModal(convertMessage))) return "";
  await state.convertDocToProject(node.id);
  return state.currentProjectId || "";
}

async function loadNotebookContent(state, fileId) {
  if (IS_TAURI) {
    try { return (await tauriInvoke("load_file", { id: fileId })).content || ""; }
    catch (e) { console.warn("Load notebook for gutter copy failed:", e); return ""; }
  }
  const f = state.files.find((f) => f.id === fileId);
  return f?.content || "";
}

/** "Add Gutter" — convert the current doc to a project (if needed) and pair
 *  it with a fresh, empty gutter notebook. */
export async function addGutter(state) {
  if (assignedGutterChild(state)) return;
  const projectId = await ensureProjectContext(
    state,
    "Adding a gutter will convert this document into a Project. Continue?",
  );
  if (!projectId) return;
  const created = await state.createNotebook("Gutter", projectId, { openImmediately: false });
  if (!created) return;
  // promoteNotebookPaneAsGutter → useActivePaneAsGutter records the project's
  // gutter pairing, so no explicit mark is needed here.
  await promoteNotebookPaneAsGutter(state, created.fileId, created.name);
}

/** "Add notebook as gutter" — convert the current doc to a project (if
 *  needed) and pair it with a copy of an existing notebook. */
export async function addNotebookAsGutter(state, fileLeaf) {
  if (assignedGutterChild(state)) return;
  if (!(await confirmModal("This copies the selected notebook into the Project as its gutter. Continue?"))) return;
  const projectId = state.currentProjectId
    ? state.currentProjectId
    : await ensureProjectContext(state, "Adding a gutter will convert this document into a Project. Continue?");
  if (!projectId) return;
  const content = await loadNotebookContent(state, fileLeaf.fileId);
  const created = await state.createNotebook(fileLeaf.name, projectId, { openImmediately: false, initialContent: content });
  if (!created) return;
  await promoteNotebookPaneAsGutter(state, created.fileId, created.name);
}

/** "Open Gutter" — re-open the project's assigned gutter notebook as a docked
 *  gutter pane (the assignment persists across close, so this just
 *  re-materializes the pane). */
export async function openGutter(state) {
  const child = assignedGutterChild(state);
  if (!child || liveGutterPane(state)) return;
  await promoteNotebookPaneAsGutter(state, child.fileId, child.name);
}

/** "Close Gutter" — close the gutter pane but keep the assignment, so it can
 *  be re-opened later. */
export function closeGutter(state) {
  const pane = liveGutterPane(state);
  if (pane) closePane(pane.id);
}
