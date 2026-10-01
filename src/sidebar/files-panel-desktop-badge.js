/**
 * The Desktop button on a project's row. Every project row offers its
 * Desktop among the hover actions; once the user has put anything on
 * that Desktop — a note, a drawing, a drag box, a pinned sticky — that
 * same button stays in view where the hover shows it (the menu beside
 * it still waits for the hover), so a project with a Desktop worth
 * going back to says so without one. Which Desktops those are is
 * desktop-content-index.js's record; files-panel.css does the rest.
 */

import {
  desktopHasContent, backfillDesktopContentIndex, DESKTOP_CONTENT_EVENT,
} from "../desktop/desktop-content-index.js";
import { hasDesktop } from "./files-panel-row-menu.js";

/** Whether `item`'s row keeps its Desktop button in view. */
export function showsDesktopButton(state, item, inTrash) {
  return hasDesktop(item.id, item.type, inTrash, item) && desktopHasContent(state, item.id);
}

/** Re-render when a Desktop gains its first content or loses its last,
 *  and read the Desktops saved before the record existed once. */
export function onDesktopContentChange(fn) {
  window.addEventListener(DESKTOP_CONTENT_EVENT, fn);
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
  idle(() => { void backfillDesktopContentIndex(); });
}
