/**
 * The "I clicked it and nothing happened" path.
 *
 * A row that shows in the sidebar but refuses to open is the loudest
 * symptom of desk-store damage, and it used to be a bare
 * `console.error`: the user got a click that did nothing, with no way
 * to find out why and nothing left behind to diagnose it from. Now it
 * says so on screen and leaves a record carrying the context that
 * matters — which desk, which node, which fileId — so Settings > Debug
 * > Repair desk files has something to act on.
 */

import { logActivity } from "../activity-log.js";

export async function reportUnopenableFile(state, fileId, node, error) {
  const desk = (state.fileTree || []).find(
    (d) => d.type === "desk" && containsFileId(d.children, fileId),
  );
  logActivity("files", "error", `Couldn't open "${node?.name || fileId}"`, {
    fileId,
    nodeType: node?.type || null,
    desk: desk ? `${desk.name} (${desk.id})` : "not in any desk",
    error: String(error),
  });
  try {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(
      `“${node?.name || "That file"}” couldn't be opened — its content is missing. Settings → Debug → Repair desk files can look for it.`,
      "error",
    );
  } catch (_) { /* toast unavailable — the log entry still stands */ }
}

function containsFileId(nodes, fileId) {
  for (const n of nodes || []) {
    if (n?.fileId === fileId) return true;
    if (containsFileId(n.children, fileId)) return true;
  }
  return false;
}
