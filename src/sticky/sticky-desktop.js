/**
 * Desktop-pinned sticky behaviour — everything a sticky does *only*
 * while a project Desktop is open (see README "Desktops"). A File Sticky
 * added on a Desktop auto-becomes kind `"desktop"` (sticky-notes.js), and
 * from then on it belongs to the canvas rather than the screen:
 *
 *   - its position is stored in canvas world coordinates (`wx`/`wy`) and
 *     re-anchored through the live camera on every pan / zoom,
 *   - it scales with the canvas, so it keeps its size relative to the
 *     thumbnails it annotates,
 *   - it lists in the shape shelf (the Desktop's right sidebar), and a
 *     shelf row click pans the canvas to it.
 *
 * Split out of sticky-notes.js to keep that file under the 700-line cap.
 * Each function takes the `notes` map rather than closing over it, so
 * sticky-notes.js stays the single owner of note state.
 */

import { desktopOpenId } from "./sticky-shared.js";

/** The layer desktop-pinned notes live in — mounted inside `.desktop-view`
 *  rather than the body-level #sticky-container, which is what puts these
 *  notes *beneath* the sidebars (see sticky-notes.css). Recreated on
 *  demand: closeDesktop wipes the view's markup, detaching it. Returns
 *  null when no Desktop is mounted. */
function stickyLayer() {
  const view = document.getElementById("desktop-view");
  if (!view) return null;
  let layer = view.querySelector(".sticky-desktop-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sticky-desktop-layer";
    view.appendChild(layer);
  }
  return layer;
}

/** Re-anchor + re-scale every note pinned to the open Desktop. Called on
 *  open and on every `desktop-camera-changed`. */
export function repositionDesktopNotes(notes) {
  const toScreen = typeof window !== "undefined" ? window.__hushDesktopWorldToScreen : null;
  const openId = desktopOpenId();
  if (!toScreen || !openId) return;
  const layer = stickyLayer();
  for (const [, n] of notes) {
    if (n.kind !== "desktop" || n.target !== openId) continue;
    // Adopt into the Desktop's own layer. Notes are created in (and a
    // rebuilt Desktop detaches them back to) the body-level container,
    // so this is where a pinned note joins the under-the-sidebars layer.
    if (layer && n.el.parentElement !== layer) layer.appendChild(n.el);
    if (typeof n.wx !== "number" || typeof n.wy !== "number") continue;
    const pt = toScreen({ x: n.wx, y: n.wy });
    if (!pt) continue;
    n.x = Math.round(pt.x);
    n.y = Math.round(pt.y);
    n.el.style.left = n.x + "px";
    n.el.style.top = n.y + "px";
    // Pinned to the background means pinned in *world* units, so the note
    // scales with the canvas. The origin is the top-left — the same point
    // `left`/`top` place and the same point the drag handler writes back
    // through the camera — so all the position math stays in screen space
    // and needs no zoom correction.
    const z = typeof pt.zoom === "number" && pt.zoom > 0 ? pt.zoom : 1;
    n.el.style.transformOrigin = "top left";
    n.el.style.transform = z === 1 ? "" : `scale(${z})`;
  }
}

/** Nudge the open Desktop to repaint. Thumbnail sticky badges are drawn
 *  live from the note list rather than baked into the cached image, so a
 *  note added / edited / closed has to invalidate the canvas even though
 *  no shape changed — "interaction" is the repaint-only notify key, so
 *  this never marks the Desktop dirty for a save. */
export async function repaintDesktop() {
  if (!desktopOpenId()) return;
  const { getActiveNotebookState } = await import("../notebook/notes-canvas.ts");
  getActiveNotebookState()?.notify("interaction");
}

/** Notes pinned to the open Desktop, in creation order — read by the
 *  shape shelf so they list alongside the file thumbnails. */
export function desktopStickyRows(notes) {
  const openId = desktopOpenId();
  if (!openId) return [];
  const rows = [];
  for (const [id, n] of notes) {
    if (n.kind !== "desktop" || n.target !== openId) continue;
    rows.push({ id, text: n.textarea ? n.textarea.value : (n.text || "") });
  }
  return rows;
}

/** Shelf row click: raise the note and pan the Desktop canvas so it's
 *  centred — a pinned sticky can sit anywhere in the world, including
 *  well off the current viewport. `raise` re-stacks it (sticky-notes
 *  owns the z counter). */
export async function revealDesktopSticky(notes, id, raise) {
  const note = notes.get(id);
  if (!note) return;
  raise?.(note);
  if (typeof note.wx !== "number" || typeof note.wy !== "number") return;
  const { getActiveNotebookState } = await import("../notebook/notes-canvas.ts");
  // While a Desktop is open its canvas *is* the active notebook.
  const st = getActiveNotebookState();
  const host = document.querySelector(".desktop-canvas-host");
  if (!st || !host) return;
  const rect = host.getBoundingClientRect();
  const zoom = st.camera.zoom || 1;
  st.camera = { ...st.camera, x: rect.width / 2 - note.wx * zoom, y: rect.height / 2 - note.wy * zoom };
  st.notify("camera");
  note.textarea?.focus();
}
