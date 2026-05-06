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

// Re-export so callers that imported these from drawing-layer.ts keep working.
export type { DrawingLayer, SelectionStyleEntry, SelectionStylePatch };


/** Initial wrapper size. Covers the viewport on typical displays with
 *  room for drift. Canvas grows dynamically if strokes extend. */
const WORLD_SIZE = 2048;
/** Per-canvas memory cap. 4096×4096 = 16 MP. iPad-safe across the
 *  range; beyond it the backing DPR degrades rather than the canvas
 *  blowing up its context. */
const MAX_BACKING_PIXELS = 4096 * 4096;
const MAX_DPR = 2;

// Brush-runtime helpers (slot colour resolution, applySlot, renderSwatch,
// theme-retint) live in `brush-runtime.ts` so this file stays under the
// 700-line cap.
import { applySlotToEngine, renderSwatchToCanvas, applyThemeAndRetint } from "./brush-runtime";


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
   *  user spreads / squeezes two fingers. Notebook drives the camera
   *  zoom from these. mid + dist are in client (screen) px. */
  onTouchPinchStart?: (mid: { x: number; y: number }, dist: number) => void;
  onTouchPinchMove?: (mid: { x: number; y: number }, dist: number) => void;
  onTouchPinchEnd?: () => void;
}): DrawingLayer {
  // Mutable theme object: we mutate in place on setTheme so the
  // engine's atlas cache and our resolveAutoColor closure pick up new
  // values without reallocating.
  const themeRef = { ...theme };

  // ---------- DOM: transform wrapper + engine stage ----------

  const dom = createDrawingDom(container, WORLD_SIZE);
  const {
    wrapper, doneCanvas, previewCanvas, liveCanvas,
    pocketStash, pocketStashCtx,
    svg, eraserCursor, selectionLayer, selectHint,
    originX, originY,
  } = dom;

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
    const cx = (localPt.x + originX) * cameraRef.zoom + cameraRef.x;
    const cy = (localPt.y + originY) * cameraRef.zoom + cameraRef.y;
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

  const cameraRef = { x: camera.x, y: camera.y, zoom: camera.zoom };

  function currentDpr(): number {
    const native = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const maxFit = Math.sqrt(MAX_BACKING_PIXELS / (WORLD_SIZE * WORLD_SIZE));
    return Math.min(native, maxFit);
  }

  function pointToLocal(clientPt: { x: number; y: number }): { x: number; y: number } {
    const rect = container.getBoundingClientRect();
    const screenX = clientPt.x - rect.left;
    const screenY = clientPt.y - rect.top;
    const worldX = (screenX - cameraRef.x) / cameraRef.zoom;
    const worldY = (screenY - cameraRef.y) / cameraRef.zoom;
    return { x: worldX - originX, y: worldY - originY };
  }

  function setCamera(next: Camera): void {
    cameraRef.x = next.x;
    cameraRef.y = next.y;
    cameraRef.zoom = next.zoom;
    const tx = next.x + originX * next.zoom;
    const ty = next.y + originY * next.zoom;
    wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${next.zoom})`;
  }
  setCamera(camera);

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
    onPinchStart: (mid: { x: number; y: number }, dist: number) => { onTouchPinchStart && onTouchPinchStart(mid, dist); },
    onPinchMove: (mid: { x: number; y: number }, dist: number) => { onTouchPinchMove && onTouchPinchMove(mid, dist); },
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

  // ---------- canvas sizing ----------

  function sizeCanvases(): void {
    const dpr = currentDpr();
    for (const c of [doneCanvas, previewCanvas, liveCanvas]) {
      c.width = Math.round(WORLD_SIZE * dpr);
      c.height = Math.round(WORLD_SIZE * dpr);
      c.style.left = "0px";
      c.style.top = "0px";
      c.style.width = WORLD_SIZE + "px";
      c.style.height = WORLD_SIZE + "px";
    }
    // Keep stash in lockstep with done canvas dimensions. `canvas.width
    // = ...` also clears content, which we accept on resize — any
    // stashed pocketed strokes lose their capture. A subsequent
    // rebake doesn't restore them (they're hidden in engine). Pocket
    // tray will render empty for those strokes until repocketed; in
    // practice resize is rare and users can re-pocket as needed.
    if (pocketStash.width !== doneCanvas.width || pocketStash.height !== doneCanvas.height) {
      pocketStash.width = doneCanvas.width;
      pocketStash.height = doneCanvas.height;
    }
  }
  sizeCanvases();
  strokeEngine.resize(WORLD_SIZE, WORLD_SIZE);

  // ---------- sync shim ----------
  //
  // `resolveAutoColor` reads from the mutable themeRef so theme
  // changes flow into newly-created strokes immediately.
  const engineAdapter: EngineAdapter = {
    getStrokes: () => strokeEngine.getStrokes() as EngineStroke[],
    insertStrokeAt: (stroke, index) => strokeEngine.insertStrokeAt(stroke, index),
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
    localToWorld: (p) => ({ x: p.x + originX, y: p.y + originY, pressure: p.pressure }),
    worldToLocal: (p) => ({ x: p.x - originX, y: p.y - originY, pressure: p.pressure }),
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
    // The SVG is nested inside a CSS-transformed wrapper that defaults
    // to `pointer-events: none` so empty drawing areas let clicks fall
    // through to the notebook canvas below. On WebKit / iPadOS, that
    // `none` on the wrapper also stops hit-testing from descending into
    // the SVG even when the SVG itself is `auto` — the pencil events
    // landed on the underlying notebook canvas instead of the SVG, so
    // the engine never saw them. Flip both in lockstep: wrapper `auto`
    // + SVG `auto` while drawing, both `none` otherwise.
    svg.style.pointerEvents = enabled ? "auto" : "none";
    wrapper.style.pointerEvents = enabled ? "auto" : "none";
    const w = window as unknown as { __hushDebug?: (s: string) => void };
    if (typeof w.__hushDebug === "function") {
      w.__hushDebug(`drawing-layer setInputEnabled=${enabled} svg.pe=${svg.style.pointerEvents} wrap.pe=${wrapper.style.pointerEvents}`);
    }
  }

  function setTheme(next: CanvasTheme): void {
    applyThemeAndRetint(strokeEngine, themeRef, next);
  }

  function rebake(): void {
    strokeEngine.fullRebake();
  }

  // ----- hush select-drag integration -----
  //
  // During drag: the shim is paused so state.shapes point updates
  // don't spam setStrokePoints on the engine. The engine's preview
  // canvas renders the selected strokes with the current (dx, dy)
  // transform, which is O(1) per frame instead of O(strokes × tiles).
  let dragEngineIds: Set<number> | null = null;
  let dragTotalDx = 0;
  let dragTotalDy = 0;

  function beginSelectionDrag(hushIds: Iterable<string>): void {
    const ids = new Set<number>();
    for (const hid of hushIds) {
      const eid = shim.getEngineStrokeId(hid);
      if (eid !== undefined) ids.add(eid);
    }
    if (ids.size === 0) return;
    dragEngineIds = ids;
    dragTotalDx = 0;
    dragTotalDy = 0;
    shim.pauseForDrag();
    // Hide the engine's bbox + handles for the duration of Hush's
    // drag; Hush owns the visual feedback while the gesture runs
    // and the engine bbox reappears at the committed position on
    // release. Mirrors how Hush hides its chrome during engine
    // drags.
    selectionEngine.beginExternalDrag();
    // If previewTransform throws we've already paused the shim — resume
    // so the caller's missing endSelectionDrag doesn't leave us stuck.
    try { strokeEngine.previewTransform(dragEngineIds, { kind: "move", dx: 0, dy: 0 }); }
    catch (e) { console.warn("beginSelectionDrag: previewTransform failed:", e); shim.resumeForDrag(); dragEngineIds = null; }
  }

  function updateSelectionDrag(totalDx: number, totalDy: number): void {
    if (!dragEngineIds || dragEngineIds.size === 0) return;
    dragTotalDx = totalDx;
    dragTotalDy = totalDy;
    strokeEngine.previewTransform(dragEngineIds, { kind: "move", dx: totalDx, dy: totalDy });
  }

  function endSelectionDrag(): void {
    if (!dragEngineIds || dragEngineIds.size === 0) {
      // No draws in the drag — nothing to commit but clear state anyway.
      dragEngineIds = null;
      selectionEngine.endExternalDrag();
      shim.resumeForDrag();
      return;
    }
    // try/finally guarantees the shim resumes even if commit / preview
    // clear throws — leaving it paused would silently freeze every
    // future state→engine sync.
    try {
      const dx = dragTotalDx, dy = dragTotalDy;
      strokeEngine.commitTransform(dragEngineIds, (x, y) => [x + dx, y + dy]);
      // Clear the preview back to done canvas.
      strokeEngine.previewTransform(dragEngineIds, null);
      // Don't bridge via onEngineStrokesTransformed here — state.shapes
      // already has the post-drag points from hush's own per-frame
      // updates. Resume is all we need; the shim refreshes lastSeen.
    } finally {
      // endExternalDrag recomputes the bbox from the engine's now-
      // updated points so it lands on the final position.
      selectionEngine.endExternalDrag();
      shim.resumeForDrag();
      dragEngineIds = null;
      dragTotalDx = 0;
      dragTotalDy = 0;
    }
  }

  /** Done canvas covers world [originX..originX+WORLD_SIZE] ×
   *  [originY..originY+WORLD_SIZE] at `currentDpr()` backing density.
   *  World point (wx, wy) → bitmap px ((wx - originX) * dpr, ...).
   *  Caller has already applied its own transform (e.g. pocket
   *  translate+scale); we just need to blit to dest-world-coords
   *  that match the bbox.
   *
   *  Reads from the POCKET STASH canvas. Pocketed strokes are
   *  absent from the done canvas (engine delta #8) but present on
   *  the stash (captured at pocket-in, before rebake). Non-pocketed
   *  strokes are absent from the stash — only the pocket-tray
   *  render path calls this method, and pocketed strokes are the
   *  only ones that should appear there. */
  function blitWorldRegion(
    ctx: CanvasRenderingContext2D,
    worldBbox: { minX: number; minY: number; maxX: number; maxY: number },
  ): void {
    const dpr = currentDpr();
    const sx = (worldBbox.minX - originX) * dpr;
    const sy = (worldBbox.minY - originY) * dpr;
    const w = worldBbox.maxX - worldBbox.minX;
    const h = worldBbox.maxY - worldBbox.minY;
    const sw = w * dpr;
    const sh = h * dpr;
    if (sx + sw <= 0 || sy + sh <= 0 || sx >= pocketStash.width || sy >= pocketStash.height) return;
    if (w <= 0 || h <= 0) return;
    ctx.drawImage(
      pocketStash,
      sx, sy, sw, sh,
      worldBbox.minX, worldBbox.minY, w, h,
    );
  }

  function blitDoneCanvasAtWorldOrigin(ctx: CanvasRenderingContext2D): void {
    // Done canvas covers world rect [originX..originX+WORLD_SIZE] ×
    // [originY..originY+WORLD_SIZE]. Caller's ctx is already in world
    // coords, so paint the canvas at (originX, originY) at world size.
    if (doneCanvas.width === 0 || doneCanvas.height === 0) return;
    ctx.drawImage(doneCanvas, originX, originY, WORLD_SIZE, WORLD_SIZE);
  }

  /** Copy a world-bbox region from the done canvas to the pocket
   *  stash. Called by the sync shim right before the engine
   *  full-rebakes and removes the stroke from done. */
  function stashPocketRegion(worldBbox: {
    minX: number; minY: number; maxX: number; maxY: number;
  }): void {
    const dpr = currentDpr();
    const sx = Math.max(0, Math.floor((worldBbox.minX - originX) * dpr));
    const sy = Math.max(0, Math.floor((worldBbox.minY - originY) * dpr));
    const sw = Math.ceil((worldBbox.maxX - worldBbox.minX) * dpr);
    const sh = Math.ceil((worldBbox.maxY - worldBbox.minY) * dpr);
    if (sw <= 0 || sh <= 0) return;
    if (sx >= doneCanvas.width || sy >= doneCanvas.height) return;
    pocketStashCtx.drawImage(doneCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  /** Clear a world-bbox region from the pocket stash. Called on
   *  unpocket so the stash doesn't accumulate stale pixels. */
  function unstashPocketRegion(worldBbox: {
    minX: number; minY: number; maxX: number; maxY: number;
  }): void {
    const dpr = currentDpr();
    const sx = Math.max(0, Math.floor((worldBbox.minX - originX) * dpr));
    const sy = Math.max(0, Math.floor((worldBbox.minY - originY) * dpr));
    const sw = Math.ceil((worldBbox.maxX - worldBbox.minX) * dpr);
    const sh = Math.ceil((worldBbox.maxY - worldBbox.minY) * dpr);
    if (sw <= 0 || sh <= 0) return;
    pocketStashCtx.clearRect(sx, sy, sw, sh);
  }

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

  function renderSwatch(canvas: HTMLCanvasElement, slot: DrawingSlot): void {
    renderSwatchToCanvas(strokeEngine, themeRef, canvas, slot);
  }

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
    undo,
    redo,
    canUndo,
    canRedo,
    rebake,
    blitWorldRegion,
    blitDoneCanvasAtWorldOrigin,
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
