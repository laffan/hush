/**
 * The data the home screen widgets draw — built here, in the app, from
 * the live tree and the recents, and handed to the native side as one
 * JSON document. The widget extension never reads a desk folder: it reads
 * this snapshot out of the App Group container (see
 * widgets/README-WIDGETS.md for the native half).
 *
 *   {
 *     version: 1,
 *     desks: [ { id, name, openedAt, recent: [file…] } … ]   most recent first
 *     recentFiles: [ file… ]                                 across desks, newest first
 *   }
 *   file = { id, name, type, deskId, deskName, openedAt }
 *
 * `type` is document / notebook / stack / pdf / project — the widget
 * picks its glyph from it, and the open link carries it back. `id` is a
 * fileId, or a project's node id (projects are recorded in the MRU by
 * node id). `openedAt` is null for a file in the MRU from before times
 * were kept; such files sort after the stamped ones, in MRU order.
 *
 * Pure: reads state, writes nothing. Deliberately carries no "generated
 * at" time, so two windows describing the same state produce the same
 * bytes and the native side can skip a write that changes nothing.
 */
import { getDeskRecentFileIds } from "../state/recent-files.js";
import { getRecentActivity } from "./widget-activity.js";

export const WIDGET_SNAPSHOT_VERSION = 1;
/** Per desk: as many files as the large per-desk widget shows. */
const DESK_FILES = 8;
/** Across desks: as many as the large recent-files widget shows. */
const RECENT_FILES = 10;

const TRASH_PREFIX = "__trash__";
const FILE_TYPES = new Set(["document", "notebook", "stack", "pdf", "project"]);

/** Every openable entry in one desk's subtree, by the id the MRU records
 *  it under — fileId, or node id for a project. Trash is left out: a
 *  file deleted after it was opened is not something to offer from the
 *  home screen. So are project PDF aliases, which mirror a desk PDF. */
function indexDesk(desk) {
  const out = new Map();
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (typeof n.id === "string" && n.id.startsWith(TRASH_PREFIX)) continue;
      if (n.type === "project" && n.id && !n.id.startsWith("__inbox__")) {
        out.set(n.id, { name: n.name, type: "project" });
      } else if (n.fileId && FILE_TYPES.has(n.type) && !n.pdfAlias) {
        out.set(n.fileId, { name: n.name, type: n.type });
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(desk?.children);
  return out;
}

const stamp = (map, id) => (Number.isFinite(map[id]) ? map[id] : null);

export function buildWidgetSnapshot(state) {
  const activity = getRecentActivity(state);
  const registry = Array.isArray(state.settings?.desks) ? state.settings.desks : [];
  const tree = state.fileTree || [];

  const desks = registry.map((d, order) => {
    const node = tree.find((n) => n.type === "desk" && n.id === d.id);
    const index = indexDesk(node);
    const recent = [];
    for (const id of getDeskRecentFileIds(state, d.id)) {
      const hit = index.get(id);
      if (!hit) continue;
      recent.push({
        id, name: hit.name || "Untitled", type: hit.type,
        deskId: d.id, deskName: d.name || "Untitled desk",
        openedAt: stamp(activity.files, id),
      });
      if (recent.length >= DESK_FILES * 2) break;
    }
    // A desk's own openedAt is when it was last switched to or worked in;
    // a file opened there more recently than that counts too.
    const fileTimes = recent.map((f) => f.openedAt || 0);
    const openedAt = Math.max(stamp(activity.desks, d.id) || 0, ...fileTimes) || null;
    return { id: d.id, name: d.name || "Untitled desk", openedAt, order, recent };
  });

  // Stamped first, newest first; unstamped after, in registry order.
  desks.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || a.order - b.order);

  // Across desks: interleave by time. Unstamped files keep their desk's
  // MRU order and fall in behind every stamped one, desk by desk.
  const pool = [];
  desks.forEach((d, deskRank) => d.recent.forEach((f, rank) => pool.push({ f, deskRank, rank })));
  pool.sort((a, b) => (b.f.openedAt || 0) - (a.f.openedAt || 0)
    || a.deskRank - b.deskRank || a.rank - b.rank);

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    desks: desks.map(({ id, name, openedAt, recent }) => ({
      id, name, openedAt, recent: recent.slice(0, DESK_FILES),
    })),
    recentFiles: pool.slice(0, RECENT_FILES).map((p) => p.f),
  };
}
