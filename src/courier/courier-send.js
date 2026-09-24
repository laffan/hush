/**
 * Courier's delivery half — what "Send" does for each message type.
 *
 * Every path resolves to a short human label for the confirmation toast,
 * or throws; the sheet stays open on a throw so the message isn't lost.
 *
 * Appending to a document goes to whichever copy of it is live, in this
 * order: the main editor, then a floating pane / stack column holding
 * it, then the file on disk. Writing the disk copy of a document an
 * editor is holding would be undone by that editor's next autosave, so
 * the disk is only ever the last resort — the same "a surface that holds
 * the file owns the file" rule the panes follow (README-TECHNICAL).
 */

import { findNodeByFileId } from "../state/tree-helpers.js";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** The separator that puts `text` in a paragraph of its own after
 *  `existing` — same rule as "Send Selected" (selection-extract.js). */
function separatorAfter(existing) {
  if (!existing) return "";
  if (existing.endsWith("\n\n")) return "";
  return existing.endsWith("\n") ? "\n" : "\n\n";
}

function appendToView(view, text) {
  const doc = view.state.doc;
  const insert = separatorAfter(doc.toString()) + text;
  view.dispatch({ changes: { from: doc.length, insert }, scrollIntoView: false });
}

async function livePaneViewFor(fileId) {
  const { panes } = await import("../pane/pane-state.js");
  for (const [, pane] of panes) {
    if (pane?.fileId !== fileId || pane.fileType !== "document" || pane.localSync) continue;
    const view = pane.editor?.view;
    if (view) return view;
  }
  return null;
}

async function appendOnDisk(state, fileId, text) {
  if (!IS_TAURI) throw new Error("No file store in this build");
  const file = await tauriInvoke("load_file", { id: fileId });
  const existing = file?.content || "";
  const merged = existing + separatorAfter(existing) + text;
  await tauriInvoke("save_file", { id: fileId, content: merged });
  // Keep the library cache honest for the few readers of `content`
  // (sidebar tab / heading rows) without re-listing the library.
  const entry = state.files?.find((f) => f.id === fileId);
  if (entry && typeof entry.content === "string") entry.content = merged;
}

export async function appendToDocument(state, fileId, text) {
  const mainView = state.editor?.view;
  if (mainView && state.currentFileId === fileId && !state.currentProjectId
      && !state.currentNotebookFileId && !state.currentPdfFileId && !state.currentStackFileId) {
    appendToView(mainView, text);
    return;
  }
  // A project concatenates its documents into one buffer; flush it, write
  // the part on disk, and reload the buffer so it picks the addition up.
  if (state.currentProjectId && (state.projectDocIds || []).includes(fileId)) {
    await state.saveProjectContent();
    await appendOnDisk(state, fileId, text);
    await state.openProject(state.currentProjectId);
    return;
  }
  const paneView = await livePaneViewFor(fileId);
  if (paneView) { appendToView(paneView, text); return; }
  await appendOnDisk(state, fileId, text);
}

/** The document's current text, from whichever copy is live — the same
 *  order `appendToDocument` writes in, so the preview shows the text the
 *  new paragraph will actually land after. */
export async function readDocumentText(state, fileId) {
  const mainView = state.editor?.view;
  if (mainView && state.currentFileId === fileId && !state.currentProjectId
      && !state.currentNotebookFileId && !state.currentPdfFileId && !state.currentStackFileId) {
    return mainView.state.doc.toString();
  }
  const paneView = await livePaneViewFor(fileId);
  if (paneView) return paneView.state.doc.toString();
  if (IS_TAURI) {
    const file = await tauriInvoke("load_file", { id: fileId });
    return file?.content || "";
  }
  return state.files?.find((f) => f.id === fileId)?.content || "";
}

/**
 * Deliver `text`. `mode` is "sticky" or "append"; `scope` is the
 * sticky's document / desk / global; `location` is the chosen row (none
 * for a global sticky). Returns the label for the confirmation toast.
 */
export async function deliver(state, { mode, scope, location }, text) {
  if (mode === "append") {
    if (!location?.fileId) throw new Error("Choose a document");
    await appendToDocument(state, location.fileId, text);
    const node = findNodeByFileId(state.fileTree, location.fileId);
    return `Appended to ${node?.name || location.label}`;
  }
  const { addSticky } = await import("../sticky/sticky-notes.js");
  if (scope === "global") {
    addSticky(state, "global", { text, focus: false });
    return "Global sticky added";
  }
  if (scope === "desk") {
    if (!location?.deskId) throw new Error("Choose a desk");
    addSticky(state, "desk", { target: location.deskId, text, focus: false });
    return `Sticky added to ${location.label}`;
  }
  if (!location?.fileId) throw new Error("Choose a document");
  addSticky(state, "file", { target: `doc:${location.fileId}`, text, focus: false });
  return `Sticky added to ${location.label}`;
}
