/**
 * File view mode — which representation the files panel draws.
 *
 * Three modes, per desk: the default `list` (the SortableList tree the
 * sidebar has always shown), `desktop` (a canvas of folder / file icons
 * with a folder's contents ringed around it), and `drone` (a top-down
 * axonometric model of the desk as a physical space).
 *
 * The choice lives on `desksMeta[deskId].fileView`, beside the desk's
 * style and Ratchet flag, and rides the desk's `.hushdesk` through
 * `sync/desk-meta.js` — a desk handed to another install arrives in the
 * view it was left in. Arrangement (dragged icon positions, which
 * folders are open) is per-device instead and lives in
 * `settings.fileViewLayouts`, keyed by desk id: it describes this
 * screen, not the desk.
 */

export const FILE_VIEW_MODES = ["list", "desktop", "drone"];

export const FILE_VIEW_LABELS = {
  list: "List",
  desktop: "Desktop",
  drone: "Drone",
};

function activeDeskId(state, deskId) {
  return deskId || state.settings?.activeDeskId || state.getActiveDesk?.()?.id || null;
}

/** The view mode for a desk (defaults to the active desk). Anything the
 *  settings file doesn't recognise reads as `list`, so a desk written by
 *  a future version can't strand this one on a view it can't draw. */
export function getDeskFileView(state, deskId) {
  const id = activeDeskId(state, deskId);
  if (!id) return "list";
  const mode = state.settings?.desksMeta?.[id]?.fileView;
  return FILE_VIEW_MODES.includes(mode) ? mode : "list";
}

/** Set a desk's view mode and mirror it into the desk folder. Emits
 *  `file-view-changed` with `userInitiated` so the sidebar knows it may
 *  open itself to show the result — a mode arriving from another device
 *  through `.hushdesk` gets the same event without it. No-ops when the
 *  desk is already in that mode. */
export async function setDeskFileView(state, mode, deskId) {
  const id = activeDeskId(state, deskId);
  if (!id || !FILE_VIEW_MODES.includes(mode)) return;
  if (getDeskFileView(state, id) === mode) return;
  const meta = { ...(state.settings?.desksMeta || {}) };
  meta[id] = { ...(meta[id] || {}), fileView: mode };
  await state.updateSettings({ desksMeta: meta });
  import("../sync/desk-meta.js")
    .then(({ pushDeskMeta }) => pushDeskMeta(state, id))
    .catch(() => {});
  state.emit("file-view-changed", { deskId: id, mode, userInitiated: true });
}

/** Next mode in the cycle — the affordance the on-canvas chip uses so a
 *  canvas view is never a dead end for someone who hasn't found the
 *  command palette entries. */
export function nextFileViewMode(mode) {
  const i = FILE_VIEW_MODES.indexOf(mode);
  return FILE_VIEW_MODES[(i + 1) % FILE_VIEW_MODES.length];
}

/** This device's saved arrangement for a desk: `{ positions, openIds }`.
 *  Always returns a fresh object, so callers can mutate it freely. */
export function getFileViewLayout(state, deskId) {
  const id = activeDeskId(state, deskId);
  const saved = (id && state.settings?.fileViewLayouts?.[id]) || {};
  return {
    positions: { ...(saved.positions || {}) },
    openIds: Array.isArray(saved.openIds) ? [...saved.openIds] : [],
  };
}

/** Write a desk's arrangement back. Local-only — never mirrored into
 *  `.hushdesk`, since an icon position is a fact about one screen. */
export async function saveFileViewLayout(state, layout, deskId) {
  const id = activeDeskId(state, deskId);
  if (!id) return;
  const all = { ...(state.settings?.fileViewLayouts || {}) };
  all[id] = {
    positions: layout.positions || {},
    openIds: layout.openIds || [],
  };
  await state.updateSettings({ fileViewLayouts: all });
}
