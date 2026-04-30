/**
 * Project sync via `.hush/projects.json`.
 *
 * Replaces the per-folder `.hushproject` files. A project is a tree
 * folder distinguished by being listed in this registry. The receiving
 * device finds the matching folder by relativePath and converts its
 * tree node type from "folder" to "project", applying the ordering.
 *
 * The legacy `.hushproject` files still on Dropbox are ignored on the
 * receive side (the cursor consumer skips kind="hushproject"). They're
 * harmless until manually cleaned up.
 */

const PROJECTS_FILENAME = "projects.json";
const FORMAT_VERSION = 1;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Walk the tree collecting `{relativePath, ordering}` entries for every
 *  project node. The path-builder mirrors `findSyncContext`'s logic so
 *  the entries map to the same Dropbox paths the rest of sync uses. */
export function serializeProjects(fileTree) {
  const out = [];

  function walk(nodes, pathParts) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      // Skip special nodes (Inbox, Trash, Images) — they don't sync as
      // projects even if their type were ever "project".
      if (node.id === "__inbox__" || node.id === "__trash__" || node.id === "__images__") continue;

      const path = [...pathParts, node.name].join("/");
      if (node.type === "project") {
        const ordering = (node.children || [])
          .filter(c => c.type === "document" || c.type === "notebook")
          .map(c => c.name);
        out.push({ folderPath: path, ordering });
      }
      if (node.children?.length) walk(node.children, [...pathParts, node.name]);
    }
  }
  walk(fileTree, []);

  return JSON.stringify({
    format: "hush-projects",
    version: FORMAT_VERSION,
    projects: out,
  }, null, 2);
}

/** Find a tree node by walking from root using a path of names. */
function findNodeByPath(fileTree, folderPath) {
  if (!folderPath) return null;
  const parts = folderPath.split("/");
  let cursor = fileTree;
  let found = null;
  for (let i = 0; i < parts.length; i++) {
    if (!Array.isArray(cursor)) return null;
    const name = parts[i];
    const node = cursor.find(n =>
      (n.type === "folder" || n.type === "project") && n.name === name
    );
    if (!node) return null;
    found = node;
    cursor = node.children || [];
  }
  return found;
}

/**
 * Apply a remote projects payload. Returns `{matched, added, applied}`:
 *   * matched — folder node existed locally, became / stayed a project
 *   * added   — placeholder project node created (folder didn't exist
 *               yet because cursor hasn't pulled it down; rare)
 *   * applied — total entries successfully applied (matched + added)
 */
export async function applyProjectsFile(state, payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch { return { matched: 0, added: 0, applied: 0, error: "parse" }; }
  if (!parsed || parsed.format !== "hush-projects" || !Array.isArray(parsed.projects)) {
    return { matched: 0, added: 0, applied: 0, error: "format" };
  }

  let matched = 0;
  let added = 0;
  let treeChanged = false;

  for (const entry of parsed.projects) {
    if (!entry || !entry.folderPath) continue;
    const node = findNodeByPath(state.fileTree, entry.folderPath);
    if (!node) {
      // The folder hasn't synced down yet. We could create a placeholder,
      // but it's cleaner to wait for the cursor to bring the folder in
      // first; on the next projects.json refresh (or next pane/file
      // event that triggers a re-pull) we'll resolve it. Skip silently.
      continue;
    }
    if (node.type !== "project") {
      node.type = "project";
      treeChanged = true;
    }
    // Reorder children per the remote ordering. Children not named in
    // the ordering are appended at the end (they're newer than the
    // ordering snapshot — keep them).
    const ordering = Array.isArray(entry.ordering) ? entry.ordering : [];
    if (ordering.length && Array.isArray(node.children)) {
      const before = node.children;
      const byName = new Map(before.map(c => [c.name, c]));
      const next = [];
      for (const name of ordering) {
        const c = byName.get(name);
        if (c) { next.push(c); byName.delete(name); }
      }
      // Append leftovers in their original relative order.
      for (const c of before) if (byName.has(c.name)) next.push(c);
      const sameOrder =
        next.length === before.length && next.every((n, i) => n === before[i]);
      if (!sameOrder) {
        node.children = next;
        treeChanged = true;
      }
    }
    matched++;
  }

  if (treeChanged) {
    await state.saveFileTree();
    state.emit("files-changed");
  }
  return { matched, added, applied: matched + added };
}

/**
 * Push the current local project state to Dropbox. Called on project
 * create/rename/delete/reorder. Coalesces with any pending upload via
 * the op log (the drain runs them serially; latest payload wins on
 * Dropbox).
 */
export async function pushProjectsToDropbox(state) {
  if (!state?.settings?.dropboxEnabled || !state?.settings?.dropboxSyncPath) return;
  const payload = serializeProjects(state.fileTree);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(PROJECTS_FILENAME, payload);
}

export const PROJECTS_RELATIVE_PATH = `.hush/${PROJECTS_FILENAME}`;
