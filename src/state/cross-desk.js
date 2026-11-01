/**
 * Reaching files on other desks — the ⌘O picker's and Recent Files'
 * all-desks mode (their desk toggle).
 *
 * Opening a file that lives on another desk goes to that desk first: the
 * sidebar, the style, Cmd+N, the Inbox all follow the desk you are on, so
 * a file open on the wrong one would read as somewhere it isn't. The
 * switch has to *land* before the file opens: `setActiveDesk` emits
 * `active-desk-changed`, whose handler in main.js opens that desk's last
 * file asynchronously, and a file opened before it finishes is replaced
 * by it. So the open waits for the `desk-overview-restore` the handler
 * emits at its end (Write Now waits the same way).
 */
import { collectFileLeaves } from "../command-palette-helpers.js";
import { getDeskRecentFileIds } from "./recent-files.js";
import { getRecentActivity } from "../widgets/widget-activity.js";
import { findNodeByFileId } from "./tree-helpers.js";

/** How long a desk switch may take to land before the open goes ahead
 *  regardless (a local desk's folder can be slow to answer). */
const DESK_LANDING_MS = 5000;

const deskNodes = (state) => (state.fileTree || []).filter((n) => n.type === "desk");
const deskName = (state, deskId) =>
  (state.settings?.desks || []).find((d) => d.id === deskId)?.name
  || deskNodes(state).find((d) => d.id === deskId)?.name || "Untitled desk";

/** Every openable leaf on every desk (the ⌘O picker's rows), each with
 *  the `deskId` and `deskName` it lives on. The active desk's come
 *  first. */
export function allDeskLeaves(state) {
  const active = state.settings?.activeDeskId;
  const desks = deskNodes(state).sort((a, b) => (b.id === active) - (a.id === active));
  return desks.flatMap((d) => collectFileLeaves(d.children || [])
    .map((leaf) => ({ ...leaf, deskId: d.id, deskName: deskName(state, d.id) })));
}

/** The desk a file (by fileId, or a project by node id) lives on. */
export function deskIdOfFile(state, fileId) {
  for (const d of deskNodes(state)) {
    if (findNodeByFileId(d.children || [], fileId)) return d.id;
    if (findProject(d.children || [], fileId)) return d.id;
  }
  return null;
}

function findProject(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id && n.type === "project") return n;
    const hit = n.children?.length ? findProject(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/** The recent files of every desk as one list, newest first: each desk's
 *  MRU (state/recent-files.js) interleaved by when its files were opened
 *  (the open times the widgets keep, widgets/widget-activity.js). A file
 *  with no time falls in behind every timed one, in its desk's order.
 *  Rows are `{ fileId, node, deskId, deskName }`. */
export function recentAcrossDesks(state, limit = 50) {
  const times = getRecentActivity(state).files;
  const pool = [];
  deskNodes(state).forEach((d, deskRank) => {
    getDeskRecentFileIds(state, d.id).forEach((fileId, rank) => {
      const node = findNodeByFileId(d.children || [], fileId) || findProject(d.children || [], fileId);
      if (!node) return;
      pool.push({ fileId, node, deskId: d.id, deskName: deskName(state, d.id), at: times[fileId] || 0, deskRank, rank });
    });
  });
  pool.sort((a, b) => b.at - a.at || a.deskRank - b.deskRank || a.rank - b.rank);
  return pool.slice(0, limit);
}

/** Switch to `deskId` and wait for the switch to land on that desk's
 *  last file. Resolves at once when it is the desk already in front. */
export async function switchDeskAndLand(state, deskId) {
  if (!deskId || deskId === state.settings?.activeDeskId) return;
  if (!deskNodes(state).some((d) => d.id === deskId)) return;
  const landed = new Promise((resolve) => {
    const done = () => { clearTimeout(timer); state.off("desk-overview-restore", done); resolve(); };
    const timer = setTimeout(done, DESK_LANDING_MS);
    // main.js's desk-switch handler emits this once the desk's file is open.
    state.on("desk-overview-restore", done);
  });
  await state.setActiveDesk(deskId);
  await landed;
}

/** Open a picker leaf (`{ type, fileId }`) in the main view. */
export function openLeaf(state, f) {
  if (f.type === "notebook") return state.openNotebook(f.fileId);
  if (f.type === "project") return state.openProject(f.fileId);
  if (f.type === "stack") return state.openStack(f.fileId);
  return state.openFile(f.fileId);
}

/** Open a leaf, going to its desk first when it lives on another. */
export async function openLeafOnItsDesk(state, f) {
  const deskId = f.deskId || deskIdOfFile(state, f.fileId);
  if (deskId && deskId !== state.settings?.activeDeskId) await switchDeskAndLand(state, deskId);
  return openLeaf(state, f);
}
