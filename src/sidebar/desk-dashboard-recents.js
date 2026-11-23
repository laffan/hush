/**
 * The Desk Dashboard sidebar's foot: recent files across every desk, as
 * one list, newest first. The same list Recent Files shows with its desk
 * toggle pressed (state/cross-desk.js#recentAcrossDesks — each desk's
 * open-order MRU interleaved by when its files were opened), whatever
 * that toggle is set to. The cards beside it already show each desk's
 * recently *edited* files; this is what was last *opened*, wherever.
 *
 * Unlike Recent Files, a file now in its desk's Trash is left out: the
 * dashboard is for going back to work, not to what is on its way out.
 *
 * Each row is the file's icon and name and, faint at its right, its
 * desk. A click closes the dashboard and opens the file on its desk.
 */

import { escHtml, leafIcon } from "./files-panel-shared.js";
import { recentAcrossDesks, openLeafOnItsDesk } from "../state/cross-desk.js";
import { findNodeByFileId } from "../state/tree-helpers.js";

/** Rows listed; the list scrolls inside its share of the sidebar. */
const COUNT = 30;

// The open order lives in settings (per-desk MRU, recentActivity), so
// settings-changed covers a file opened in a sibling window too.
const EVENTS = ["settings-changed", "files-changed", "desks-changed", "active-desk-changed", "recent-activity-changed"];

/** Whether a file (or a project, by node id) sits in its desk's Trash. */
function inTrash(state, deskId, fileId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const trash = (desk?.children || []).find((n) => n.id === `__trash__:${deskId}`);
  return !!trash && (!!findNodeByFileId([trash], fileId) || hasId(trash.children, fileId));
}
const hasId = (nodes, id) => (nodes || []).some((n) => n.id === id || hasId(n.children, id));

/**
 * Fill `el` and keep it current. `close` shuts the dashboard before a
 * file opens. Returns `{ destroy }`.
 */
export function mountDashboardRecents(state, el, close) {
  el.innerHTML = `<div class="desk-dash-side-head"><span class="desk-dash-side-title">Recent</span></div>
    <ul class="desk-dash-recents-list"></ul>`;
  const list = el.querySelector(".desk-dash-recents-list");
  let lastHtml = "";

  function render() {
    // Asked for more than shown, so the Trash leaving some out doesn't
    // shorten the list.
    const rows = recentAcrossDesks(state, COUNT * 2)
      .filter((r) => !inTrash(state, r.deskId, r.fileId))
      .slice(0, COUNT);
    const html = rows.length
      ? rows.map((r) => `<li><button type="button" class="desk-dash-recent-file" data-file-id="${escHtml(r.fileId)}" data-desk-id="${escHtml(r.deskId)}" data-type="${escHtml(r.node.type)}">
          ${leafIcon(r.node)}<span class="desk-dash-recent-name">${escHtml(r.node.name || "Untitled")}</span><span class="desk-dash-recent-desk">${escHtml(r.deskName)}</span>
        </button></li>`).join("")
      : `<li class="desk-dash-empty">No recent files yet</li>`;
    if (html === lastHtml) return;
    lastHtml = html;
    list.innerHTML = html;
  }

  list.addEventListener("click", async (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".desk-dash-recent-file") : null;
    if (!btn) return;
    const { fileId, deskId, type } = btn.dataset;
    close();
    await openLeafOnItsDesk(state, { fileId, deskId, type });
  });

  for (const ev of EVENTS) state.on(ev, render);
  render();

  return {
    destroy() { for (const ev of EVENTS) state.off(ev, render); },
  };
}
