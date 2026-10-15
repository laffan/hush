/**
 * Trimmed reading: holding ⌘ (Ctrl elsewhere) with the pointer over the
 * pages makes their edges grabbable. Dragging one trims that margin off
 * every page; letting go of the key lays the pages out again with the
 * trimmed size as their bounds, so the pages fit the view by what is
 * left and the margins' room goes to the text.
 *
 * Holding the key again shows the pages whole (the trim drawn over them)
 * for the next adjustment — drag an edge back out, or press Reset
 * Reading Crop, which appears while the key is held. The trim applies in
 * every view but the folded one, which shows strips of the pages its own
 * way, and never to the thumbnails. It is kept with the PDF's view
 * (pdf-viewer-view-state.js), on this device, and never touches the file.
 *
 * The hold is read from the key's own keydown / keyup — not the pointer
 * events' modifier flags, which iPadOS doesn't report reliably — and the
 * touch-mode ⌘ pill (cmd-button.js) brackets its hold with synthetic Meta
 * key events, so it works the same way. The key must be held a moment,
 * alone (`HOLD_MS`), so ⌘F, ⌘+ and ⌘-clicks don't flash the whole pages.
 * Since iPadOS can drop ⌘'s key-up (after a system ⌘ shortcut or an app
 * switch), any keydown without ⌘, a window blur or the app going to the
 * background ends the hold.
 *
 * The page wrappers keep their full size, so everything that reads a
 * page's geometry (the text layer, links, search hits, clips, the place
 * kept across a relayout) works unchanged. A trimmed page is drawn
 * clipped (clip-path), and negative margins — sized here, per page —
 * close up the room its trimmed edges would take; matching negative
 * scroll margins make scrolling to a page (and the paged view's
 * snapping) line up what is left. See `.pdf-cropped` in pdf-viewer.css.
 */

/** The platform's primary modifier: ⌘ on a Mac or an iPad. */
const APPLE = typeof navigator !== "undefined" && /Mac|iP(ad|hone|od)/.test(navigator.platform || navigator.userAgent || "");

/** What a trim must leave of the page, each way. */
const MIN_LEFT = 0.25;
/** How near an edge (CSS px) a press grabs it — a finger gets more. */
const GRAB_PX = 14;
const GRAB_TOUCH_PX = 28;
const EDGES = ["t", "r", "b", "l"];
/** ⌘ held this long, alone, starts the adjustment. */
const HOLD_MS = 220;

const NONE = { t: 0, r: 0, b: 0, l: 0 };
const isNone = (c) => !c || c.t + c.r + c.b + c.l < 0.002;

/** A crop from storage, or null when it isn't one. Fractions of the page
 *  trimmed off each edge: `{ t, r, b, l }`. */
export function sanitizeCrop(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  for (const e of EDGES) {
    const v = Number(c[e]);
    if (!Number.isFinite(v) || v < 0 || v > 1 - MIN_LEFT) return null;
    out[e] = v;
  }
  return isNone(out) ? null : out;
}

/** A page's size with the trim taken off. */
export function croppedSize(vp, c) {
  if (!c) return vp;
  return { width: vp.width * (1 - c.l - c.r), height: vp.height * (1 - c.t - c.b) };
}

/** Size a page wrapper's negative margins for the trim (none, `c`
 *  null), from its full CSS size. */
export function cropWrapper(wrapper, cssW, cssH, c) {
  for (const [edge, size] of [["t", cssH], ["r", cssW], ["b", cssH], ["l", cssW]]) {
    if (c) wrapper.style.setProperty(`--cm-${edge}`, `${-Math.round(c[edge] * size)}px`);
    else wrapper.style.removeProperty(`--cm-${edge}`);
  }
}

/**
 * @param {object} env
 * @param {HTMLElement} env.scrollArea
 * @param {HTMLElement} env.host        Where the Reset button goes (over the pages)
 * @param {function} env.getPages       () => pages[]
 * @param {function} env.active         () => boolean — a view the trim applies in
 * @param {object|null} env.initial     The trim to start with
 * @param {function} env.onChange       The trim in effect changed (adjusting began
 *                                      or ended, or reset): lay the pages out again
 */
export function createReadingCrop(env) {
  const { scrollArea } = env;
  let crop = sanitizeCrop(env.initial);
  let editing = false;
  let drag = null; // { edge, wrapper, id }
  let holdTimer = 0;
  /** The key is down; long enough, and alone (not ⌘F and the like). */
  let held = false;
  let holdReady = false;
  // Where the pointer last was: over the pages, or elsewhere (a doc, the
  // shelf). Until it has been anywhere — a PDF opened from the keyboard
  // — it counts as over the pages.
  let pointerInside = true;
  let grabPx = GRAB_PX;
  /** The edge the pointer is over (or dragging), drawn on every page. */
  let hotEdge = null;
  let swallowClick = false;

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "pdf-crop-reset";
  reset.textContent = "Reset Reading Crop";
  reset.style.display = "none";
  env.host.appendChild(reset);

  /** Draw the trim — CSS reads these on every page. */
  function paintVars() {
    const c = crop || NONE;
    for (const e of EDGES) scrollArea.style.setProperty(`--crop-${e}`, String(c[e]));
    reset.style.display = editing && crop ? "" : "none";
  }

  /** The trim drawn over each page while adjusting: the kept part
   *  framed, an edge line and a grip on each side. */
  function addFrames() {
    for (const p of env.getPages()) {
      if (p.wrapper.querySelector(".pdf-crop-frame")) continue;
      const frame = document.createElement("div");
      frame.className = "pdf-crop-frame";
      for (const e of EDGES) {
        const edge = document.createElement("div");
        edge.className = `pdf-crop-edge pdf-crop-edge-${e}`;
        edge.innerHTML = '<span class="pdf-crop-grip"></span>';
        frame.appendChild(edge);
      }
      p.wrapper.appendChild(frame);
    }
    showHot();
  }

  function setHot(edge) {
    if (edge === hotEdge) return;
    hotEdge = edge;
    showHot();
  }
  function showHot() {
    if (hotEdge) scrollArea.dataset.cropEdge = hotEdge;
    else delete scrollArea.dataset.cropEdge;
    scrollArea.classList.toggle("pdf-crop-dragging", !!drag);
    scrollArea.style.cursor = hotEdge ? (hotEdge === "l" || hotEdge === "r" ? "ew-resize" : "ns-resize") : "";
  }

  function startEditing() {
    if (editing || !env.active()) return;
    editing = true;
    scrollArea.classList.add("pdf-crop-editing");
    paintVars();
    env.onChange();
    addFrames();
  }

  function stopEditing() {
    if (!editing) return;
    editing = false;
    drag = null;
    setHot(null);
    showHot();
    scrollArea.classList.remove("pdf-crop-editing");
    scrollArea.querySelectorAll(".pdf-crop-frame").forEach((f) => f.remove());
    if (isNone(crop)) crop = null;
    paintVars();
    env.onChange();
  }

  const isHoldKey = (e) => e.key === (APPLE ? "Meta" : "Control");

  /** Held a moment, alone, over the pages: adjust. (⌘ held over a doc —
   *  to ⌘-click a link there — leaves the pages be.) */
  const maybeStart = () => holdReady && pointerInside && env.active() && startEditing();

  function release() {
    held = false;
    holdReady = false;
    clearTimeout(holdTimer);
    if (!drag) stopEditing();
  }

  function onKeydown(e) {
    if (isHoldKey(e)) {
      if (e.repeat || held) return;
      held = true;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { holdReady = held; maybeStart(); }, HOLD_MS);
      return;
    }
    // A key-up for ⌘ can go missing on iPadOS; a keydown without ⌘
    // proves it's up.
    if (!(APPLE ? e.metaKey : e.ctrlKey)) { release(); return; }
    // ⌘ with another key is a shortcut, not a trim — for the rest of
    // this hold.
    clearTimeout(holdTimer);
    holdReady = false;
    if (editing && !drag) stopEditing();
  }
  function onKeyup(e) {
    if (isHoldKey(e)) release();
  }
  /** Follow the pointer anywhere in the window: over the pages or not. */
  function onWindowPointer(e) {
    const t = e.target;
    pointerInside = t instanceof Node && (scrollArea.contains(t) || reset.contains(t));
    grabPx = e.pointerType === "mouse" ? GRAB_PX : GRAB_TOUCH_PX;
    // No hover on a touch screen: with the key held, the press itself
    // starts the adjustment (and onPointerDown may grab an edge with it).
    if (e.type === "pointerdown" && pointerInside) maybeStart();
  }
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keyup", onKeyup);
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", release);
  window.addEventListener("pointermove", onWindowPointer, true);
  window.addEventListener("pointerdown", onWindowPointer, true);

  /** The trim's edge within reach of a point on a page, if any. */
  function edgeAt(wrapper, x, y) {
    const r = wrapper.getBoundingClientRect();
    const c = crop || NONE;
    const box = {
      l: r.left + c.l * r.width,
      r: r.right - c.r * r.width,
      t: r.top + c.t * r.height,
      b: r.bottom - c.b * r.height,
    };
    const inY = y > box.t - grabPx && y < box.b + grabPx;
    const inX = x > box.l - grabPx && x < box.r + grabPx;
    const near = [];
    if (inY) near.push(["l", Math.abs(x - box.l)], ["r", Math.abs(x - box.r)]);
    if (inX) near.push(["t", Math.abs(y - box.t)], ["b", Math.abs(y - box.b)]);
    const best = near.filter(([, d]) => d <= grabPx).sort((a, b) => a[1] - b[1])[0];
    return best ? best[0] : null;
  }

  const wrapperAt = (target) => (target instanceof Element ? target.closest(".pdf-page-wrapper") : null);

  function onPointerMove(e) {
    if (!editing) { maybeStart(); return; }
    if (drag) {
      if (e.pointerId !== drag.id) return;
      const r = drag.wrapper.getBoundingClientRect();
      const c = crop || NONE;
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const clamp = (v, other) => Math.max(0, Math.min(1 - MIN_LEFT - other, v));
      const next = { ...c };
      if (drag.edge === "l") next.l = clamp(fx, c.r);
      else if (drag.edge === "r") next.r = clamp(1 - fx, c.l);
      else if (drag.edge === "t") next.t = clamp(fy, c.b);
      else next.b = clamp(1 - fy, c.t);
      crop = next;
      paintVars();
      return;
    }
    const w = wrapperAt(e.target);
    setHot(w ? edgeAt(w, e.clientX, e.clientY) : null);
  }

  function onPointerDown(e) {
    if (!editing || e.button !== 0) return;
    const w = wrapperAt(e.target);
    const edge = w ? edgeAt(w, e.clientX, e.clientY) : null;
    // While adjusting, the pages are for adjusting: no selecting text,
    // no clip bookmarks.
    e.preventDefault();
    e.stopPropagation();
    if (!w || !edge) return;
    drag = { edge, wrapper: w, id: e.pointerId };
    setHot(edge);
    showHot();
    try { scrollArea.setPointerCapture(e.pointerId); } catch (_) {}
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    swallowClick = true;
    if (e.pointerType !== "mouse") setHot(null);
    showHot();
    try { scrollArea.releasePointerCapture(e.pointerId); } catch (_) {}
    // The key let go mid-drag: done.
    if (!held) stopEditing();
  }
  scrollArea.addEventListener("pointerleave", () => { if (!drag) setHot(null); });
  // Nor does a press while adjusting reach the pages (a link, a clip, a
  // bookmark stamp) as a click.
  scrollArea.addEventListener("click", (e) => {
    if (!editing && !swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  scrollArea.addEventListener("dblclick", (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  scrollArea.addEventListener("pointermove", onPointerMove);
  scrollArea.addEventListener("pointerdown", onPointerDown, true);
  scrollArea.addEventListener("pointerup", onPointerUp);
  scrollArea.addEventListener("pointercancel", onPointerUp);

  reset.addEventListener("pointerdown", (e) => e.stopPropagation());
  reset.addEventListener("click", () => {
    crop = null;
    paintVars();
  });

  paintVars();

  return {
    /** The trim the layout uses: none while adjusting (the pages show
     *  whole) or in the folded view. */
    effective: () => (crop && !editing && env.active() ? crop : null),
    /** The trim set, to keep with the PDF's view. */
    get: () => (crop ? { ...crop } : null),
    /** Pages were laid out afresh: frame any new ones while adjusting. */
    relaidOut: () => { if (editing) addFrames(); },
    destroy() {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("keyup", onKeyup);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
      window.removeEventListener("pointermove", onWindowPointer, true);
      window.removeEventListener("pointerdown", onWindowPointer, true);
      clearTimeout(holdTimer);
      reset.remove();
    },
  };
}
