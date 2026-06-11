/**
 * Per-document "Google comments hidden" flag. When set, Pull skips
 * weaving comments / suggestions into the document, and the command
 * palette swaps `Google : Hide comments` for `Google : Show comments`.
 *
 * Stored in localStorage (per device — the flag is a viewing preference,
 * not document content). Kept dependency-free so the command palette can
 * import it statically without dragging the Google API modules into the
 * eager bundle.
 */
const KEY = "hush-gdoc-comments-hidden";

function readMap() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function isCommentsHidden(fileId) {
  if (!fileId) return false;
  return !!readMap()[fileId];
}

export function setCommentsHidden(fileId, hidden) {
  if (!fileId) return;
  const map = readMap();
  if (hidden) map[fileId] = true;
  else delete map[fileId];
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* storage full / unavailable — flag just won't persist */ }
}
