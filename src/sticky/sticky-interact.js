/**
 * Sticky-note pointer interactions — header drag + 8-direction resize.
 * Split out of sticky-notes.js for the 700-line cap. Both helpers take
 * a `hooks` object so the note registry, persistence, and Desktop
 * repaint stay owned by sticky-notes.js:
 *   { activate(note), persist(), repaintDesktop() }
 */
import { clampSize, desktopZoom } from "./sticky-shared.js";

export function setupDrag(note, titlebar, hooks) {
  titlebar.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".sticky-note-btn")) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startLeft = note.x, startTop = note.y;
    titlebar.setPointerCapture(e.pointerId);
    const onMove = (me) => {
      note.x = startLeft + (me.clientX - startX);
      note.y = startTop + (me.clientY - startY);
      note.el.style.left = note.x + "px";
      note.el.style.top = note.y + "px";
    };
    const onUp = () => {
      titlebar.removeEventListener("pointermove", onMove);
      titlebar.removeEventListener("pointerup", onUp);
      // Desktop-pinned notes store their position in canvas world
      // coordinates — write the drop point back through the camera.
      if (note.kind === "desktop") {
        const toWorld = window.__hushDesktopScreenToWorld;
        const w = toWorld ? toWorld({ x: note.x, y: note.y }) : null;
        if (w) { note.wx = w.x; note.wy = w.y; }
        hooks.repaintDesktop(); // it moved on any pane painting this Desktop
      }
      hooks.persist();
    };
    titlebar.addEventListener("pointermove", onMove);
    titlebar.addEventListener("pointerup", onUp);
  });
}

export function setupResize(note, hooks) {
  for (const handle of note.el.querySelectorAll(".sn-resize")) {
    handle.addEventListener("pointerdown", (e) => {
      if (note.collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      hooks.activate(note);
      const dir = handle.dataset.dir;
      const startX = e.clientX, startY = e.clientY;
      const startW = note.width, startH = note.height;
      const startLeft = note.x, startTop = note.y;
      // A desktop-pinned note is drawn scaled, so a pointer travel of N
      // screen px is only N/zoom of its own (unscaled) size — and when a
      // w/n handle shrinks it, its top-left slides by the *scaled* delta.
      const z = note.kind === "desktop" ? desktopZoom() : 1;
      handle.setPointerCapture(e.pointerId);
      const onMove = (me) => {
        const dx = (me.clientX - startX) / z;
        const dy = (me.clientY - startY) / z;
        let w = startW, h = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) w = clampSize(startW + dx);
        if (dir.includes("w")) { w = clampSize(startW - dx); nx = startLeft + (startW - w) * z; }
        if (dir.includes("s")) h = clampSize(startH + dy);
        if (dir.includes("n")) { h = clampSize(startH - dy); ny = startTop + (startH - h) * z; }
        note.width = w; note.height = h; note.x = nx; note.y = ny;
        Object.assign(note.el.style, { width: w + "px", height: h + "px", left: nx + "px", top: ny + "px" });
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        // A w/n handle moves the origin, so re-derive the world anchor —
        // otherwise the next camera change snaps the note back.
        if (note.kind === "desktop") {
          const w = window.__hushDesktopScreenToWorld?.({ x: note.x, y: note.y });
          if (w) { note.wx = w.x; note.wy = w.y; }
          hooks.repaintDesktop(); // it resized on any pane painting this Desktop
        }
        hooks.persist();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }
}
