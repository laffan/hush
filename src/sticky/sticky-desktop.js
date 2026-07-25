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
function stickyLayer(notes) {
  const view = document.getElementById("desktop-view");
  if (!view) return null;
  let layer = view.querySelector(".sticky-desktop-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sticky-desktop-layer";
    // Delegated, so it covers notes adopted into the layer later too.
    // Capture phase: the note's own drag / textarea handlers stop
    // propagation, and selecting has to happen either way.
    layer.addEventListener("pointerdown", (e) => {
      const el = e.target.closest?.(".sticky-note");
      if (!el) return;
      for (const [id, n] of notes) {
        if (n.el === el) { selectOnly(notes, id); break; }
      }
    }, true);
    view.appendChild(layer);
  }
  return layer;
}

// ── Selection ─────────────────────────────────────────────────────────
// Desktop stickies behave like canvas objects: clicking one selects it,
// a marquee that touches one picks it up, and a canvas click clears.
// Selection is visual only — a sticky is deleted by its own × (which is
// permanent), never by the canvas's delete key.

const selected = new Set();
let boundState = null;   // canvas whose gestures we're listening to
let ownWrite = false;    // our own selection write, so the clear-on-canvas
                         // listener doesn't immediately undo it

function paintSelection(notes) {
  for (const [id, n] of notes) {
    if (n.kind === "desktop") n.el.classList.toggle("selected", selected.has(id));
  }
}

function selectOnly(notes, id) {
  selected.clear();
  selected.add(id);
  paintSelection(notes);
  // One selection model at a time: picking a sticky drops the shapes.
  if (boundState?.selectedIds.size) {
    ownWrite = true;
    boundState.selectedIds = new Set();
    boundState.notify("selectedIds");
    queueMicrotask(() => { ownWrite = false; });
  }
}

function clearSelection(notes) {
  if (!selected.size) return;
  selected.clear();
  paintSelection(notes);
}

/** Pick up every desktop note the released marquee touched. Compared in
 *  screen space against each note's live rect, which already folds in the
 *  camera's pan and the note's zoom scaling — no world math to keep in
 *  sync, and no dependence on how the canvas batches its notifies. */
function marqueePick(notes, a, b) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const openId = desktopOpenId();
  for (const [id, n] of notes) {
    if (n.kind !== "desktop" || n.target !== openId) continue;
    if (n.el.style.display === "none") continue;
    const r = n.el.getBoundingClientRect();
    if (r.left <= x1 && r.right >= x0 && r.top <= y1 && r.bottom >= y0) selected.add(id);
  }
  paintSelection(notes);
}

/** Wire the open Desktop's canvas to sticky selection. The marquee is
 *  tracked as a pointer gesture rather than inferred from `selectionBox`
 *  notifies: those batch into one change event alongside `selectedIds`,
 *  so by the time it fires the box is already gone. */
function bindCanvas(notes, st) {
  if (!st || st === boundState) return;
  boundState = st;
  const el = st.canvasEl;
  if (!el) return;
  let dragStart = null;
  el.addEventListener("pointerdown", (e) => {
    if (ownWrite) return;
    // A press on bare canvas drops the sticky selection, exactly as it
    // drops a shape selection — then may become a marquee.
    clearSelection(notes);
    dragStart = st.tool === "select" && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  el.addEventListener("pointerup", (e) => {
    const start = dragStart;
    dragStart = null;
    if (!start) return;
    // A click, not a marquee.
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) return;
    marqueePick(notes, start, { x: e.clientX, y: e.clientY });
  });
}

/** Re-anchor + re-scale every note pinned to the open Desktop. Called on
 *  open and on every `desktop-camera-changed`. */
export function repositionDesktopNotes(notes) {
  const toScreen = typeof window !== "undefined" ? window.__hushDesktopWorldToScreen : null;
  const openId = desktopOpenId();
  if (!toScreen || !openId) return;
  const layer = stickyLayer(notes);
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
  // A Desktop *pane* has no sticky layer of its own — it paints its
  // project's pinned notes straight onto its canvas — and it isn't the
  // active notebook, so the nudge below never reaches it. Broadcast so it
  // can repaint itself.
  document.dispatchEvent(new CustomEvent("desktop-stickies-changed"));
  if (!desktopOpenId()) return;
  const { getActiveNotebookState } = await import("../notebook/notes-canvas.ts");
  getActiveNotebookState()?.notify("interaction");
}

/** Hook the open Desktop's canvas up to sticky selection. Called on
 *  `desktop-opened`; the canvas is rebuilt per open, so this re-binds. */
export async function bindDesktopSelection(notes) {
  if (!desktopOpenId()) return;
  const { getActiveNotebookState } = await import("../notebook/notes-canvas.ts");
  bindCanvas(notes, getActiveNotebookState());
}

/** Notes pinned to a *specific* project's Desktop canvas, in that
 *  canvas's world coordinates. Read live per frame by the renderer so a
 *  nested project's composite thumbnail carries its Desktop's own
 *  stickies — same live-not-baked rule the file badges follow.
 *  (`desktopStickyRows` is the shelf's list for the *open* Desktop; this
 *  one answers for any project, open or not.) */
export function desktopStickiesFor(notes, projectId) {
  if (!projectId) return [];
  const out = [];
  for (const [, n] of notes) {
    if (n.kind !== "desktop" || n.target !== projectId) continue;
    if (typeof n.wx !== "number" || typeof n.wy !== "number") continue;
    out.push({
      text: n.textarea ? n.textarea.value : (n.text || ""),
      wx: n.wx, wy: n.wy, w: n.width || 300, h: n.height || 300,
    });
  }
  return out;
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
