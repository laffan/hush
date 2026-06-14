/**
 * Gutter mode — pair a notebook canvas with a project's joined doc buffer as
 * a right-docked sidebar that scrolls in lockstep with the doc.
 *
 * Architecture: the pane is a **right-docked pane** (geometry owned by
 * pane-dock.js — full height, flush right, carving space out of the text
 * column). It does not extend doc-tall and does not move on scroll. Instead
 * the notebook's `camera.y` tracks `-scrollTop`, so shape world-y maps 1:1 to
 * doc-content-y and the canvas shows whatever vertical slice the doc is
 * currently scrolled to.
 *
 * Why not a doc-tall pane? A pane whose DOM matches scrollHeight triggers the
 * stroke engine's re-anchor path on every resize (which fights CodeMirror's
 * incremental line measurement on long docs and drifts) and the engine's
 * coverage logic assumes `cam.y = -scrollTop` for the viewport math to come
 * out right.
 *
 * Only applies inside a Project (the joined buffer is the doc surface) with
 * the active pane backed by a notebook. The assignment + Add/Open/Close flows
 * live in project/gutter-commands.js.
 */
import { panes, activePaneId, appState, GUTTER_Z, TITLEBAR_HEIGHT, zForPane } from "../pane/pane-state.js";
import { stopAttachSync } from "../pane/pane-attach-sync.js";
import { schedulePersist } from "../pane/pane-persistence.js";
import { dockPane, undockPane, applyDockGeometry } from "../pane/pane-dock.js";

/** Read the cm-scroller's vertical padding so the gutter pane can sit
 *  flush against the actual top of the doc text — that way world-y
 *  inside the canvas maps 1:1 to doc-content-y, which keeps the
 *  shadow-header math simple. */
function getScrollerPadding() {
  const scroller = getScroller();
  if (!scroller) return { top: 0, bottom: 0 };
  const cs = getComputedStyle(scroller);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
  };
}

/** The pane context a gutter belongs to. Gutter is now owned by the
 *  .hushproject flow: the project's joined buffer is the doc surface the
 *  gutter notebook pairs with, so the project context wins. A bare doc
 *  context is still recognised so a gutter promoted mid-conversion (or by
 *  legacy persistence) is found by `stopActivePaneAsGutter`. */
export function gutterContext() {
  if (!appState) return "";
  if (appState.currentProjectId) return "pj:" + appState.currentProjectId;
  if (appState.currentFileId) return "doc:" + appState.currentFileId;
  return "";
}

/** Does any pane in the active context already wear the gutter crown?
 *  Only one per project — the gutter is meant as project chrome, not
 *  another stacking surface to manage. */
function docHasGutter() {
  const ctx = gutterContext();
  if (!ctx) return false;
  for (const [, p] of panes) {
    if (p.gutter && p.ownerContext === ctx) return true;
  }
  return false;
}

export function canUseActivePaneAsGutter() {
  // Gutter only lives inside a .hushproject — the joined project buffer is
  // the doc surface the gutter notebook tracks. A standalone doc has to be
  // converted into a project first (see project/gutter-commands.js).
  if (!appState || !appState.currentProjectId) return false;
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || pane.fileType !== "notebook") return false;
  if (pane.gutter) return false;
  if (docHasGutter()) return false;
  return true;
}

export function isActivePaneAGutter() {
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  return !!(pane && pane.gutter);
}

function getScroller() {
  return appState?.editor?.view?.scrollDOM
    || document.querySelector("#editor-container .cm-scroller");
}

/** Walk the doc, return the y position + text + level of every ATX
 *  heading (`#`, `##`, …). y is doc-content-y, which under our gutter
 *  geometry equals world-y in the canvas. Falls back to a line-number
 *  estimate when `lineBlockAt(...).top` returns 0 for non-first lines
 *  — happens on iOS WKWebView when CodeMirror hasn't completed its
 *  first measure pass by the time gutter-enter scans. */
function scanDocHeaders() {
  const view = appState?.editor?.view;
  if (!view) return [];
  const headers = [];
  const doc = view.state.doc;
  // defaultLineHeight is the CM-measured line height in CSS px when
  // available; the empirical fallback covers iOS WKWebView paths where
  // the property is missing. Used to estimate header y when the
  // height-map reports 0 for a non-first line.
  const lineH = (typeof view.defaultLineHeight === "number" && view.defaultLineHeight > 0)
    ? view.defaultLineHeight
    : 22;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(#{1,6})\s+(\S.*)$/);
    if (!m) continue;
    let y = 0;
    try {
      const block = view.lineBlockAt(line.from);
      if (block && typeof block.top === "number") y = block.top;
    } catch (_) { /* fall through to estimate */ }
    // CodeMirror's height-map can lag on iOS — a heading on line N>1
    // reporting top=0 is the diagnostic signal. Estimate from line
    // number so the shadow at least lands close; the next rescan
    // (scroll, resize, or doc-change) replaces it with the real value.
    if (y === 0 && i > 1) y = (i - 1) * lineH;
    headers.push({ y, level: m[1].length, text: m[2] });
  }
  return headers;
}

/** Push the current header snapshot into the notebook state so the
 *  canvas renderer can draw the shadow headers, and rebroadcast the
 *  "camera" notify so the change picks up on the next frame. */
function publishShadowHeaders(pane, headers) {
  if (!pane.notebook || !pane.notebook.state) return;
  pane.notebook.state.shadowHeaders = headers;
  pane.notebook.state.notify("camera");
}

/** Re-align gutter shapes from their per-shape anchor: each shape
 *  stores `{ idx, offset, lastY }` where `idx` is the header it sits
 *  under, `offset` is its world-y relative to that header at anchor
 *  time, and `lastY` is the world-y we last wrote. Anchors are
 *  (re)derived lazily — a shape with no anchor, or whose y has been
 *  changed by the user since lastY (a manual drag), gets re-anchored
 *  to the header it currently sits under before we apply the next
 *  header-driven shift. This avoids the "delta of stale measurements"
 *  drift that a pure diff-based approach suffers when CodeMirror's
 *  lineBlockAt(...).top values refine as the user scrolls. */
function applyAnchors(pane) {
  if (!pane.notebook || !pane.notebook.state) return;
  const headers = pane._gutterHeaders || [];
  if (!headers.length) return;
  let anchors = pane._shapeAnchors;
  if (!anchors) anchors = pane._shapeAnchors = new Map();
  const shapes = pane.notebook.state.shapes;
  let mutated = false;
  for (const s of shapes) {
    // DrawShapes (strokes) carry their geometry in `points[]` rather
    // than a single `position`. Skipping them here is correct AND
    // important — without the guard, the first stroke in the array
    // throws on `s.position.y` and aborts the loop before
    // `publishShadowHeaders` runs, so the gutter sits with empty
    // `shadowHeaders` after every restore that brings strokes back.
    if (!s.position) continue;
    let a = anchors.get(s.id);
    // Re-anchor: no record, or the user moved this shape since our
    // last write (current y != lastY).
    if (!a || a.lastY !== s.position.y) {
      let idx = -1;
      for (let h = 0; h < headers.length; h++) {
        if (headers[h].y <= s.position.y) idx = h; else break;
      }
      if (idx < 0) { anchors.delete(s.id); continue; }
      a = { idx, offset: s.position.y - headers[idx].y, lastY: s.position.y };
      anchors.set(s.id, a);
      continue; // Already at the right y, no mutation
    }
    if (a.idx >= headers.length) continue;
    const newY = headers[a.idx].y + a.offset;
    if (s.position.y !== newY) {
      s.position = { x: s.position.x, y: newY };
      a.lastY = newY;
      mutated = true;
    }
  }
  if (mutated) pane.notebook.state.notify("shapes");
}

/** Rescan headers, push them into the renderer, and reapply anchors so
 *  shape positions track the current header positions. Header-count
 *  change wipes the anchor map so shapes re-attach to whatever section
 *  they're currently in. */
function scanAndSync(pane) {
  if (!pane.gutter || !panes.has(pane.id)) return;
  const next = scanDocHeaders();
  const prev = pane._gutterHeaders;
  pane._gutterHeaders = next;
  if (!prev || prev.length !== next.length) pane._shapeAnchors = null;
  applyAnchors(pane);
  publishShadowHeaders(pane, next);
}

/** rAF-debounced wrapper around scanAndSync so a scroll storm or a
 *  burst of doc-content-changed events all coalesce to one scan per
 *  frame. */
function scheduleSync(pane) {
  if (pane._gutterSyncPending) return;
  pane._gutterSyncPending = true;
  requestAnimationFrame(() => {
    pane._gutterSyncPending = false;
    scanAndSync(pane);
  });
}

/** Recompute the cached alignment offset between the canvas's world-y
 *  origin and doc-content-y. Triggers a `getBoundingClientRect` read so
 *  any pending CodeMirror measure pass flushes — `scanDocHeaders` (which
 *  reads `view.lineBlockAt(...).top`) relies on the height-map being up
 *  to date, and removing that read on every scroll let the shadow
 *  headers go stale because CM hadn't yet measured the lines that
 *  scrolled into view. `paddingTop` is cached on `pane._gutterPadTop`
 *  so we pay just the cheap reflow read, not the expensive
 *  `getComputedStyle` cascade walk. */
function recomputeGutterOffset(pane) {
  if (!pane.notebook || !pane.notebook.state) return;
  const scroller = getScroller();
  if (!scroller) return;
  const scrollerRect = scroller.getBoundingClientRect();
  if (pane._gutterPadTop == null) pane._gutterPadTop = getScrollerPadding().top;
  const docContentTop = scrollerRect.top + pane._gutterPadTop;
  const canvasTop = pane.y + TITLEBAR_HEIGHT;
  pane._gutterOffset = docContentTop - canvasTop;
  pane.notebook.state.gutterCameraOffset = pane._gutterOffset;
}

/** Push the live scrollTop into the notebook's camera.y so the rendered
 *  canvas slice tracks the doc scroll. Camera.x is preserved for
 *  horizontal pan; camera.zoom is locked at 1. We re-read the scroller
 *  rect every scroll (cheap, but flushes pending CM measures) and reuse
 *  the cached `paddingTop` — the `getComputedStyle` call we used to do
 *  per scroll was the slow part. */
function syncCameraFromScroll(pane) {
  if (!pane.notebook || !pane.notebook.state) return;
  const scroller = getScroller();
  if (!scroller) return;
  const scrollerRect = scroller.getBoundingClientRect();
  if (pane._gutterPadTop == null) pane._gutterPadTop = getScrollerPadding().top;
  const docContentTop = scrollerRect.top + pane._gutterPadTop;
  const canvasTop = pane.y + TITLEBAR_HEIGHT;
  pane._gutterOffset = docContentTop - canvasTop;
  const st = pane.notebook.state;
  st.gutterCameraOffset = pane._gutterOffset;
  const x = st.camera.x;
  st.camera = { x, y: pane._gutterOffset - scroller.scrollTop, zoom: 1 };
  st.notify("camera");
}

/** Drop the cached padding-top so the next sync re-reads it. Called on
 *  resize and on geometry changes where the doc layout might have
 *  shifted the cm-scroller's padding. */
function invalidateGutterPadCache(pane) {
  pane._gutterPadTop = null;
}

function startGutterSync(pane) {
  const scroller = getScroller();
  if (!scroller) return;
  // Scroll → resync, rAF-throttled. Without throttling, every scroll
  // event drives `syncCameraFromScroll` (rect read + camera notify +
  // potential drawing-layer re-anchor / rebake). On a doc with many
  // strokes, the re-anchor's `fullRebake()` is O(N strokes) and shows
  // up as jank during fast scrolls. Coalescing to one sync per animation
  // frame caps the work at 60 fps and lets the browser's scroll
  // compositing carry the visual gap of the in-between frames — the
  // user sees the canvas catch up on the next frame at worst. We also
  // bail when scrollTop hasn't moved since the last sync, so the iOS
  // rubber-band's tail-end of zero-delta scroll events doesn't redo
  // the work for free.
  let scrollSyncPending = false;
  let lastSyncedScrollTop = -1;
  pane._gutterScrollHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    if (scrollSyncPending) return;
    scrollSyncPending = true;
    requestAnimationFrame(() => {
      scrollSyncPending = false;
      if (!pane.gutter || !panes.has(pane.id)) return;
      const st = scroller.scrollTop;
      if (st === lastSyncedScrollTop) return;
      lastSyncedScrollTop = st;
      syncCameraFromScroll(pane);
      scheduleSync(pane);
    });
  };
  scroller.addEventListener("scroll", pane._gutterScrollHandler, { passive: true });
  pane._gutterWindowHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    // Re-flex the docked box, then re-derive the camera offset against the
    // new geometry. (The dock module also re-flexes on resize; doing it here
    // too keeps the camera resync ordered after the geometry settles.)
    applyDockGeometry(pane);
    invalidateGutterPadCache(pane);
    recomputeGutterOffset(pane);
    syncCameraFromScroll(pane);
    scheduleSync(pane);
  };
  window.addEventListener("resize", pane._gutterWindowHandler);
  pane._gutterDocChangeHandler = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    // Typewriter / sticky-header plugins can mutate the cm-scroller's
    // padding on doc changes — drop the cached value so the next sync
    // picks up the fresh padding.
    invalidateGutterPadCache(pane);
    scheduleSync(pane);
  };
  appState.on("doc-content-changed", pane._gutterDocChangeHandler);
}

function stopGutterSync(pane) {
  if (pane._gutterScrollHandler) {
    const scroller = getScroller();
    if (scroller) scroller.removeEventListener("scroll", pane._gutterScrollHandler);
    pane._gutterScrollHandler = null;
  }
  if (pane._gutterWindowHandler) {
    window.removeEventListener("resize", pane._gutterWindowHandler);
    pane._gutterWindowHandler = null;
  }
  if (pane._gutterDocChangeHandler) {
    appState?.off?.("doc-content-changed", pane._gutterDocChangeHandler);
    pane._gutterDocChangeHandler = null;
  }
}

export function useActivePaneAsGutter() {
  if (!canUseActivePaneAsGutter()) return false;
  const pane = panes.get(activePaneId);
  if (!pane || !pane.el) return false;

  if (pane.attached) {
    pane.attached = false;
    stopAttachSync(pane);
    const aBtn = pane.el.querySelector(".fp-btn-attach");
    if (aBtn) aBtn.classList.remove("attach-active");
  }
  if (pane.collapsed) {
    pane.collapsed = false;
    pane.el.classList.remove("collapsed");
  }

  pane._gutterPrev = {
    width: pane.width,
    height: pane.height,
    x: pane.x,
    y: pane.y,
    camera: pane.notebook?.state ? { ...pane.notebook.state.camera } : null,
  };

  // The gutter is a right-docked pane: it carves real estate out of the doc
  // text column (which shrinks from the right) rather than floating over it.
  // Side is always "right".
  pane.gutter = true;
  pane.gutterSide = "right";
  pane.el.classList.add("gutter", "gutter-right");
  pane.el.classList.remove("gutter-left");
  pane.el.style.zIndex = GUTTER_Z;

  // Point the notebook at the host doc's scroller — wheel / pan /
  // focusShape redirect through this flag. Camera.y is driven by
  // syncCameraFromScroll on every scroll tick.
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = getScroller();
  }

  // Start the gutter with its canvas toolbar out of the way — docked left
  // and minimized — so the narrow gutter isn't crowded. This only runs on
  // initialization (restore uses restoreGutterLayout, not this path), so a
  // user who later reopens the toolbar keeps it open for the session. Best
  // effort now, retried once the canvas has mounted.
  const initGutterToolbar = () => {
    const st = pane.notebook?.state;
    if (!st) return false;
    st.setDrawingToolbarPosition?.("left");
    st.setDrawingToolbarMinimized?.(true);
    return true;
  };
  if (!initGutterToolbar()) {
    setTimeout(initGutterToolbar, 300);
    setTimeout(initGutterToolbar, 1000);
  }

  // Dock geometry owns the pane's box (full height, flush right, doc column
  // shrinks); the scroll-driven camera below maps canvas world-y to
  // doc-content-y on top of that.
  dockPane(pane, "right");
  recomputeGutterOffset(pane);
  syncCameraFromScroll(pane);
  startGutterSync(pane);
  // Defer the first scan one frame so CodeMirror has measured line
  // positions. scheduleSync handles the rAF batching.
  scheduleSync(pane);
  // Two extra retries — on iOS WKWebView the editor's first measure
  // pass can land well after the gutter-enter rAF, so the first scan
  // sees zeros for off-screen headers. These backups land after the
  // pane / canvas / WebView paint has settled.
  setTimeout(() => { if (pane.gutter && panes.has(pane.id)) scanAndSync(pane); }, 250);
  setTimeout(() => { if (pane.gutter && panes.has(pane.id)) scanAndSync(pane); }, 1000);
  import("../pane/pane-toolbar.js").then((m) => m.syncGutterButton(pane));

  // Record the pairing on the project so it rides the .hushproject envelope,
  // regardless of which entry point promoted the pane (Add Gutter, Add
  // notebook as gutter, or Open Gutter).
  if (appState?.currentProjectId && pane.fileId && typeof appState.markProjectGutterNotebook === "function") {
    appState.markProjectGutterNotebook(appState.currentProjectId, pane.fileId);
  }

  schedulePersist();
  return true;
}

export function stopActivePaneAsGutter() {
  if (!activePaneId) return false;
  const pane = panes.get(activePaneId);
  if (!pane || !pane.gutter || !pane.el) return false;

  stopGutterSync(pane);

  const prev = pane._gutterPrev || {};
  pane.gutter = false;
  pane.gutterSide = null;
  pane._gutterPrev = null;
  pane.el.classList.remove("gutter", "gutter-left", "gutter-right");

  // Undock back to the pre-gutter floating geometry (dockPane snapshotted it
  // in pane._dockPrev when the gutter was promoted).
  undockPane(pane);
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
    pane.notebook.state.gutterCameraOffset = 0;
    pane.notebook.state.shadowHeaders = [];
    if (prev.camera) pane.notebook.state.camera = { ...prev.camera };
    pane.notebook.state.notify("camera");
  }
  pane._gutterHeaders = null;
  pane._shapeAnchors = null;
  pane.el.style.zIndex = zForPane(pane);
  import("../pane/pane-toolbar.js").then((m) => m.syncGutterButton(pane));

  // NOTE: the project's gutter *assignment* (the notebook child's `gutter`
  // marker) is intentionally kept here — demoting / closing the pane doesn't
  // unpair the gutter, so "Open Gutter" can re-open it later. The marker is
  // only cleared by Convert to Folder (full dissolution).

  schedulePersist();
  return true;
}

export function restoreGutterLayout(pane) {
  if (!pane || !pane.gutter || !pane.el) return;
  pane.gutterSide = "right";
  pane.el.classList.add("gutter", "gutter-right");
  pane.el.classList.remove("gutter-left");
  pane.el.style.zIndex = GUTTER_Z;
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = getScroller();
  }
  // Re-dock to the right (persistence stored docked/dockEdge, but a gutter
  // owns its own re-dock so the camera resync below stays ordered after it).
  dockPane(pane, "right");
  recomputeGutterOffset(pane);
  syncCameraFromScroll(pane);
  if (!pane._gutterScrollHandler) startGutterSync(pane);
  scheduleSync(pane);
  // On restore the editor's scrollDOM rect can still be settling when
  // the synchronous setup above runs — `recomputeGutterOffset` then
  // caches an offset against a half-laid-out scroller, and the camera
  // gets seeded at the wrong y. By the next frame the rect is correct
  // but nothing in the steady-state path re-derives the offset until
  // the user scrolls. The retries re-run both halves (camera resync +
  // header rescan) so layout settles into the right state without any
  // user gesture. Three checkpoints catch the WKWebView measure pass
  // landing late on iOS too.
  const resync = () => {
    if (!pane.gutter || !panes.has(pane.id)) return;
    invalidateGutterPadCache(pane);
    recomputeGutterOffset(pane);
    syncCameraFromScroll(pane);
    scanAndSync(pane);
  };
  setTimeout(resync, 100);
  setTimeout(resync, 500);
  setTimeout(resync, 1500);
  import("../pane/pane-toolbar.js").then((m) => m.syncGutterButton(pane));
}

export function teardownGutterListeners(pane) {
  if (!pane) return;
  if (pane._gutterScrollHandler) stopGutterSync(pane);
  pane._shapeAnchors = null;
  pane._gutterHeaders = null;
  if (pane.notebook && pane.notebook.state) {
    pane.notebook.state.gutterScrollDOM = null;
    pane.notebook.state.gutterCameraOffset = 0;
    pane.notebook.state.shadowHeaders = [];
  }
}
