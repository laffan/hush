/**
 * First-line auto-rename helpers — extracted from state.js.
 * The "name follows first line" rule has three triggers in editor.js:
 *   1. cursor leaves line 1
 *   2. editor blur
 *   3. autosave when cursor is not on line 1
 * Pane-driven docs go through `maybeRenameFileFromContent` instead.
 */

import { findNodeByFileId } from "./tree-helpers.js";
import { parseTabMarkerLine } from "../editor/tabs.js";
import { stripFrontmatter } from "../editor/frontmatter.js";

/** Pick the first content-bearing line as the doc's title. Skips blank
 *  lines, a leading metadata frontmatter block (properties are not a
 *  title), and `---Tab name---` markers — markers are structural, not
 *  titles, so an imported GDoc whose first tab is `---Slow Show---`
 *  should not end up with `---Slow Show---` as its filename. */
export function deriveName(content) {
  if (typeof content !== "string" || !content.trim()) return "Untitled";
  for (const rawLine of stripFrontmatter(content).split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (parseTabMarkerLine(trimmed)) continue;
    const cleaned = trimmed.replace(/^#+\s*/, "").replace(/[<>:"/\\|?*]/g, "").trim();
    if (!cleaned) continue;
    return cleaned.length <= 50 ? cleaned : cleaned.slice(0, 50);
  }
  return "Untitled";
}

/** True when the main editor's primary cursor sits on line 1. Used to
 *  gate the autosave rename path. */
export function cursorOnFirstLine(state) {
  if (!state.editor) return false;
  const view = state.editor.view;
  if (!view) return false;
  try {
    const head = view.state.selection.main.head;
    return view.state.doc.lineAt(head).number === 1;
  } catch { return false; }
}

/**
 * Sync a tree node's name to whatever `state.files` currently says for
 * the given fileId. Returns true when an update was made (and emits a
 * external-store rename hook). Caller is responsible for emitting "files-changed".
 */
export function updateTreeNodeNameByFileId(state, fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return false;
  const node = findNodeByFileId(state.fileTree, fileId);
  if (node && node.name !== file.name) {
    const oldName = node.name;
    node.name = file.name;
    state.syncRenameNode(node.id, oldName, node.type);
    return true;
  }
  return false;
}

export async function maybeRenameFromFirstLine(state) {
  if (state.currentProjectId || state.currentNotebookFileId || state.currentLocalSync) return;
  if (!state.currentFileId || !state.editor) return;
  // Docs linked to a Google Doc track the GDoc's title — the user
  // already chose that filename when they imported / linked, and the
  // first-line auto-rename would silently overwrite it with the doc
  // body's first content line (or a tab marker).
  if (state.settings?.googleDocLinks?.[state.currentFileId]) return;
  const content = state.editor.getContent();
  const derived = deriveName(content);
  if (!derived || derived === "Untitled") return;
  const node = findNodeByFileId(state.fileTree, state.currentFileId);
  if (!node || node.name === derived) return;
  // Tabbed docs that already carry an explicit name shouldn't auto-
  // rename — the name was set intentionally (e.g. converted from a
  // project). "Untitled" docs still auto-rename so freshly created
  // tabbed docs pick up a name from the first content line.
  if (node.name !== "Untitled" && _contentHasTabMarker(content)) return;
  const { renameTreeNode } = await import("./state-tree.js");
  await renameTreeNode(state, node.id, derived);
  state.emit("files-changed");
}

/** True when the content contains at least one `---Tab name---` marker. */
function _contentHasTabMarker(content) {
  if (typeof content !== "string") return false;
  for (const line of content.split("\n")) {
    if (parseTabMarkerLine(line.trim())) return true;
  }
  return false;
}

/** Pane-driven counterpart to {@link maybeRenameFromFirstLine}. Takes a
 *  fileId + raw content (read from the pane's own editor) and renames
 *  the matching tree node when the derived first-line name differs.
 *  Called from `savePaneContent` so docs created via "New Document as
 *  Pane" pick up a name from their first line, exactly like docs
 *  created in the main editor. */
export async function maybeRenameFileFromContent(state, fileId, content) {
  if (!fileId) return;
  // Match the gating above — linked docs keep their GDoc title.
  if (state.settings?.googleDocLinks?.[fileId]) return;
  const derived = deriveName(content);
  if (!derived || derived === "Untitled") return;
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node || node.name === derived) return;
  if (node.name !== "Untitled" && _contentHasTabMarker(content)) return;
  const { renameTreeNode } = await import("./state-tree.js");
  await renameTreeNode(state, node.id, derived);
  state.emit("files-changed");
}
