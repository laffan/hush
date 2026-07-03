/**
 * Cache key identifying which doc-shaped "document" the main editor
 * buffer is currently showing — used to stash / restore per-file
 * EditorStates (undo history, selection, folds) across switches via
 * `editor.stashDocState` / `editor.loadDocState`.
 *
 * Returns null when the buffer isn't doc-shaped (empty pane) or when a
 * non-editor surface (notebook / stack / PDF) owns the view — note the
 * non-editor surfaces intentionally leave the previous doc's buffer in
 * the hidden editor, so their open paths stash with the key computed
 * *before* they null the doc pointers.
 */
export function editorCacheKey(state) {
  if (state.currentProjectId) return `project:${state.currentProjectId}`;
  const ls = state.currentLocalSync;
  if (ls && ls.kind === "doc" && ls.folderId && ls.relPath) {
    return `localsync:${ls.folderId}:${ls.relPath}`;
  }
  if (state.currentFileId) return `doc:${state.currentFileId}`;
  return null;
}

/** Stash the live editor state under the key of whatever the buffer is
 *  currently showing. Call before mutating the current-file pointers. */
export function stashActiveEditorState(state) {
  if (!state.editor?.stashDocState) return;
  const key = editorCacheKey(state);
  if (key) state.editor.stashDocState(key);
}
