/**
 * What the main surface is holding, read off the `current*` pointers —
 * for features that must stand down on the "No file selected" pane.
 *
 * That pane is the main editor with nothing loaded into it (the editor is
 * built once at boot and never torn down), so "is there an editor" and
 * "is there a document" are different questions: Zen Focus asked the
 * first and opened over an empty buffer, the word count read the empty
 * pane as a document.
 */

/** Anything open on the main surface at all — a Doc, a project, a Local
 *  Folder file, a notebook, a PDF or a stack. False on the empty pane. */
export function hasOpenFile(state) {
  return !!(state.currentFileId || state.currentProjectId || state.currentLocalSync
    || state.currentNotebookFileId || state.currentPdfFileId || state.currentStackFileId);
}

/** The main editor is showing a document (a Doc, a project's joined
 *  buffer, or a Local Folder text file) — not a canvas, a PDF, a stack
 *  or the empty pane. */
export function mainEditorHoldsDoc(state) {
  if (state.currentNotebookFileId || state.currentPdfFileId || state.currentStackFileId) return false;
  if (state.currentLocalSync) return !state.currentLocalSync.kind || state.currentLocalSync.kind === "doc";
  return !!(state.currentFileId || state.currentProjectId);
}
