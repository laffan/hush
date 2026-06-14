/**
 * Gutter command flows — pairing a gutter notebook to a *document*.
 *
 * A gutter belongs to a single doc (viewing that doc shows doc + gutter; the
 * project's combined view shows none). The doc + its gutter are packaged
 * inside a project so they travel together as a .hushproject, and the gutter
 * notebook is named `<docName>-gutter` (shown as just "gutter" beneath its doc)
 * so two docs' gutters never collide and the pairing is derivable from names.
 *
 *   addGutter(state)         — package the doc into a project (with a warning
 *                              if it's standalone), then pair it with a fresh
 *                              `<docName>-gutter` notebook and dock it.
 *   addNotebookAsGutter(...) — same, but seeds the gutter from a chosen
 *                              notebook's content.
 *   openGutter / closeGutter — re-open / close the current doc's gutter pane;
 *                              the pairing persists across close.
 */

import { panes, DEFAULT_WIDTH as PANE_DEFAULT_WIDTH, TITLEBAR_HEIGHT as PANE_TITLEBAR_HEIGHT } from "../pane/pane-state.js";
import { createPane, getInitialPanePosition, closePane } from "../pane/pane-manager.js";
import { findNode, findNodeByFileId, nearestAncestorProjectId } from "../state/tree-helpers.js";
import { useActivePaneAsGutter } from "./gutter.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Awaited confirmation modal. `window.confirm` doesn't reliably block in the
 *  Tauri webview (it can return truthy immediately while the dialog shows
 *  async), which let the doc→project conversion + gutter creation run *before*
 *  the user actually confirmed. Self-contained (reuses the shared modal CSS)
 *  and resolves ONLY on an explicit button press — no backdrop-auto-cancel, so
 *  the click/keypress that launched the command can't dismiss it. */
function confirmModal(message, confirmLabel = "Continue") {
  return new Promise((resolve) => {
    document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
    const backdrop = document.createElement("div");
    backdrop.className = "tree-delete-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "tree-delete-modal";
    modal.innerHTML = `
      <div class="tree-delete-modal-title">Add Gutter</div>
      <pre class="tree-delete-modal-message"></pre>
      <div class="tree-delete-modal-btns">
        <button class="tree-delete-cancel">Cancel</button>
        <button class="tree-delete-confirm"></button>
      </div>`;
    modal.querySelector(".tree-delete-modal-message").textContent = message;
    modal.querySelector(".tree-delete-confirm").textContent = confirmLabel;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    let done = false;
    const finish = (v) => { if (done) return; done = true; backdrop.remove(); resolve(v); };
    modal.querySelector(".tree-delete-cancel").addEventListener("click", () => finish(false));
    modal.querySelector(".tree-delete-confirm").addEventListener("click", () => finish(true));
  });
}

/** The pane context for a gutter — the document currently in the editor. */
export function currentGutterContext(state) {
  if (state.currentFileId) return "doc:" + state.currentFileId;
  return "";
}

/** The notebook paired as the current document's gutter, or null. A gutter
 *  belongs to a single doc (not the project). Reads the in-memory
 *  `state.gutterAssignments` map first (survives `get_file_tree` reloads),
 *  then falls back to the naming convention — a sibling notebook named
 *  `<docName>-gutter` inside the doc's project — which is how the pairing is
 *  recovered after a restart / on a fresh device. */
export function assignedGutterNotebook(state) {
  const docFileId = state.currentFileId;
  if (!docFileId) return null;
  const docNode = findNodeByFileId(state.fileTree, docFileId);
  if (!docNode || docNode.type !== "document") return null;
  const map = state.gutterAssignments || (state.gutterAssignments = {});
  const nbId = map[docFileId];
  if (nbId) {
    const nb = findNodeByFileId(state.fileTree, nbId);
    if (nb && nb.type === "notebook") return nb;
    delete map[docFileId];
  }
  const projId = nearestAncestorProjectId(state.fileTree, docNode.id);
  if (!projId) return null;
  const proj = findNode(state.fileTree, projId);
  const want = `${docNode.name}-gutter`;
  const nb = (proj?.children || []).find((c) => c.type === "notebook" && c.name === want);
  if (nb) { map[docFileId] = nb.fileId; return nb; }
  return null;
}

/** The live (on-screen) gutter pane for the current doc, or null. */
export function liveGutterPane(state) {
  const ctx = currentGutterContext(state);
  if (!ctx) return null;
  for (const [, p] of panes) {
    if (p.gutter && p.ownerContext === ctx) return p;
  }
  return null;
}

/** Hide "Add Gutter" / "Add notebook as gutter" unless a single document is in
 *  the editor that doesn't already have a gutter. (The combined project view —
 *  no `currentFileId` — and notebook / stack / pdf surfaces can't add one.) */
export function gutterAddHidden(state) {
  if (state.currentNotebookFileId || state.currentStackFileId || state.currentPdfFileId) return true;
  if (!state.currentFileId) return true;
  return !!assignedGutterNotebook(state);
}

/** "Open Gutter" shows only when the doc has a gutter that isn't on screen. */
export function gutterOpenHidden(state) {
  return !assignedGutterNotebook(state) || !!liveGutterPane(state);
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

/** Spawn a notebook pane for the current doc and promote it to a gutter.
 *  `useActivePaneAsGutter` keys off `activePaneId`, which `createPane`'s
 *  focusPane() sets — a microtask wait lets focus settle first. */
export async function promoteNotebookPaneAsGutter(state, fileId, name) {
  const { x, y } = anchorPoint(state);
  await createPane(fileId, name, "notebook", x, y);
  await Promise.resolve();
  useActivePaneAsGutter();
}

/** Make sure the current document lives inside a real project (so a doc +
 *  gutter package together), then land the editor on that doc. Converts a
 *  standalone doc with a confirm. Returns `{ projectId, docFileId, docName }`
 *  for the doc to pair, or null if cancelled / not a doc. */
async function ensureDocInProject(state, convertMessage) {
  const docFileId = state.currentFileId;
  if (!docFileId) return null;
  const docNode = findNodeByFileId(state.fileTree, docFileId);
  if (!docNode || docNode.type !== "document") return null;
  const existing = nearestAncestorProjectId(state.fileTree, docNode.id);
  if (existing) return { projectId: existing, docFileId, docName: docNode.name };
  // Standalone doc — package it into a project, then open the child doc so the
  // gutter binds to the doc context (not the project's combined view).
  if (!(await confirmModal(convertMessage))) return null;
  await state.convertDocToProject(docNode.id);
  const projId = state.currentProjectId;
  if (!projId) return null;
  const proj = findNode(state.fileTree, projId);
  const childDoc = (proj?.children || []).find((c) => c.type === "document" && !c.useAsNote);
  if (!childDoc) return null;
  await state.openFile(childDoc.fileId);
  return { projectId: projId, docFileId: childDoc.fileId, docName: childDoc.name };
}

async function loadNotebookContent(state, fileId) {
  if (IS_TAURI) {
    try { return (await tauriInvoke("load_file", { id: fileId })).content || ""; }
    catch (e) { console.warn("Load notebook for gutter copy failed:", e); return ""; }
  }
  const f = state.files.find((f) => f.id === fileId);
  return f?.content || "";
}

/** "Add Gutter" — package the current doc into a project (if needed) and pair
 *  it with a fresh, empty gutter notebook named `<docName>-gutter`. */
export async function addGutter(state) {
  if (assignedGutterNotebook(state)) return;
  const info = await ensureDocInProject(
    state,
    "Adding a gutter packages this document into a Project. Continue?",
  );
  if (!info) return;
  const created = await state.createNotebook(`${info.docName}-gutter`, info.projectId, { openImmediately: false });
  if (!created) return;
  await state.markGutterForDoc(info.docFileId, created.fileId);
  await promoteNotebookPaneAsGutter(state, created.fileId, created.name);
}

/** "Add notebook as gutter" — package the current doc into a project (if
 *  needed) and pair it with a copy of an existing notebook. */
export async function addNotebookAsGutter(state, fileLeaf) {
  if (assignedGutterNotebook(state)) return;
  if (!(await confirmModal("This copies the selected notebook in as this document's gutter. Continue?"))) return;
  const info = await ensureDocInProject(state, "Adding a gutter packages this document into a Project. Continue?");
  if (!info) return;
  const content = await loadNotebookContent(state, fileLeaf.fileId);
  const created = await state.createNotebook(`${info.docName}-gutter`, info.projectId, { openImmediately: false, initialContent: content });
  if (!created) return;
  await state.markGutterForDoc(info.docFileId, created.fileId);
  await promoteNotebookPaneAsGutter(state, created.fileId, created.name);
}

/** "Open Gutter" — re-open the current doc's assigned gutter notebook as a
 *  docked gutter pane (the pairing persists across close). */
export async function openGutter(state) {
  const nb = assignedGutterNotebook(state);
  if (!nb || liveGutterPane(state)) return;
  await promoteNotebookPaneAsGutter(state, nb.fileId, nb.name);
}

/** "Close Gutter" — close the gutter pane but keep the assignment, so it can
 *  be re-opened later. */
export function closeGutter(state) {
  const pane = liveGutterPane(state);
  if (pane) closePane(pane.id);
}
