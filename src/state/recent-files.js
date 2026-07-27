/**
 * Per-desk "recent files" MRU.
 *
 * Recents are desk-scoped: the Recent Files panel and the Cmd+O picker
 * both only ever surface files from the desk you're standing in, so the
 * MRU that feeds them is keyed by desk id (`settings.recentFileIdsByDesk`)
 * rather than kept as one flat list. Without that, opening fifty files in
 * one desk would push another desk's history out of a shared 50-entry cap.
 *
 * The legacy flat `settings.recentFileIds` is read as a seed the first
 * time a desk has no entry of its own — filtered to that desk's files, so
 * an upgrade keeps whatever history was relevant here. Any write for a
 * desk materialises its key, which retires the seed for that desk (so a
 * removed row can't come back through the fallback).
 */

const CAP = 50;

/** Every fileId reachable inside `deskId`'s subtree. */
function deskFileIds(state, deskId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const out = new Set();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.fileId) out.add(n.fileId);
      // Projects are openable in their own right and are recorded by
      // node id, so they count as members too.
      if (n.type === "project" && n.id) out.add(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(desk?.children);
  return out;
}

/** The desk's MRU, most-recent first. Falls back to the legacy flat list
 *  (filtered to this desk) while the desk has no entry of its own. */
export function getDeskRecentFileIds(state, deskId) {
  if (!deskId) return [];
  const map = state.settings?.recentFileIdsByDesk;
  const own = map && typeof map === "object" ? map[deskId] : null;
  if (Array.isArray(own)) return own;
  const legacy = Array.isArray(state.settings?.recentFileIds) ? state.settings.recentFileIds : [];
  if (legacy.length === 0) return [];
  const members = deskFileIds(state, deskId);
  return legacy.filter((id) => members.has(id));
}

/** Replace the desk's MRU wholesale. Materialises the key even for an
 *  empty list, which is what stops the legacy seed reappearing. */
export function setDeskRecentFileIds(state, deskId, ids) {
  if (!deskId) return Promise.resolve();
  const map = state.settings?.recentFileIdsByDesk;
  const base = map && typeof map === "object" ? map : {};
  return state.updateSettings({
    recentFileIdsByDesk: { ...base, [deskId]: ids.slice(0, CAP) },
  });
}

/** Hoist `fileId` to the front of the desk's MRU. No-ops when the list
 *  already starts with it (so a repeat open doesn't rewrite settings). */
export function pushDeskRecentFile(state, deskId, fileId) {
  if (!deskId || !fileId) return Promise.resolve();
  const prev = getDeskRecentFileIds(state, deskId);
  const next = [fileId, ...prev.filter((id) => id !== fileId)].slice(0, CAP);
  const map = state.settings?.recentFileIdsByDesk;
  const materialised = Array.isArray(map?.[deskId]);
  if (materialised && next.length === prev.length && next[0] === prev[0]) return Promise.resolve();
  return setDeskRecentFileIds(state, deskId, next);
}
