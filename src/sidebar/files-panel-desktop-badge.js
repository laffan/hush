/**
 * The Desktop icon beside a project's name. Every project row offers its
 * Desktop among the hover actions; once the user has put anything on
 * that Desktop — a note, a drawing, a drag box, a pinned sticky — the
 * icon stays on the row, right after the name, so a project with a
 * Desktop worth going back to says so without a hover. Which Desktops
 * those are is desktop-content-index.js's record.
 */

import {
  desktopHasContent, backfillDesktopContentIndex, DESKTOP_CONTENT_EVENT,
} from "../desktop/desktop-content-index.js";
import { hasDesktop, SHELF_SVG } from "./files-panel-row-menu.js";
import { escHtml } from "./files-panel-shared.js";

/** The badge for `item`'s row, or "" when it hasn't earned one. Clicks
 *  route through the panel's `[data-tree-action]` handler, which reads
 *  the node id off the button. */
export function desktopBadgeHtml(state, item, inTrash) {
  if (!hasDesktop(item.id, item.type, inTrash, item) || !desktopHasContent(state, item.id)) return "";
  return `<button type="button" class="tree-desktop-badge" data-tree-action="view-desktop" data-node-id="${escHtml(item.id)}" data-tooltip="View Desktop" aria-label="View Desktop">${SHELF_SVG}</button>`;
}

/** Re-render when a Desktop gains its first content or loses its last,
 *  and read the Desktops saved before the record existed once. */
export function onDesktopContentChange(fn) {
  window.addEventListener(DESKTOP_CONTENT_EVENT, fn);
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
  idle(() => { void backfillDesktopContentIndex(); });
}
