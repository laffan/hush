/**
 * Project sync via `.hush/projects.json`.
 *
 * A project is a tree folder distinguished by being listed in this
 * registry. v2 of the schema keys each entry on
 * `{ deskId, innerPath, ordering }` rather than a name-based
 * `folderPath` so that renaming a desk's top-level folder doesn't
 * orphan the project entry. The desk id is stable across renames; the
 * inner path runs from the desk's root down to the project folder.
 *
 * Apply reads both v1 (legacy `folderPath`) and v2 (`deskId` +
 * `innerPath`); push always writes v2.
 *
 * The legacy `.hushproject` files still on Dropbox are ignored on the
 * receive side (the cursor consumer skips kind="hushproject"). They're
 * harmless until manually cleaned up.
 */

const PROJECTS_FILENAME = "projects.json";
const FORMAT_VERSION = 2;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Walk the tree collecting `{deskId, innerPath, ordering}` entries for
 *  every project node. Projects are always nested inside a desk node
 *  (or in the legacy flat-tree case under no desk at all, in which
 *  case `deskId` is empty and `innerPath` is the absolute path). */
export function serializeProjects(fileTree) {
  const out = [];

  function walk(nodes, deskId, innerParts) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.id === "__inbox__" || node.id === "__trash__" || node.id === "__images__") continue;
      if (node.id?.startsWith("__inbox__:") || node.id?.startsWith("__trash__:") || node.id?.startsWith("__images__:")) continue;

      if (node.type === "desk") {
        // Reset the inner path at the desk boundary; the desk's id is
        // the new key prefix.
        if (node.children?.length) walk(node.children, node.id, []);
        continue;
      }

      const nextInner = [...innerParts, node.name];
      if (node.type === "project") {
        const ordering = (node.children || [])
          .filter(c => c.type === "document" || c.type === "notebook")
          .map(c => c.name);
        out.push({
          deskId: deskId || "",
          innerPath: nextInner.join("/"),
          ordering,
        });
      }
      if (node.children?.length) walk(node.children, deskId, nextInner);
    }
  }
  walk(fileTree, "", []);

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
      (n.type === "folder" || n.type === "project" || n.type === "desk") && n.name === name
    );
    if (!node) return null;
    found = node;
    cursor = node.children || [];
  }
  return found;
}

/** Resolve a `{deskId, innerPath}` pair to a tree node. Walks down
 *  from the desk's children using the inner path's name segments.
 *  Falls back to a tree-wide name walk when `deskId` is empty (legacy
 *  v1 entries arrive with an absolute path string). */
function findNodeByDeskInner(fileTree, deskId, innerPath) {
  if (!deskId) return findNodeByPath(fileTree, innerPath || "");
  const desk = (fileTree || []).find(n => n.type === "desk" && n.id === deskId);
  if (!desk) return null;
  if (!innerPath) return desk;
  return findNodeByPath(desk.children || [], innerPath);
}

/**
 * Apply a remote projects payload. Returns `{matched, added, applied}`:
 *   * matched — folder node existed locally, became / stayed a project
 *   * added   — placeholder project node created (folder didn't exist
 *               yet because cursor hasn't pulled it down; rare)
 *   * applied — total entries successfully applied (matched + added)
 *
 * Apply policy is union: any project listed in the remote payload is
 * promoted locally. Local projects that aren't in the remote list are
 * left as projects — we don't demote them to folders. This protects
 * against concurrent-create races where two devices each promote a
 * different folder; pure strict apply would oscillate (each device
 * demotes the other's new project until the next push catches up).
 *
 * Trade-off: a project demoted to folder on one device doesn't propagate
 * to peers — the user has to demote on each device. Folder → project
 * (the more common direction) does propagate.
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
    if (!entry) continue;
    // v2: deskId + innerPath; v1: folderPath
    const node = entry.deskId || entry.innerPath !== undefined
      ? findNodeByDeskInner(state.fileTree, entry.deskId, entry.innerPath || "")
      : (entry.folderPath ? findNodeByPath(state.fileTree, entry.folderPath) : null);
    if (!node) {
      // The folder hasn't synced down yet. We could create a placeholder,
      // but it's cleaner to wait for the cursor to bring the folder in
      // first; on the next projects.json refresh (or next pane/file
      // event that triggers a re-pull) we'll resolve it. Skip silently.
      continue;
    }
    if (node.type === "desk") continue; // never demote a desk to a project
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
  const { isSyncWriteGatedSync } = await import("./sync-gate.js");
  if (isSyncWriteGatedSync(state)) return;
  const payload = serializeProjects(state.fileTree);
  const { enqueueMetaUpload } = await import("./meta-sync.js");
  await enqueueMetaUpload(PROJECTS_FILENAME, payload);
}

export const PROJECTS_RELATIVE_PATH = `.hush/${PROJECTS_FILENAME}`;
