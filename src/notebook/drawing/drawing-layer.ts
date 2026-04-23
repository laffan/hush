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
import { createHistory } from "./engine/history.js";
import { createSelectionEngine } from "./engine/selection.js";
import { createGestures } from "./engine/gestures.js";
import { createSyncShim } from "./sync-shim";
import type { EngineAdapter, EngineStroke, ShimState } from "./sync-shim";
import { brushUrl } from "./brush-urls";

type EngineTool = "draw" | "erase" | "slice" | "select";

/** Initial wrapper size. Covers the viewport on typical displays with
 *  room for drift. Canvas grows dynamically if strokes extend. */
const WORLD_SIZE = 2048;
/** Per-canvas memory cap. 4096×4096 = 16 MP. iPad-safe across the
 *  range; beyond it the backing DPR degrades rather than the canvas
 *  blowing up its context. */
const MAX_BACKING_PIXELS = 4096 * 4096;
const MAX_DPR = 2;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Returned handle. The future drawing-mode controller (step 5+)
 *  drives these methods. */
export interface DrawingLayer {
  /** Sync the CSS transform of the drawing wrapper to the camera. */
  setCamera(camera: Camera): void;
  /** Toggle whether the drawing SVG captures pointers. Drawing mode
   *  turns this on; everything else leaves it off so the notebook
   *  canvas owns input. */
  setInputEnabled(enabled: boolean): void;
  /** Apply a theme change. Strokes with colorIsAuto adopt the new
   *  theme.foreground; the done canvas rebakes. */
  setTheme(theme: CanvasTheme): void;
  /** Engine sub-tool while drawing mode is active: draw / erase /
   *  slice / select. Has no effect when drawing mode is off (SVG is
   *  non-capturing). */
  setTool(tool: EngineTool): void;
  /** Push a brush slot's config (brush id, color, size, mode,
   *  streamline, spacing) into the engine. `color: "auto"` resolves
   *  to theme.foreground at apply time. */
  applySlot(slot: DrawingSlot): void;
  /** Render a swatch preview of a slot into a target canvas, using
   *  the engine's atlas. */
  renderSwatch(canvas: HTMLCanvasElement, slot: DrawingSlot): void;
  /** Drawing-mode undo / redo. Separate from Hush's notebook undo
   *  stack for now — see INTEGRATION-PLAN.md → shortcuts. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Engine rebake on demand (e.g. after a layer mutation). */
  rebake(): void;
  /** Blit a world-space rectangle of the done canvas into `ctx` at
   *  its current transform. Used by the notebook renderer to draw
   *  grouped-drawing thumbnails into the pocket tray / shelf. The
   *  destination uses the ctx's logical coords (pocket transform
   *  already applied by the caller), so we pass world bbox → dest
   *  matching the bbox at ctx's current scale. */
  blitWorldRegion(ctx: CanvasRenderingContext2D, worldBbox: { minX: number; minY: number; maxX: number; maxY: number }): void;

  // ----- hush select-drag integration -----
  //
  // For DrawShape selections, Hush's select-drag routes move updates
  // through the engine's previewTransform so dragging N strokes is
  // ~free (one GPU preview per frame, no setStrokePoints churn).
  // Call begin at drag-start, update per pointer-move, end at
  // release. If no DrawShapes are in the drag set, these are no-ops.

  /** Begin a hush-driven drag. Strokes with these hush ids get
   *  excluded from the done canvas and rendered on preview. The
   *  shim pauses so per-frame state.shapes point mutations don't
   *  re-enter the engine. */
  beginSelectionDrag(hushIds: Iterable<string>): void;
  /** Pointer-move update. `totalDx` / `totalDy` are the accumulated
   *  world-space delta since drag-start. */
  updateSelectionDrag(totalDx: number, totalDy: number): void;
  /** Commit the preview: mutate engine points by the final total
   *  offset, rebridge, resume the shim. */
  endSelectionDrag(): void;

  // ----- retroactive selection styling (used by the flyout) -----

  /** True if the drawing-mode selection engine has any strokes
   *  selected. */
  hasSelection(): boolean;
  /** Snapshot the current styles of the selected strokes. Caller
   *  saves this and passes it to `commitStyleHistory` after a drag
   *  or click session to produce a single undo entry. */
  snapshotSelectedStyle(): Map<number, SelectionStyleEntry>;
  /** Apply a style patch to the current selection. Does not push a
   *  history entry on its own — pair with begin/commit for
   *  undoable sessions. `color: "auto"` resolves to theme fg and
   *  tags the strokes as colorIsAuto. */
  applyStyleToSelection(patch: SelectionStylePatch): void;
  /** Push a single undo entry spanning the session between
   *  snapshot-time and now. No-op if nothing actually changed. */
  commitStyleHistory(beforeMap: Map<number, SelectionStyleEntry>): void;
  /** Tear down event listeners + DOM. */
  destroy(): void;
}

/** Per-stroke style snapshot used by the retroactive styling path. */
export interface SelectionStyleEntry {
  color: string;
  size: number;
  brushId: string;
  mode: "normal" | "highlighter";
  colorIsAuto: boolean;
}

/** Style patch accepted by `applyStyleToSelection`. Any subset of
 *  fields is allowed; missing fields are left as-is on each stroke. */
export interface SelectionStylePatch {
  color?: string;              // "auto" or hex
  size?: number;
  brushId?: string;
  mode?: "normal" | "highlighter";
}

/** Construction options. `state` is Hush's DrawingState (kept
 *  structural to avoid a circular import). */
export function createDrawingLayer({
  container,
  state,
  theme,
  camera,
}: {
  container: HTMLElement;
  state: ShimState;
  theme: CanvasTheme;
  camera: Camera;
}): DrawingLayer {
  // Mutable theme object: we mutate in place on setTheme so the
  // engine's atlas cache and our resolveAutoColor closure pick up new
  // values without reallocating.
  const themeRef = { ...theme };

  // ---------- DOM: transform wrapper + engine stage ----------

  const wrapper = document.createElement("div");
  wrapper.className = "notebook-drawing-wrapper";
  Object.assign(wrapper.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: WORLD_SIZE + "px",
    height: WORLD_SIZE + "px",
    transformOrigin: "0 0",
    pointerEvents: "none",
  });
  container.appendChild(wrapper);

  // Center the wrapper on the current viewport so the default cursor
  // position lands inside canvas bounds.
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const originX = vw / 2 - WORLD_SIZE / 2;
  const originY = vh / 2 - WORLD_SIZE / 2;

  function mkStageCanvas(cls: string): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.className = cls;
    Object.assign(c.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
    });
    return c;
  }

  const doneCanvas = mkStageCanvas("draw-canvas drawing-done");
  const previewCanvas = mkStageCanvas("draw-canvas drawing-preview");
  const liveCanvas = mkStageCanvas("draw-canvas drawing-live");
  wrapper.appendChild(doneCanvas);
  wrapper.appendChild(previewCanvas);
  wrapper.appendChild(liveCanvas);

  // Pocket stash: offscreen canvas mirroring the done canvas's pixel
  // layout. When a stroke flips to pocketed, its region is copied
  // from done → stash before the engine rebakes (which removes it
  // from done via engine delta #8). `blitWorldRegion` for pocket
  // render reads from the stash so pocketed strokes remain paintable
  // in the pocket tray even though they're absent from the world
  // view. Stash and done are always the same size/DPR.
  const pocketStash = document.createElement("canvas");
  const pocketStashCtx = pocketStash.getContext("2d")!;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("viewBox", `0 0 ${WORLD_SIZE} ${WORLD_SIZE}`);
  Object.assign(svg.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: WORLD_SIZE + "px",
    height: WORLD_SIZE + "px",
    // Off by default — step 4 doesn't mount drawing mode yet. Step 5
    // flips to 'auto' when the pen tool activates.
    pointerEvents: "none",
    touchAction: "none",
  });
  wrapper.appendChild(svg);

  // iPad safety: touch preventDefaults so gesture detection doesn't
  // yank pointer capture mid-stroke. Mounted even while the SVG is
  // non-capturing — cheap to keep on.
  svg.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  svg.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  const eraserCursor = document.createElementNS(SVG_NS, "circle");
  eraserCursor.setAttribute("r", "12");
  eraserCursor.setAttribute("fill", "none");
  eraserCursor.setAttribute("stroke", "#111");
  eraserCursor.setAttribute("stroke-width", "1");
  eraserCursor.setAttribute("stroke-dasharray", "3 3");
  eraserCursor.setAttribute("visibility", "hidden");
  eraserCursor.setAttribute("pointer-events", "none");
  svg.appendChild(eraserCursor);

  const selectionLayer = document.createElementNS(SVG_NS, "g");
  selectionLayer.setAttribute("class", "selection-layer");
  svg.appendChild(selectionLayer);

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

  const history = createHistory();

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
      const sel = selectionBox.current;
      if (sel) sel.startLassoAtPointer(pointerId, point);
    },
    onStrokeAdded: (stroke: EngineStroke, _index: number) => {
      // Always bridge to state.shapes so autosave, Dropbox sync, and
      // panes see the new drawing. History push still happens on the
      // engine side so drawing-mode undo works as expected; when the
      // user is outside drawing mode, Hush's own undo-manager won't
      // see this push (a separate concern — step 9).
      if (history.isReplaying()) return;
      const shim = shimBox.current;
      if (shim) shim.onEngineStrokeAdded(stroke);
      history.push({
        undo: () => strokeEngine.removeStrokes([stroke.id]),
        redo: () => strokeEngine.insertStrokeAt(stroke, _index),
      });
    },
    onStrokesRemoved: (removed: { stroke: EngineStroke; index: number }[]) => {
      if (history.isReplaying()) return;
      const snapshot = removed.slice();
      const shim = shimBox.current;
      if (shim) shim.onEngineStrokesRemoved(removed.map((r) => r.stroke.id));
      history.push({
        undo: () => {
          for (const r of snapshot) strokeEngine.insertStrokeAt(r.stroke, r.index);
        },
        redo: () => strokeEngine.removeStrokes(snapshot.map((r) => r.stroke.id)),
      });
    },
    onStrokesTransformed: (entries: { id: number; before: EngineStroke["points"]; after: EngineStroke["points"] }[]) => {
      if (history.isReplaying()) return;
      const snapshot = entries.slice();
      const shim = shimBox.current;
      if (shim) shim.onEngineStrokesTransformed(entries.map((e) => e.id));
      history.push({
        undo: () => { for (const e of snapshot) strokeEngine.setStrokePoints(e.id, e.before); },
        redo: () => { for (const e of snapshot) strokeEngine.setStrokePoints(e.id, e.after); },
      });
    },
    onStrokesSliced: ({ removed, added }: {
      removed: { stroke: EngineStroke; originalIndex: number }[];
      added: { stroke: EngineStroke; finalIndex: number }[];
    }) => {
      if (history.isReplaying()) return;
      const r = removed.slice();
      const a = added.slice();
      const shim = shimBox.current;
      if (shim) {
        shim.onEngineStrokesRemoved(r.map((x) => x.stroke.id));
        for (const x of a) shim.onEngineStrokeAdded(x.stroke);
      }
      history.push({
        undo: () => {
          if (a.length) strokeEngine.removeStrokes(a.map((x) => x.stroke.id));
          for (const x of r) strokeEngine.insertStrokeAt(x.stroke, x.originalIndex);
        },
        redo: () => {
          if (r.length) strokeEngine.removeStrokes(r.map((x) => x.stroke.id));
          for (const x of a) strokeEngine.insertStrokeAt(x.stroke, x.finalIndex);
        },
      });
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
    },
    onLassoComplete: ({ selected }) => {
      if (selected) expandSelectionToGroups();
      // Bridge regardless — a lasso that hits nothing clears engine
      // selection; we want state.selectedIds to track.
      bridgeEngineSelectionToState();
    },
    onSelectionDeleted: () => {
      // engine.removeStrokes fires its own onStrokesRemoved callback,
      // which pushes to history + removes from state.shapes. Also
      // clear state.selectedIds so Hush's selection toolbar hides.
      bridgeEngineSelectionToState();
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

  // Two/three-finger touch → undo/redo on iPad.
  createGestures({
    getRect: () => svg.getBoundingClientRect(),
    pointToLocal,
    strokeEngine,
    selectionEngine,
    onUndo: () => history.undo(),
    onRedo: () => history.redo(),
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
    // Engine's coord space is wrapper-local (pointToLocal subtracts
    // origin). Hush DrawShapes must live in world coords so every
    // downstream Hush subsystem — box-select, getShapeBounds, file
    // I/O — can treat them like any other shape. Translate here at
    // the boundary.
    localToWorld: (p) => ({ x: p.x + originX, y: p.y + originY, pressure: p.pressure }),
    worldToLocal: (p) => ({ x: p.x - originX, y: p.y - originY, pressure: p.pressure }),
  });
  shimBox.current = shim;

  // ---------- public API ----------

  function setInputEnabled(enabled: boolean): void {
    svg.style.pointerEvents = enabled ? "auto" : "none";
  }

  function setTheme(next: CanvasTheme): void {
    const fgChanged = next.foreground !== themeRef.foreground;
    themeRef.canvasBackground = next.canvasBackground;
    themeRef.foreground = next.foreground;
    themeRef.accent = next.accent;
    if (!fgChanged) return;
    // Auto-colored strokes: update their color field to the new fg
    // and rebake once. Explicit-color strokes are untouched.
    let touched = false;
    for (const s of strokeEngine.getStrokes()) {
      if ((s as EngineStroke).colorIsAuto) {
        (s as EngineStroke).color = next.foreground;
        touched = true;
      }
    }
    if (touched) strokeEngine.fullRebake();
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
    const s = shim; // fall back to the shim we already constructed
    for (const hid of hushIds) {
      const eid = s.getEngineStrokeId(hid);
      if (eid !== undefined) ids.add(eid);
    }
    if (ids.size === 0) return;
    dragEngineIds = ids;
    dragTotalDx = 0;
    dragTotalDy = 0;
    shim.pauseForDrag();
    strokeEngine.previewTransform(dragEngineIds, { kind: "move", dx: 0, dy: 0 });
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
      shim.resumeForDrag();
      return;
    }
    const dx = dragTotalDx, dy = dragTotalDy;
    strokeEngine.commitTransform(dragEngineIds, (x, y) => [x + dx, y + dy]);
    // Clear the preview back to done canvas.
    strokeEngine.previewTransform(dragEngineIds, null);
    // Don't bridge via onEngineStrokesTransformed here — state.shapes
    // already has the post-drag points from hush's own per-frame
    // updates. Resume is all we need; the shim refreshes lastSeen.
    shim.resumeForDrag();
    dragEngineIds = null;
    dragTotalDx = 0;
    dragTotalDy = 0;
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
    // pointer capture. Selection-engine activation is orthogonal —
    // enable it only while select is the sub-tool so lasso + bbox
    // overlays don't intercept clicks in the other sub-tools.
    strokeEngine.setTool(tool);
    if (tool === "select") selectionEngine.activate();
    else selectionEngine.deactivate();
  }

  function applySlot(slot: DrawingSlot): void {
    const color = slot.color === "auto" ? (themeRef.foreground || "#111111") : slot.color;
    strokeEngine.setBrush(slot.brushId);
    strokeEngine.setColor(color);
    strokeEngine.setSize(slot.size);
    strokeEngine.setMode(slot.mode);
    strokeEngine.setStreamline(slot.streamline);
    strokeEngine.setSpacing(slot.spacing);
  }

  function renderSwatch(canvas: HTMLCanvasElement, slot: DrawingSlot): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const color = slot.color === "auto" ? (themeRef.foreground || "#111111") : slot.color;
    const size = Math.min(cssW, cssH);
    strokeEngine.renderBrushSwatch(slot.brushId, color, ctx, cssW / 2, cssH / 2, size, slot.mode);
  }

  function undo() { history.undo(); }
  function redo() { history.redo(); }
  function canUndo() { return history.canUndo(); }
  function canRedo() { return history.canRedo(); }

  // ----- retroactive styling on the live selection -----
  //
  // Pattern mirrors the demo's styleSession. The flyout calls:
  //   1. snapshotSelectedStyle()              → save baseline
  //   2. applyStyleToSelection(patch) 1..N    → live updates, no history
  //   3. commitStyleHistory(baselineSnapshot) → single undo entry
  // Handles the colorIsAuto tag ourselves since setStrokesStyle
  // doesn't know about it.

  function hasSelection(): boolean {
    return selectionEngine.hasSelection();
  }

  function snapshotSelectedStyle(): Map<number, SelectionStyleEntry> {
    const ids = selectionEngine.getSelectedIds();
    const map = new Map<number, SelectionStyleEntry>();
    if (!ids.size) return map;
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (!ids.has(s.id)) continue;
      map.set(s.id, {
        color: s.color,
        size: s.size,
        brushId: s.brush,
        mode: s.mode,
        colorIsAuto: !!s.colorIsAuto,
      });
    }
    return map;
  }

  function applyStyleToSelection(patch: SelectionStylePatch): void {
    if (!selectionEngine.hasSelection()) return;
    const ids = selectionEngine.getSelectedIds();
    const enginePatch: Record<string, unknown> = {};
    if (patch.color !== undefined) {
      enginePatch.color = patch.color === "auto" ? (themeRef.foreground || "#111111") : patch.color;
    }
    if (patch.size !== undefined) enginePatch.size = patch.size;
    if (patch.brushId !== undefined) enginePatch.brushId = patch.brushId;
    if (patch.mode !== undefined) enginePatch.mode = patch.mode;
    strokeEngine.setStrokesStyle(ids as Set<number>, enginePatch);
    if (patch.color !== undefined) {
      const isAuto = patch.color === "auto";
      for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
        if (ids.has(s.id)) s.colorIsAuto = isAuto;
      }
    }
    // Sync the shim so state.shapes reflects the style change —
    // autosave, Dropbox, panes all pick it up.
    const shim = shimBox.current;
    if (shim) shim.onEngineStrokesTransformed(Array.from(ids));
    selectionEngine.refreshBBox();
  }

  function commitStyleHistory(before: Map<number, SelectionStyleEntry>): void {
    if (!before.size) return;
    // Snapshot post-state for the same ids.
    const after = new Map<number, SelectionStyleEntry>();
    for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
      if (!before.has(s.id)) continue;
      after.set(s.id, {
        color: s.color, size: s.size, brushId: s.brush, mode: s.mode,
        colorIsAuto: !!s.colorIsAuto,
      });
    }
    // Bail if nothing changed.
    let changed = false;
    for (const [id, b] of before) {
      const a = after.get(id);
      if (!a) continue;
      if (a.color !== b.color || a.size !== b.size ||
          a.brushId !== b.brushId || a.mode !== b.mode ||
          a.colorIsAuto !== b.colorIsAuto) { changed = true; break; }
    }
    if (!changed) return;
    const restore = (map: Map<number, SelectionStyleEntry>) => {
      const styleMap = new Map<number, object>();
      for (const [id, e] of map) {
        styleMap.set(id, {
          color: e.color, size: e.size, brushId: e.brushId, mode: e.mode,
        });
      }
      strokeEngine.setStrokesStyleMap(styleMap);
      for (const s of strokeEngine.getStrokes() as EngineStroke[]) {
        const e = map.get(s.id);
        if (e) s.colorIsAuto = e.colorIsAuto;
      }
      const shim = shimBox.current;
      if (shim) shim.onEngineStrokesTransformed(Array.from(map.keys()));
      selectionEngine.refreshBBox();
    };
    history.push({
      undo: () => restore(before),
      redo: () => restore(after),
    });
  }

  function destroy(): void {
    shim.destroy();
    wrapper.remove();
  }

  return {
    setCamera,
    setInputEnabled,
    setTheme,
    setTool,
    applySlot,
    renderSwatch,
    undo,
    redo,
    canUndo,
    canRedo,
    rebake,
    blitWorldRegion,
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
