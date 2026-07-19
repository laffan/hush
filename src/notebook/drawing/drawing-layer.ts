/* src/notebook/drawing/drawing-layer.ts
 *
 * Engine-backed drawing layer for Hush notebooks. Mounts the reference
 * stroke engine (`engine/stroke.js`) inside a CSS-transformed wrapper
 * so pan + zoom-out are GPU composites, and bridges the engine's
 * stroke data to Hush's `state.shapes[]` via the sync shim.
 *
 * This is step 4 of the integration. It doesn't wire a drawing-mode
 * UI — that's step 5+. For now the layer:
 *   - mounts stage DOM alongside the notebook canvas,
 *   - renders any DrawShapes that arrive via state.shapes[],
 *   - exposes setCamera / setTheme / setInputEnabled hooks for the
 *     future drawing-mode UI to call,
 *   - keeps the engine's pointer handling wired but non-capturing
 *     (SVG pointer-events:none until drawing mode turns it on).
 *
 * The engine module is plain JS; we import by path and describe its
 * factory return structurally where needed.
 */

import type { Camera, DrawingSlot } from "../types";
import type { CanvasTheme } from "../themes";
import { canvasToScreen, screenToCanvas } from "../utils";
import { createStrokeEngine } from "./engine/stroke.js";
import { createSelectionEngine } from "./engine/selection.js";
import { createGestures } from "./engine/gestures.js";
import { createSyncShim } from "./sync-shim";
import type { EngineAdapter, EngineStroke, ShimState } from "./sync-shim";
import { brushUrl } from "./brush-urls";
import { createDrawingDom } from "./drawing-layer-dom";
import { createSelectionStyleSession } from "./selection-style";
import { createSelectionBridge } from "./selection-bridge";
import type { DrawingLayer, EngineTool, SelectionStyleEntry, SelectionStylePatch } from "./drawing-layer-types";
import { createPocketBlit } from "./pocket-blit";
import { createSelectionDragController } from "./selection-drag";
import { createReanchor, WORLD_SIZE_MIN } from "./re-anchor";
import type { AnchorState } from "./re-anchor";

// Re-export so callers that imported these from drawing-layer.ts keep working.
export type { DrawingLayer, SelectionStyleEntry, SelectionStylePatch };


/** Per-canvas memory cap. 4096×4096 = 16 MP. iPad-safe across the
 *  range; beyond it the backing DPR degrades rather than the canvas
 *  blowing up its context. The re-anchor controller (`re-anchor.ts`)
 *  picks worldSize relative to the camera; DPR follows from this cap.
 *  (A round-4C experiment halved this to 2896²: re-anchor stalls
 *  halved with the pixels, but full-surface ops kept a ~240 ms floor
 *  and the felt pan didn't improve — reverted; see NOTEBOOK-PERF.md.) */
const MAX_BACKING_PIXELS = 4096 * 4096;
const MAX_DPR = 2;

// Brush-runtime helpers (slot colour resolution, applySlot, renderSwatch,
// theme-retint) live in `brush-runtime.ts` so this file stays under the
// 700-line cap.
import { applySlotToEngine, renderSwatchToCanvas, renderDemoStrokeToCanvas, applyThemeAndRetint } from "./brush-runtime";


/** Construction options. `state` is Hush's DrawingState (kept
 *  structural to avoid a circular import). */
export function createDrawingLayer({
  container,
  state,
  theme,
  camera,
  onTouchPanStart,
  onTouchPanMove,
  onTouchPanEnd,
  onTouchPinchStart,
  onTouchPinchMove,
  onTouchPinchEnd,
}: {
  container: HTMLElement;
  state: ShimState;
  theme: CanvasTheme;
  camera: Camera;
  /** Two-finger pan hooks — fired by the engine's gesture recogniser
   *  when the user drags two fingers inside the drawing surface. The
   *  notebook wires these into `state.camera` so iPad users can pan
   *  while a brush or eraser is active. */
  onTouchPanStart?: () => void;
  onTouchPanMove?: (dx: number, dy: number) => void;
  onTouchPanEnd?: () => void;
  /** Two-finger pinch hooks — fired alongside the pan hooks when the
   *  user spreads / squeezes / twists two fingers. Notebook drives the
   *  camera zoom (and opt-in rotation) from these. mid + dist are in
   *  client (screen) px; angle is the finger-pair angle in radians. */
  onTouchPinchStart?: (mid: { x: number; y: number }, dist: number, angle: number) => void;
  onTouchPinchMove?: (mid: { x: number; y: number }, dist: number, angle: number) => void;
  onTouchPinchEnd?: () => void;
}): DrawingLayer {
  // Mutable theme object: we mutate in place on setTheme so the
  // engine's atlas cache and our resolveAutoColor closure pick up new
  // values without reallocating.
  const themeRef = { ...theme };

  // ---------- DOM: transform wrapper + engine stage ----------

  // World-space anchor + size of the canvas backing. Initial values
  // come from the DOM factory (centered on the current viewport at
  // WORLD_SIZE_MIN); both shift over the lifetime of the layer as
  // the re-anchor controller follows the camera. Held in a single
  // mutable record so every closure reading origin / worldSize sees
  // the live values without indirection through individual getters.
  const dom = createDrawingDom(container, WORLD_SIZE_MIN);
  const {
    wrapper, doneCanvas, previewCanvas, liveCanvas, blitHelper,
    pocketStash, pocketStashCtx,
    svg, eraserCursor, selectionLayer, selectHint,
  } = dom;
  const anchor: AnchorState = {
    originX: dom.originX,
    originY: dom.originY,
    worldSize: WORLD_SIZE_MIN,
  };

  // Tracks the sub-tool the user was on before the long-press handoff
  // promoted them into select mode. Restored when the lasso misses or
  // the user taps away to deselect — mirrors the reference demo's
  // `transientSelect` flag. Null when no transient select is active
  // (e.g. the user reached select mode via the main toolbar Lasso
  // button, in which case we don't want to auto-exit on deselect).
  let transientPrevSubTool: "draw" | "erase" | "slice" | null = null;
  function restoreFromTransientSelect(): void {
    if (!transientPrevSubTool) return;
    const prev = transientPrevSubTool;
    transientPrevSubTool = null;
    if (state.drawingSubTool === "select") state.setDrawingSubTool(prev);
  }

  let selectHintTimer: ReturnType<typeof setTimeout> | null = null;
  function flashSelectHint(localPt: { x: number; y: number }): void {
    // engine-local → container-screen coords: reverse of pointToLocal.
    const { x: cx, y: cy } = canvasToScreen(
      { x: localPt.x + anchor.originX, y: localPt.y + anchor.originY }, cameraRef);
    // Small gap so the pill doesn't overlap the cursor anchor.
    selectHint.style.left = (cx - 10) + "px";
    selectHint.style.top = cy + "px";
    selectHint.style.opacity = "1";
    if (selectHintTimer) clearTimeout(selectHintTimer);
    selectHintTimer = setTimeout(() => {
      selectHint.style.opacity = "0";
    }, 900);
  }

  // ---------- camera + transforms ----------

  const cameraRef: Camera = { x: camera.x, y: camera.y, zoom: camera.zoom, rotation: camera.rotation };

  function currentDpr(): number {
    const native = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const maxFit = Math.sqrt(MAX_BACKING_PIXELS / (anchor.worldSize * anchor.worldSize));
    return Math.min(native, maxFit);
  }

  // Pocket / done-canvas blit helpers live in pocket-blit.ts. Origin,
  // worldSize, and DPR are read via getters every call — the layer
  // re-anchors mid-session so any of these can shift between calls.
  // Created up here so the sync-shim's `engineAdapter` (further down)
  // can wire stash / unstash directly into the pocket pipeline.
  const { blitWorldRegion, blitDoneCanvasAtWorldOrigin, stashPocketRegion, unstashPocketRegion } = createPocketBlit({
    // Per-call resolve — delta #31 swaps the done role each re-anchor.
    getDoneCanvas: () => (strokeEngine ? strokeEngine.getDoneCanvas() : doneCanvas),
    pocketStash, pocketStashCtx,
    getOriginX: () => anchor.originX,
    getOriginY: () => anchor.originY,
    getWorldSize: () => anchor.worldSize,
    getDpr: currentDpr,
  });

  function pointToLocal(clientPt: { x: number; y: number }): { x: number; y: number } {
    const rect = container.getBoundingClientRect();
    // screenToCanvas handles the camera's optional rotation; local
    // coords are world coords shifted by the wrapper's anchor origin.
    const world = screenToCanvas({ x: clientPt.x - rect.left, y: clientPt.y - rect.top }, cameraRef);
    return { x: world.x - anchor.originX, y: world.y - anchor.originY };
  }

  function applyWrapperTransform(cam: Camera): void {
    // translate(camera) · rotate · scale(zoom) · translate(origin) —
    // matches canvasToScreen: screen = c + R·(zoom·world). rotate(0)
    // is a no-op so the unrotated case is unchanged.
    wrapper.style.transform =
      `translate(${cam.x}px, ${cam.y}px) rotate(${cam.rotation || 0}rad) ` +
      `scale(${cam.zoom}) translate(${anchor.originX}px, ${anchor.originY}px)`;
  }

  function setCamera(next: Camera): void {
    cameraRef.x = next.x;
    cameraRef.y = next.y;
    cameraRef.zoom = next.zoom;
    cameraRef.rotation = next.rotation;
    // Hot path on every pan/zoom frame: see whether the camera
    // viewport is still well inside the canvas backing. If yes, just
    // update the wrapper's CSS transform — GPU-composited and free.
    // If the viewport is drifting toward the canvas edge (or the
    // zoom level wants a different canvas size), re-anchor first.
    ensureCoverage(next);
    applyWrapperTransform(next);
  }
  // Apply the initial camera transform directly. ensureCoverage()
  // can't run yet because the stroke engine isn't constructed; the
  // first proper setCamera (or resize-driven re-anchor) takes care
  // of any drift once everything is wired.
  applyWrapperTransform(camera);

  // ---------- engine ----------

  // Forward-ref so onStrokeAdded can reach the shim, which is
  // constructed after the engine (since the shim needs the engine).
  const shimBox: { current: ReturnType<typeof createSyncShim> | null } = { current: null };
  // Same pattern for the selection engine — the stroke engine's
  // onLongPress handoff calls into it to promote a held stroke into
  // a lasso, but selection engine needs the stroke engine first.
  const selectionBox: { current: ReturnType<typeof createSelectionEngine> | null } = { current: null };

  const strokeEngine = createStrokeEngine({
    svg,
    doneCanvas,
    previewCanvas,
    liveCanvas,
    eraserCursor,
    getRect: () => svg.getBoundingClientRect(),
    pointToLocal,
    getDpr: currentDpr,
    brushUrl,
    blitCanvas: blitHelper,
    onLongPress: ({ pointerId, point }) => {
      // 1.5s hold with no drift promotes the in-flight stroke into a
      // lasso — the user's "I want to select what I just drew" gesture.
      // Without this hook the engine just cancels the active stroke.
      //
      // Flip the sub-tool to "select" so the stroke engine stops
      // accepting pointerdowns as draws while the selection is live —
      // otherwise tapping inside the bbox both moves the selection AND
      // starts a new stroke. The previous sub-tool is saved so we can
      // restore it when the user deselects (lasso misses, or tap-away).
      if (state.drawingSubTool !== "select") {
        transientPrevSubTool = state.drawingSubTool as "draw" | "erase" | "slice";
        state.setDrawingSubTool("select");
      }
      const sel = selectionBox.current;
      if (sel) sel.startLassoAtPointer(pointerId, point);
      flashSelectHint(point);
    },
    onStrokeAdded: (stroke: EngineStroke, _index: number) => {
      const shim = shimBox.current;
      if (!shim) return;
      // Skip during shim-driven sync (state→engine reflections of an
      // undo/redo or external mutation). Recording would clobber the
      // redo stack and double-up the snapshot the user just stepped
      // away from.
      if (shim.isDiffing()) return;
      shim.onEngineStrokeAdded(stroke);
      state.recordHistory();
    },
    onStrokesRemoved: (removed: { stroke: EngineStroke; index: number }[]) => {
      const shim = shimBox.current;
      if (!shim) return;
      if (shim.isDiffing()) {
        // Still refresh the engine selection's bbox so handles drop
        // when the strokes underneath them disappear.
        const sel = selectionBox.current;
        if (sel) sel.refreshBBox();
        return;
      }
      shim.onEngineStrokesRemoved(removed.map((r) => r.stroke.id));
      // Engine selection's bbox can outlive the strokes it points at
      // (Hush's trash, Delete shortcut, etc.). Recompute against the
      // current strokes list so handles drop when their target's gone.
      const sel = selectionBox.current;
      if (sel) sel.refreshBBox();
      state.recordHistory();
    },
    onStrokesTransformed: (entries: { id: number; before: EngineStroke["points"]; after: EngineStroke["points"] }[]) => {
      const shim = shimBox.current;
      if (!shim) return;
      if (shim.isDiffing()) return;
      shim.onEngineStrokesTransformed(entries.map((e) => e.id));
      state.recordHistory();
    },
    onStrokesSliced: ({ removed, added }: {
      removed: { stroke: EngineStroke; originalIndex: number }[];
      added: { stroke: EngineStroke; finalIndex: number }[];
    }) => {
      const shim = shimBox.current;
      if (!shim) return;
      if (shim.isDiffing()) return;
      shim.onEngineStrokesRemoved(removed.map((x) => x.stroke.id));
      for (const x of added) shim.onEngineStrokeAdded(x.stroke);
      state.recordHistory();
    },
  });

  // ---------- selection engine + gestures ----------

  const selectionEngine = createSelectionEngine({
    svg,
    layer: selectionLayer,
    getRect: () => svg.getBoundingClientRect(),
    pointToLocal,
    strokeEngine,
    isSelectable: (s: EngineStroke) => {
      const L = strokeEngine.getLayerById(s.layerId);
      return !!L && !L.locked && !L.hidden;
    },
    onExit: () => {
      // Escape pressed — selection engine already cleared itself.
      // Mirror into Hush's state.selectedIds so anything that reads
      // hush selection (selection toolbar, Cmd+G group, Delete, etc.)
      // sees the same state.
      bridgeEngineSelectionToState();
      restoreFromTransientSelect();
    },
    onLassoComplete: ({ selected }) => {
      if (selected) expandSelectionToGroups();
      // Bridge regardless — a lasso that hits nothing clears engine
      // selection; we want state.selectedIds to track.
      bridgeEngineSelectionToState();
      // A miss (tap on empty canvas, or a drag that found nothing)
      // should drop us back into the previous sub-tool so the user
      // can keep drawing without going through the main toolbar.
      if (!selected) restoreFromTransientSelect();
    },
    onSelectionDeleted: () => {
      // engine.removeStrokes fires its own onStrokesRemoved callback,
      // which pushes to history + removes from state.shapes. Also
      // clear state.selectedIds so Hush's selection toolbar hides.
      bridgeEngineSelectionToState();
      restoreFromTransientSelect();
    },
    // Engine-driven drag (pen-mode bbox grab). Hide Hush's gray
    // group highlight + selection toolbar for the duration so the
    // engine's bbox + handles are the only chrome moving — both
    // reappear at the committed position on release. Avoids the
    // "two boxes lagging" feel when one tracks and the other
    // doesn't.
    onDragStart: () => {
      if (state.strokeEngineDragging) return;
      state.strokeEngineDragging = true;
      state.notify("strokeEngineDragging");
    },
    onDragEnd: () => {
      if (!state.strokeEngineDragging) return;
      state.strokeEngineDragging = false;
      state.notify("strokeEngineDragging");
    },
  });

  /** Mirror the drawing engine's current selected ids into Hush's
   *  state.selectedIds. Called on every engine-driven selection
   *  change (lasso complete, Escape, delete). Keeps Cmd+G, the
   *  selection toolbar, drag-in-box selector, and hush-level move /
   *  delete all consistent for drawing-mode selections.
   *
   *  Note this is one-way: engine → state. The reverse (state →
   *  engine) isn't wired because Hush's select tool runs outside
   *  drawing mode, and the engine's selection isn't active there. */
  function bridgeEngineSelectionToState(): void {
    const engineIds = selectionEngine.getSelectedIds();
    const hushIds = new Set<string>();
    for (const eid of engineIds) {
      const hid = shimBox.current?.getHushStrokeId(eid);
      if (hid) hushIds.add(hid);
    }
    // Skip if the set hasn't changed — avoids a render flap when
    // selection-preserving ops fire this callback.
    if (sameStringSet(hushIds, state.selectedIds)) return;
    state.selectedIds = hushIds;
    state.notify("selectedIds");
  }

  function sameStringSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  selectionBox.current = selectionEngine;

  // If the user manually changes the sub-tool (brush slot, Erase, Slice,
  // or the main toolbar's Pen/Lasso), clear the transient flag so we
  // don't later "restore" them to a stale prior sub-tool on deselect.
  const onSubToolChangeForTransient = ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (!keys.includes("drawingSubTool")) return;
    if (state.drawingSubTool !== "select") transientPrevSubTool = null;
  }) as EventListener;
  state.addEventListener("change", onSubToolChangeForTransient);

  // Two/three-finger touch → undo/redo on iPad. Two-finger drift
  // promotes the burst into a pan — forwarded up to the notebook so
  // state.camera picks up the motion.
  createGestures({
    getRect: () => svg.getBoundingClientRect(),
    pointToLocal,
    strokeEngine,
    selectionEngine,
    onUndo: () => state.undo(),
    onRedo: () => state.redo(),
    onPanStart: () => { onTouchPanStart && onTouchPanStart(); },
    onPanMove: (dx: number, dy: number) => { onTouchPanMove && onTouchPanMove(dx, dy); },
    onPanEnd: () => { onTouchPanEnd && onTouchPanEnd(); },
    onPinchStart: (mid: { x: number; y: number }, dist: number, angle: number) => { onTouchPinchStart && onTouchPinchStart(mid, dist, angle); },
    onPinchMove: (mid: { x: number; y: number }, dist: number, angle: number) => { onTouchPinchMove && onTouchPinchMove(mid, dist, angle); },
    onPinchEnd: () => { onTouchPinchEnd && onTouchPinchEnd(); },
  });

  /** Pull every stroke that shares a group with any currently-selected
   *  stroke into the selection. Keeps move/resize/delete/style ops
   *  hitting the whole group without engine-level awareness. */
  function expandSelectionToGroups(): void {
    const ids = selectionEngine.getSelectedIds();
    if (!ids.size) return;
    const groups = new Set<string>();
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (ids.has(s.id) && s.groupId) groups.add(s.groupId);
    }
    if (!groups.size) return;
    let added = false;
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (s.groupId && groups.has(s.groupId) && !ids.has(s.id)) {
        ids.add(s.id);
        added = true;
      }
    }
    if (added) selectionEngine.refreshBBox();
  }

  // ---------- canvas sizing + re-anchoring ----------

  function sizeCanvases(): void {
    const dpr = currentDpr();
    const w = anchor.worldSize;
    const px = Math.round(w * dpr);
    for (const c of [doneCanvas, previewCanvas, liveCanvas, blitHelper]) {
      // Mirror engine delta #27: skip the backing write when unchanged
      // (re-assigning identical dimensions clears + can reallocate).
      if (c.width !== px) c.width = px;
      if (c.height !== px) c.height = px;
      c.style.left = "0px";
      c.style.top = "0px";
      c.style.width = w + "px";
      c.style.height = w + "px";
    }
    wrapper.style.width = w + "px";
    wrapper.style.height = w + "px";
    svg.setAttribute("viewBox", `0 0 ${w} ${w}`);
    svg.style.width = w + "px";
    svg.style.height = w + "px";
    if (pocketStash.width !== px || pocketStash.height !== px) {
      pocketStash.width = px;
      pocketStash.height = px;
    }
  }
  sizeCanvases();
  strokeEngine.resize(anchor.worldSize, anchor.worldSize);

  // Re-anchor controller (`re-anchor.ts`): on every camera change,
  // checks whether the visible viewport is still well inside the
  // canvas backing. Cheap fast-path return when it is; otherwise
  // shifts origin, scales the canvas to the current zoom, translates
  // every stroke by the origin delta, and rebakes. The mutable
  // `anchor` record is shared with the layer's other closures so a
  // re-anchor's mutation propagates without re-binding callbacks.
  const reanchorCtl = createReanchor({
    anchor,
    strokeEngine: strokeEngine as unknown as Parameters<typeof createReanchor>[0]["strokeEngine"],
    refreshSelectionBBox: () => selectionEngine.refreshBBox(),
    pocketStash, pocketStashCtx,
    sizeCanvases,
    getDpr: currentDpr,
  });
  function ensureCoverage(cam: Camera): void { reanchorCtl.ensureCoverage(cam); }

  // ---------- sync shim ----------
  //
  // `resolveAutoColor` reads from the mutable themeRef so theme
  // changes flow into newly-created strokes immediately.
  const engineAdapter: EngineAdapter = {
    getStrokes: () => strokeEngine.getStrokes() as EngineStroke[],
    insertStrokeAt: (stroke, index, opts) => strokeEngine.insertStrokeAt(stroke, index, opts),
    removeStrokes: (ids) => strokeEngine.removeStrokes(ids as number[]),
    setStrokesStyleMap: (m) => strokeEngine.setStrokesStyleMap(m as Map<number, object>),
    setStrokePoints: (id, points) => strokeEngine.setStrokePoints(id, points),
    fullRebake: () => strokeEngine.fullRebake(),
    getActiveLayerId: () => strokeEngine.getActiveLayerId(),
    setActiveLayer: (id) => strokeEngine.setActiveLayer(id),
    getLayerById: (id) => strokeEngine.getLayerById(id),
    getLayers: () => strokeEngine.getLayers(),
    createLayer: (opts) => strokeEngine.createLayer(opts),
    deleteLayer: (id) => strokeEngine.deleteLayer(id),
    renameLayer: (id, name) => strokeEngine.renameLayer(id, name),
    setLayerLocked: (id, locked) => strokeEngine.setLayerLocked(id, locked),
    setLayerHidden: (id, hidden) => strokeEngine.setLayerHidden(id, hidden),
    moveLayer: (from, to) => strokeEngine.moveLayer(from, to),
    stashPocketRegion,
    unstashPocketRegion,
    // Bulk replaces skip the incremental pocket stash/unstash dance,
    // so the shim repaints pocketed strokes into the stash wholesale
    // afterwards (same rebuild a re-anchor performs).
    rebuildPocketStash: () => reanchorCtl.restashPocketedStrokes(),
  };
  const shim = createSyncShim({
    state,
    engine: engineAdapter,
    resolveAutoColor: () => themeRef.foreground || "#111111",
    resolveHeadingColor: () => themeRef.headingColor || themeRef.foreground || "#111111",
    // Engine's coord space is wrapper-local (pointToLocal subtracts
    // origin). Hush DrawShapes must live in world coords so every
    // downstream Hush subsystem — box-select, getShapeBounds, file
    // I/O — can treat them like any other shape. Translate here at
    // the boundary.
    localToWorld: (p) => ({ x: p.x + anchor.originX, y: p.y + anchor.originY, pressure: p.pressure, t: p.t }),
    worldToLocal: (p) => ({ x: p.x - anchor.originX, y: p.y - anchor.originY, pressure: p.pressure, t: p.t }),
  });
  shimBox.current = shim;

  // Bridge Hush's selectedIds → engine selection so the bbox +
  // handles appear for strokes selected via Hush's regular Select
  // rectangle, not just the pen-mode lasso. Attached AFTER the shim
  // so a "shapes" notify flowing both listeners sees the shim update
  // engine.strokes first; the bridge's bbox recompute then lands on
  // the freshly-committed positions instead of pre-update ones.
  // Without this ordering, a flow-snap delta applied after pointerup
  // leaves the engine bbox at the pre-snap position until the next
  // selection change.
  const selectionBridge = createSelectionBridge({ state, selectionEngine, shimBox });

  // ---------- public API ----------

  function setInputEnabled(enabled: boolean): void {
    // Two iPad WebKit quirks fixed in lockstep:
    //   1. A parent with `pointer-events: none` blocks hit-testing into
    //      its children even when those children set `auto` — so the
    //      wrapper has to flip alongside the SVG.
    //   2. An empty `<svg>` with `pointer-events: auto` isn't a hit
    //      target on iPad — `bounding-box` makes the entire SVG box
    //      hit-testable regardless of (or absence of) children.
    svg.style.pointerEvents = enabled ? "bounding-box" : "none";
    wrapper.style.pointerEvents = enabled ? "auto" : "none";
    // The stroke engine's pointermove listener lives on `document.body`,
    // so disabling the SVG's pointer-events doesn't actually stop the
    // engine from extending an in-flight stroke when input is taken
    // away from us mid-gesture (e.g. user holds space to pan while
    // still pressing the pen). Cancel the in-flight stroke explicitly
    // so a desktop spacebar-drag pan can't keep stamping new stamps
    // along the cursor's screen path until the next pointerup.
    if (!enabled) (strokeEngine as unknown as { cancelActiveStroke: () => boolean }).cancelActiveStroke();
  }

  function setTheme(next: CanvasTheme): void {
    applyThemeAndRetint(strokeEngine, themeRef, next);
  }

  function rebake(): void {
    strokeEngine.fullRebake();
  }

  // Re-render just the strokes matching `hushIds` into an arbitrary
  // ctx whose transform maps world → target pixels. The strokes are
  // walked in the engine's canonical order so z-stacking matches the
  // done canvas; the origin translate converts engine-local coords
  // back to world. Unlike blitWorldRegion / blitDoneCanvasAtWorldOrigin
  // this paints through the atlas renderer, so strokes that merely
  // overlap the same region don't leak into the output — that's what
  // the selection rasterizer needs.
  function renderStrokesTo(
    ctx: CanvasRenderingContext2D,
    hushIds: Iterable<string>,
    colorOverrides?: { foreground: string; headingColor: string },
  ): void {
    const wanted = new Set<number>();
    for (const hid of hushIds) {
      const eid = shim.getEngineStrokeId(hid);
      if (eid !== undefined) wanted.add(eid);
    }
    if (!wanted.size) return;
    // renderStrokeTo (Hush delta #20) postdates the inferred engine
    // surface — same cast pattern as cancelActiveStroke above.
    const engine = strokeEngine as unknown as {
      renderStrokeTo: (ctx: CanvasRenderingContext2D, s: EngineStroke) => void;
    };
    ctx.save();
    ctx.translate(anchor.originX, anchor.originY);
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (!wanted.has(s.id)) continue;
      // Theme-tracking strokes can be retinted for a specific
      // appearance (the dual light/dark rasterizer); a shallow copy
      // keeps the engine's stored colour untouched.
      if (colorOverrides && (s.colorIsAuto || s.colorIsHeading)) {
        engine.renderStrokeTo(ctx, {
          ...s,
          color: s.colorIsHeading ? colorOverrides.headingColor : colorOverrides.foreground,
        });
      } else {
        engine.renderStrokeTo(ctx, s);
      }
    }
    ctx.restore();
  }

  // ----- hush select-drag integration -----
  //
  // Routes DrawShape moves through the engine's previewTransform — see
  // src/notebook/drawing/selection-drag.ts for the pause-shim, hide-
  // chrome, commit-on-release ladder. Naive per-frame setStrokePoints
  // craters above ~20 strokes; the controller keeps it O(1) per frame.
  const selectionDrag = createSelectionDragController({
    strokeEngine: strokeEngine as unknown as Parameters<typeof createSelectionDragController>[0]["strokeEngine"],
    selectionEngine,
    shim,
  });
  const beginSelectionDrag = selectionDrag.begin;
  const updateSelectionDrag = selectionDrag.update;
  const endSelectionDrag = selectionDrag.end;


  function setTool(tool: EngineTool): void {
    // Engine's setTool handles the draw/erase/slice/select branch for
    // pointer capture. Toggle the selection engine's event-capture
    // flag without clearing its selection — `deactivate()` would call
    // clearSelection(), which collides with the bridge that's trying
    // to keep the user's selection visible across brush-slot taps.
    strokeEngine.setTool(tool);
    selectionEngine.setEventActive(tool === "select");
  }

  function applySlot(slot: DrawingSlot): void {
    applySlotToEngine(strokeEngine, themeRef, slot);
  }

  function setLassoHoldMs(ms: number): void {
    strokeEngine.setLongPressMs(ms);
  }

  function setPencilOnly(on: boolean): void {
    (strokeEngine as unknown as { setPencilOnly: (b: boolean) => void }).setPencilOnly(!!on);
  }

  const renderSwatch = (c: HTMLCanvasElement, slot: DrawingSlot) => renderSwatchToCanvas(strokeEngine, themeRef, c, slot);
  const renderDemoStroke = (c: HTMLCanvasElement, slot: DrawingSlot) => renderDemoStrokeToCanvas(strokeEngine, themeRef, c, slot);


  // Drawing undo / redo route through Hush's snapshot stack so 2- and
  // 3-finger gesture taps, ⌘Z, and any non-drawing notebook action all
  // share one history. The shim's isDiffing flag keeps engine
  // callbacks from re-recording during the resulting state→engine
  // reflection.
  function undo() { state.undo(); }
  function redo() { state.redo(); }
  function canUndo() { return (state as unknown as { canUndo: boolean }).canUndo; }
  function canRedo() { return (state as unknown as { canRedo: boolean }).canRedo; }

  // Retroactive selection styling — see selection-style.ts for the
  // snapshot → apply → commit pattern. Closed over the same engines
  // and shim this file uses for everything else.
  const selectionStyle = createSelectionStyleSession({
    selectionEngine, strokeEngine, shimBox, themeRef,
    recordHistory: () => state.recordHistory(),
  });
  const { hasSelection, snapshotSelectedStyle, applyStyleToSelection, commitStyleHistory } = selectionStyle;

  function destroy(): void {
    shim.destroy();
    state.removeEventListener("change", onSubToolChangeForTransient);
    selectionBridge.destroy();
    wrapper.remove();
    if (selectHintTimer) { clearTimeout(selectHintTimer); selectHintTimer = null; }
    selectHint.remove();
  }

  return {
    setCamera,
    setInputEnabled,
    setTheme,
    setTool,
    applySlot,
    setLassoHoldMs,
    setPencilOnly,
    renderSwatch,
    renderDemoStroke,
    undo,
    redo,
    canUndo,
    canRedo,
    rebake,
    blitWorldRegion,
    blitDoneCanvasAtWorldOrigin,
    renderStrokesTo,
    hasActiveStroke: () => strokeEngine.hasActiveStroke(),
    beginSelectionDrag,
    updateSelectionDrag,
    endSelectionDrag,
    hasSelection,
    snapshotSelectedStyle,
    applyStyleToSelection,
    commitStyleHistory,
    destroy,
  };
}
