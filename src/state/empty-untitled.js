/**
 * The "empty Untitled" hygiene pass.
 *
 * Hush spins up a fresh doc slot in several places (a new window with no
 * file to restore, a desk with nothing in it), and when the user never
 * types into one it's pure noise: a placeholder-named, contentless doc
 * that then competes to be the "last file" on the next launch. Such docs
 * are skipped by the save / sync paths and swept at boot.
 *
 * Split out of state-files.js for the line cap.
 */

import { findNodeByFileId, removeNode, isCardsHome } from "./tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** A doc is "empty Untitled" when it carries the placeholder name and
 *  has no actual content. `content` must be the real body — a caller that
 *  doesn't have it (the library listing carries none for notebooks and
 *  stacks) must not ask, or it will get `true` for a file full of work. */
export function isEmptyUntitled(name, content) {
  if (name && name !== "Untitled") return false;
  return !content || !content.trim();
}

/** Walk the loaded files + tree and drop any empty Untitled docs that
 *  survived a previous session. Called once during init() after the tree
 *  has been hydrated so the next "restore last file" branch never lands
 *  on a placeholder doc the user never used. */
export async function pruneEmptyUntitled(state) {
  if (!Array.isArray(state.files) || state.files.length === 0) return;
  await clearEmptyInboxItems(state).catch((e) => console.warn("clearing empty Inbox items failed:", e));
  const targets = [];
  for (const file of state.files) {
    // Documents only, and only when we are actually holding the body.
    // The listing carries `content: null` for notebooks and stacks (see
    // `FileManager::list_files`), and a null body reads as "empty" — an
    // untitled notebook the user had been drawing in would be deleted on
    // the next launch. The node type is the real gate; the content check
    // is the belt to its braces.
    const node = findNodeByFileId(state.fileTree, file?.id);
    if (node && node.type !== "document") continue;
    if (typeof file?.content !== "string") continue;
    if (!isEmptyUntitled(file?.name, file?.content)) continue;
    targets.push({ fileId: file.id, nodeId: node?.id || null });
  }
  if (!targets.length) return;
  for (const { fileId, nodeId } of targets) {
    if (IS_TAURI) {
      try { await tauriInvoke("delete_file", { id: fileId }); }
      catch (e) { console.warn("prune empty Untitled failed:", e); }
    }
    if (nodeId) removeNode(state.fileTree, nodeId);
  }
  // Drop the pruned entries in place. Re-listing here meant any boot that
  // found one stray placeholder paid the whole library scan twice.
  state.files = state.files.filter((f) => !targets.some((t) => t.fileId === f.id));
  if (!IS_TAURI) state._saveFilesLocal();
  try { await state.saveFileTree(); } catch (_) {}
}

/** A document with nothing past its first line — a title, or a Write Now
 *  timestamp, and no more. Blank lines go first, whatever made them
 *  blank: plain newlines (Write Now's, the typewriter runway's), `\r`,
 *  invisible characters (zero-width and non-breaking spaces, line and
 *  paragraph separators, a BOM), and lines holding nothing but markdown
 *  markers (`#`, `-`, `*`, `>`) — none of them is writing. */
export function hasOnlyFirstLine(content) {
  if (typeof content !== "string") return false;
  const lines = content
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2028\u2029\r]/g, (c) => (c === "\r" ? "" : c === "\u00A0" ? " " : "\n"))
    .split("\n")
    .filter((l) => l.replace(/^[\s#>*+-]*$/, "").trim());
  return lines.length <= 1;
}

/** Settings → General, "Automatically clear empty inbox items on start":
 *  each desk's Inbox loses its top-level empty notebooks and documents
 *  with only a first line. They go to their desk's Trash rather than
 *  away for good — a one-line note is still somebody's line — with one
 *  tree save for the lot. The CARDS notebook stays (it is the Inbox's
 *  own), as does anything inside a folder or project there. Primary
 *  window only: a second window booting must not clear a document the
 *  first one has just made. */
export async function clearEmptyInboxItems(state) {
  if (state.settings?.autoClearEmptyInbox === false || state.isSecondaryWindow) return;
  const bodies = new Map((state.files || []).map((f) => [f.id, f.content]));
  const docs = [];
  const notebooks = [];
  for (const desk of state.fileTree || []) {
    if (desk?.type !== "desk") continue;
    const inbox = (desk.children || []).find((c) => c.id === `__inbox__:${desk.id}`);
    for (const node of inbox?.children || []) {
      if (!node.fileId || isCardsHome(node)) continue;
      if (node.type === "document" && hasOnlyFirstLine(bodies.get(node.fileId))) docs.push({ node, desk });
      else if (node.type === "notebook") notebooks.push({ node, desk });
    }
  }
  let empty = new Set();
  if (notebooks.length && IS_TAURI) {
    try { empty = new Set(await tauriInvoke("notebooks_empty", { ids: notebooks.map((n) => n.node.fileId) })); }
    catch (e) { console.warn("notebooks_empty failed:", e); }
  }
  const doomed = [...docs, ...notebooks.filter((n) => empty.has(n.node.fileId))];
  if (!doomed.length) return;
  for (const { node, desk } of doomed) {
    const removed = removeNode(state.fileTree, node.id);
    const trash = (desk.children || []).find((c) => c.id === `__trash__:${desk.id}`);
    if (removed && trash) (trash.children || (trash.children = [])).push(removed);
  }
  try { await state.saveFileTree(); } catch (_) {}
  const { logActivity } = await import("../activity-log.js");
  logActivity("desks", "info", `Cleared ${doomed.length} empty Inbox item${doomed.length === 1 ? "" : "s"} to Trash`,
    { names: doomed.map((d) => d.node.name) });
}
