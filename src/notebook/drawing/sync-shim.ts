/* src/notebook/drawing/sync-shim.ts
 *
 * Bridges `state.shapes[]` (Hush's canonical shape array) with the
 * drawing engine's internal `state.strokes`. See
 * `INTEGRATION-PLAN.md` → "Sync shim design" for the full rationale.
 *
 * Core properties this file must preserve:
 *
 *   1. **Identity diff only.** On each `"shapes"` notify we walk both
 *      the previous and current DrawShape lists. Same reference →
 *      skip. Only object-identity changes touch the engine.
 *
 *   2. **Zero engine calls when no drawings changed.** A TextShape
 *      edit fires a shapes notify; the shim runs one O(N) ref-compare
 *      pass and does nothing else. Must stay under a millisecond on
 *      big notebooks.
 *
 *   3. **Engine-originated mutations bypass the diff.** When the
 *      engine commits a stroke, we push it to `state.shapes` AND
 *      refresh the last-seen snapshot in one go, so the resulting
 *      notify finds no deltas and does no duplicate work.
 *
 *   4. **Updates route through engine methods.** External mutations
 *      like pocket toggles or style changes call `setStrokesStyle` /
 *      `setStrokePoints`, which update tile indexes and rebake only
 *      the affected tiles. We never poke `state.strokes` directly.
 *
 *   5. **Batched load.** First-time sync (or bulk replacement like
 *      file-open) disables per-stroke rebakes, inserts all, then
 *      calls `fullRebake()` once.
 *
 * This file is small and reviewed on every change. Do not add code
 * inside the diff loop. If you need additional work on shape
 * mutations, do it outside the shim.
 */

import type { DrawShape, DrawPoint, Layer, Shape } from "../types";
import { generateId } from "../utils";

/** Engine stroke shape (mirrors engine/stroke.js's stroke object).
 *  Not imported from the engine because it's pure-JS; we describe
 *  the fields we use structurally. Engine ignores extras. */
export interface EngineStroke {
  id: number;
  tool: "draw";
  color: string;
  size: number;
  brush: string;                       // engine uses `brush`; we map to `brushId` at the boundary
  mode: "normal" | "highlighter";
  layerId: number;
  isPen: boolean;
  points: DrawPoint[];
  // Custom fields the engine passes through untouched:
  colorIsAuto?: boolean;
  groupId?: string;
  parentId?: string;
  pocketed?: boolean;
  // Internal bookkeeping, set by the engine renderer:
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  tiles?: string[];
}

/** The subset of the engine's public API the shim needs. */
export interface EngineAdapter {
  getStrokes(): EngineStroke[];
  insertStrokeAt(stroke: EngineStroke, index: number): void;
  removeStrokes(ids: number[] | Set<number>): void;
  setStrokesStyleMap(styleMap: Map<number, {
    color?: string; size?: number; brushId?: string;
    mode?: "normal" | "highlighter";
  }>): void;
  setStrokePoints(id: number, points: DrawPoint[]): void;
  fullRebake(): void;
  getActiveLayerId(): number;
  setActiveLayer(id: number): void;
  getLayerById(id: number): { id: number; name: string; locked: boolean; hidden: boolean } | null;
  getLayers(): { id: number; name: string; locked: boolean; hidden: boolean }[];
  createLayer(opts?: {
    idHint?: number; name?: string; atIndex?: number;
    locked?: boolean; hidden?: boolean;
  }): { layer: object; index: number } | null;
  deleteLayer(id: number): object | null;
  renameLayer(id: number, name: string): boolean;
  setLayerLocked(id: number, locked: boolean): boolean;
  setLayerHidden(id: number, hidden: boolean): boolean;
  moveLayer(fromIdx: number, toIdx: number): boolean;
  /** Capture a world-bbox region of the done canvas into a separate
   *  "pocket stash" canvas. Called BEFORE the engine rebake removes
   *  pocketed strokes from the done canvas, so the pocket tray has
   *  a frozen copy to display. */
  stashPocketRegion(worldBbox: { minX: number; minY: number; maxX: number; maxY: number }): void;
  /** Release the stash region for a world-bbox (called on unpocket). */
  unstashPocketRegion(worldBbox: { minX: number; minY: number; maxX: number; maxY: number }): void;
}

/** Minimum state surface we need from Hush's DrawingState. Kept as
 *  a structural type so we don't import the whole class here. */
export interface ShimState {
  shapes: Shape[];
  layers: Layer[];
  activeLayerId: string;
  /** Mutable; the drawing layer bridges engine-side selection
   *  changes into this set so hush-level ops (Cmd+G, selection
   *  toolbar, Delete) see the same selection. */
  selectedIds: Set<string>;
  /** Outer tool (the bottom-toolbar selection: select / pen / text /
   *  drag-area / brainstorm). Drawing-layer reads this so it can keep
   *  the engine bbox in sync when Hush selects strokes outside pen
   *  mode (the rectangular-select case). */
  tool: string;
  /** Current drawing sub-tool. The long-press → lasso handoff flips
   *  this to "select" so the stroke engine stops accepting draws for
   *  the duration of the selection, and restores on deselect. */
  drawingSubTool: "draw" | "erase" | "slice" | "select";
  /** True while the drawing engine is mid-transform on its own bbox.
   *  Set by drawing-layer's onDragStart hook; cleared on onDragEnd.
   *  Hush hides its group highlight + selection toolbar while this
   *  is true so the engine bbox is the only chrome moving during the
   *  gesture. */
  strokeEngineDragging: boolean;
  setDrawingSubTool(sub: "draw" | "erase" | "slice" | "select"): void;
  addEventListener(type: string, listener: (e: CustomEvent) => void): void;
  removeEventListener(type: string, listener: (e: CustomEvent) => void): void;
  notify(key: string): void;
  /** Hush's snapshot-based undo manager. Drawing-mode actions feed
   *  into this so 2-finger taps, ⌘Z, and engine-driven mutations all
   *  share one history. */
  recordHistory(): void;
  undo(): void;
  redo(): void;
}

/** Create the shim. Subscribes to state's `"change"` events and
 *  reconciles DrawShapes into the engine. Returns a handle with:
 *   - `onEngineStrokeAdded(engineStroke)` — called by the engine's
 *     onStrokeAdded callback; bridges the new stroke into
 *     `state.shapes` without triggering a re-diff.
 *   - `destroy()` — unsubscribes.
 *
 *  The engine's coordinate space is wrapper-local (offset from the
 *  true world origin by the drawing layer's `origin` — the centered
 *  position of the canvas wrapper). DrawShape.points are stored in
 *  WORLD coords so Hush's box-select, getShapeBounds, hitTestShape,
 *  and file I/O all work uniformly. `localToWorld` / `worldToLocal`
 *  bridge that gap at the shim boundary. */
export function createSyncShim({
  state,
  engine,
  resolveAutoColor,
  localToWorld,
  worldToLocal,
}: {
  state: ShimState;
  engine: EngineAdapter;
  resolveAutoColor: () => string;
  localToWorld: (p: DrawPoint) => DrawPoint;
  worldToLocal: (p: DrawPoint) => DrawPoint;
}) {
  /** Last-seen DrawShapes, keyed by hush string id. Reference-equal
   *  to the objects currently in `state.shapes`. Used for the
   *  identity diff. */
  const lastSeen = new Map<string, DrawShape>();

  /** Map hush ids ↔ engine numeric ids. Engine strokes carry numeric
   *  ids; Hush DrawShapes carry strings. Maintained in lockstep. */
  const hushToEngine = new Map<string, number>();
  const engineToHush = new Map<number, string>();

  /** Map hush layer ids ↔ engine numeric layer ids. Kept in sync by
   *  `syncLayers`; every stroke's layerId resolves through these
   *  maps when bridging between state and engine. */
  const hushLayerToEngine = new Map<string, number>();
  const engineLayerToHush = new Map<number, string>();
  /** Last-seen snapshot of state.layers (reference and field-level).
   *  On each "layers" notify we diff this against the current list. */
  let lastLayersSnap: Layer[] = [];
  /** External-layer id allocator. Same offset strategy as strokes. */
  let nextExternalEngineLayerId = 1_000_000;

  /** Reentrancy guard so `onEngineStrokeAdded` doesn't cause its own
   *  notify to re-enter the diff loop. */
  let suppressDiff = false;
  /** True while diffAndApply is running. Engine callbacks fired as a
   *  consequence (e.g. an `engine.removeStrokes` triggers an
   *  `onStrokesRemoved`) read this so they can skip Hush-side history
   *  recording — the state.shapes change driving the diff was already
   *  produced by an undo / redo / external mutation, recording again
   *  would clobber the redo stack. */
  let inDiff = false;
  /** Drag pause guard. Hush's select-drag routes through the engine's
   *  previewTransform for DrawShapes, so we don't want the shim to
   *  see per-frame state.shapes.points mutations and push each one
   *  to the engine as `setStrokePoints` — that's the quadratic lag.
   *  `pauseForDrag` skips the diff entirely; `resumeForDrag` rebuilds
   *  `lastSeen` from state so the accumulated drag changes aren't
   *  then re-applied to the engine (which has already committed the
   *  transform via commitTransform). */
  let pausedForDrag = false;

  /** True during an initial bulk sync. Engines's insertStrokeAt emits
   *  no callback of its own — we just let it run N times and rebake
   *  once. */
  let batching = false;

  // Initial sync — layers first so stroke inserts land on the right
  // layer, then shapes.
  syncLayers();
  bulkReplaceFromState();

  const onChange = ((e: CustomEvent) => {
    const keys: string[] = (e.detail && e.detail.keys) || [];
    if (suppressDiff) return;
    if (pausedForDrag) return;
    // Order matters: layers then shapes. A shape notified on the
    // same tick may reference a brand-new layer id.
    if (keys.includes("layers")) syncLayers();
    if (keys.includes("activeLayerId")) {
      const engineId = hushLayerToEngine.get(state.activeLayerId);
      if (engineId !== undefined) engine.setActiveLayer(engineId);
    }
    if (keys.includes("shapes")) diffAndApply();
  }) as (e: CustomEvent) => void;
  state.addEventListener("change", onChange);

  function destroy() {
    state.removeEventListener("change", onChange);
  }

  /** Engine → hush bridge. Called from `onStrokeAdded` inside the
   *  drawing layer. Allocates a hush id, registers it in the id
   *  maps, appends a DrawShape to `state.shapes`, and refreshes
   *  `lastSeen` before state fires its notify so the diff is a
   *  no-op. */
  function onEngineStrokeAdded(engineStroke: EngineStroke): DrawShape {
    const hushId = generateId();
    hushToEngine.set(hushId, engineStroke.id);
    engineToHush.set(engineStroke.id, hushId);
    const hushLayerId = findHushLayerIdForEngineLayer(engineStroke.layerId);
    const drawShape: DrawShape = {
      id: hushId,
      type: "draw",
      color: engineStroke.color,
      size: engineStroke.size,
      brushId: engineStroke.brush,
      mode: engineStroke.mode,
      layerId: hushLayerId,
      // Engine points are wrapper-local; translate to world for the
      // hush DrawShape so all downstream Hush code (box-select,
      // bounds, file I/O) sees true world coords.
      points: engineStroke.points.map(localToWorld),
      ...(engineStroke.colorIsAuto ? { colorIsAuto: true } : {}),
      ...(engineStroke.groupId ? { groupId: engineStroke.groupId } : {}),
      ...(engineStroke.parentId ? { parentId: engineStroke.parentId } : {}),
      ...(engineStroke.pocketed ? { pocketed: engineStroke.pocketed } : {}),
    };
    lastSeen.set(hushId, drawShape);
    suppressDiff = true;
    try {
      state.shapes = [...state.shapes, drawShape];
      state.notify("shapes");
    } finally {
      suppressDiff = false;
    }
    return drawShape;
  }

  /** Engine → hush bridge for deletion (erase, slice, selection-delete).
   *  Removes the DrawShape(s) from state and clears id maps. */
  function onEngineStrokesRemoved(engineIds: number[]): void {
    const hushIds = new Set<string>();
    for (const eid of engineIds) {
      const hid = engineToHush.get(eid);
      if (!hid) continue;
      hushIds.add(hid);
      engineToHush.delete(eid);
      hushToEngine.delete(hid);
      lastSeen.delete(hid);
    }
    if (!hushIds.size) return;
    suppressDiff = true;
    try {
      state.shapes = state.shapes.filter((s) => !hushIds.has(s.id));
      state.notify("shapes");
    } finally {
      suppressDiff = false;
    }
  }

  /** Engine → hush bridge for in-place mutations (point transforms,
   *  style changes, slicing — anything that leaves the stroke id
   *  stable but changes its fields). Regenerates the DrawShape for
   *  each affected id so state subscribers see a new reference. */
  function onEngineStrokesTransformed(engineIds: number[]): void {
    const changed = new Map<string, DrawShape>();
    for (const eid of engineIds) {
      const hid = engineToHush.get(eid);
      if (!hid) continue;
      const engineStroke = engine.getStrokes().find((s) => s.id === eid);
      if (!engineStroke) continue;
      const next: DrawShape = {
        id: hid,
        type: "draw",
        color: engineStroke.color,
        size: engineStroke.size,
        brushId: engineStroke.brush,
        mode: engineStroke.mode,
        layerId: findHushLayerIdForEngineLayer(engineStroke.layerId),
        points: engineStroke.points.map(localToWorld),
        ...(engineStroke.colorIsAuto ? { colorIsAuto: true } : {}),
        ...(engineStroke.groupId ? { groupId: engineStroke.groupId } : {}),
        ...(engineStroke.parentId ? { parentId: engineStroke.parentId } : {}),
        ...(engineStroke.pocketed ? { pocketed: engineStroke.pocketed } : {}),
      };
      changed.set(hid, next);
      lastSeen.set(hid, next);
    }
    if (!changed.size) return;
    suppressDiff = true;
    try {
      state.shapes = state.shapes.map((s) => changed.get(s.id) ?? s);
      state.notify("shapes");
    } finally {
      suppressDiff = false;
    }
  }

  // ---------- internal: state → engine ----------

  function diffAndApply() {
    inDiff = true;
    try { _diffAndApply(); } finally { inDiff = false; }
  }
  function _diffAndApply() {
    // Walk state.shapes once. For each DrawShape compare against
    // lastSeen by identity. Classify into add / update / skip.
    const currentHushIds = new Set<string>();
    const toAdd: DrawShape[] = [];
    const toUpdate: DrawShape[] = [];

    for (const s of state.shapes) {
      if (s.type !== "draw") continue;
      const ds = s as DrawShape;
      currentHushIds.add(ds.id);
      const prev = lastSeen.get(ds.id);
      if (prev === ds) continue;              // reference unchanged → no engine work
      if (prev === undefined) toAdd.push(ds);  // new DrawShape from outside
      else toUpdate.push(ds);                  // identity changed → re-apply to engine
    }

    // Removes: anything in lastSeen but not in current.
    const toRemove: string[] = [];
    for (const id of lastSeen.keys()) {
      if (!currentHushIds.has(id)) toRemove.push(id);
    }

    // Fast path: nothing changed.
    if (!toAdd.length && !toUpdate.length && !toRemove.length) return;

    // Apply removes first, then adds/updates. Removes by engine id;
    // the engine rebakes affected tiles internally.
    if (toRemove.length) {
      const engineIds: number[] = [];
      for (const hid of toRemove) {
        const eid = hushToEngine.get(hid);
        if (eid !== undefined) {
          engineIds.push(eid);
          hushToEngine.delete(hid);
          engineToHush.delete(eid);
        }
        lastSeen.delete(hid);
      }
      if (engineIds.length) engine.removeStrokes(engineIds);
    }

    for (const ds of toAdd) {
      const engineStroke = hushToEngineStroke(ds);
      hushToEngine.set(ds.id, engineStroke.id);
      engineToHush.set(engineStroke.id, ds.id);
      lastSeen.set(ds.id, ds);
      engine.insertStrokeAt(engineStroke, engine.getStrokes().length);
    }

    // Updates: route through setStrokePoints / setStrokesStyleMap
    // where possible so only affected tiles rebake. If points
    // changed we have to re-set points; otherwise a style map does.
    if (toUpdate.length) {
      const styleMap = new Map<number, {
        color?: string; size?: number; brushId?: string;
        mode?: "normal" | "highlighter";
      }>();
      let pocketedFlagChanged = false;
      // Capture before / after pocketed stroke bboxes so the drawing
      // layer can stash / unstash BEFORE the rebake removes them
      // from the done canvas. Without the stash the pocket tray
      // would render empty after delta #8 hides pocketed strokes.
      const pocketEntering: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
      const pocketLeaving: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
      for (const ds of toUpdate) {
        const eid = hushToEngine.get(ds.id);
        if (eid === undefined) continue;
        const prev = lastSeen.get(ds.id);
        const engineStroke = engine.getStrokes().find((s) => s.id === eid);
        if (!engineStroke) continue;
        // Points: compare array identity first. Callers that change
        // point sequences replace the array. DrawShape.points are
        // world coords; engine wants wrapper-local — translate.
        if (prev && prev.points !== ds.points) {
          engine.setStrokePoints(eid, ds.points.map(worldToLocal));
        }
        // Style: detect any of color/size/brushId/mode changed.
        if (!prev ||
            prev.color !== ds.color || prev.size !== ds.size ||
            prev.brushId !== ds.brushId || prev.mode !== ds.mode) {
          styleMap.set(eid, {
            color: ds.colorIsAuto ? resolveAutoColor() : ds.color,
            size: ds.size,
            brushId: ds.brushId,
            mode: ds.mode,
          });
        }
        // Detect pocketed-flag flip so we know to rebake the done
        // canvas. Engine's isStrokeHidden now consults `pocketed`
        // (delta #8), so flipping the flag + rebaking clears the
        // stroke from world-space paint on pocket-in and restamps
        // it on pocket-out.
        const wasPocketed = !!(prev && prev.pocketed);
        const isPocketed = !!ds.pocketed;
        if (wasPocketed !== isPocketed) {
          pocketedFlagChanged = true;
          const bbox = bboxFromPoints(ds.points, ds.size);
          if (!wasPocketed && isPocketed) pocketEntering.push(bbox);
          else if (wasPocketed && !isPocketed) pocketLeaving.push(bbox);
        }
        // Mutate engine stroke's custom fields directly for flags
        // the engine ignores for rendering decisions outside
        // isStrokeHidden: groupId / parentId / colorIsAuto have no
        // visual effect. `pocketed` is consulted by isStrokeHidden
        // on the next paint after we call fullRebake.
        engineStroke.colorIsAuto = ds.colorIsAuto;
        engineStroke.groupId = ds.groupId;
        engineStroke.parentId = ds.parentId;
        engineStroke.pocketed = ds.pocketed;
        lastSeen.set(ds.id, ds);
      }
      if (styleMap.size) engine.setStrokesStyleMap(styleMap);
      // Stash/unstash BEFORE the rebake — the stash reads from the
      // done canvas, and fullRebake() is about to remove these
      // strokes (for pocketEntering) or restore them (for leaving).
      for (const bbox of pocketEntering) engine.stashPocketRegion(bbox);
      for (const bbox of pocketLeaving) engine.unstashPocketRegion(bbox);
      if (pocketedFlagChanged) engine.fullRebake();
    }
  }

  /** Stroke-points bbox including a padding for stamp radius, in world
   *  coords. Mirrors the engine's computeBBox pad. */
  function bboxFromPoints(points: DrawPoint[], size: number) {
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = points[0].x, minY = points[0].y;
    let maxX = points[0].x, maxY = points[0].y;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = size + 2;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  /** Wholesale replacement — called at init and can be re-called on
   *  notebook-load. Clears all engine strokes, rebuilds from
   *  state.shapes, issues one fullRebake. */
  function bulkReplaceFromState() {
    batching = true;
    inDiff = true;
    try {
      // Clear everything the engine knows.
      const existingEngineIds = engine.getStrokes().map((s) => s.id);
      if (existingEngineIds.length) engine.removeStrokes(existingEngineIds);
      lastSeen.clear();
      hushToEngine.clear();
      engineToHush.clear();

      for (const s of state.shapes) {
        if (s.type !== "draw") continue;
        const ds = s as DrawShape;
        const engineStroke = hushToEngineStroke(ds);
        hushToEngine.set(ds.id, engineStroke.id);
        engineToHush.set(engineStroke.id, ds.id);
        lastSeen.set(ds.id, ds);
        engine.insertStrokeAt(engineStroke, engine.getStrokes().length);
      }
      // One repaint at the end rather than per-insert.
      engine.fullRebake();
    } finally {
      batching = false;
      inDiff = false;
    }
  }

  /** Stroke id generation for external adds. The engine's internal
   *  counter starts at 1; using a large offset keeps our externally-
   *  allocated ids clear of engine-allocated ids permanently. */
  let nextExternalEngineId = 1_000_000;
  function allocExternalEngineId(): number {
    return nextExternalEngineId++;
  }

  /** Convert a hush DrawShape into the engine's stroke shape.
   *  Points go world → wrapper-local here. */
  function hushToEngineStroke(ds: DrawShape): EngineStroke {
    const engineId = allocExternalEngineId();
    const color = ds.colorIsAuto ? resolveAutoColor() : ds.color;
    const engineLayerId = findEngineLayerIdForHushLayer(ds.layerId);
    return {
      id: engineId,
      tool: "draw",
      color,
      size: ds.size,
      brush: ds.brushId,
      mode: ds.mode,
      layerId: engineLayerId,
      isPen: false,
      points: ds.points.map(worldToLocal),
      ...(ds.colorIsAuto ? { colorIsAuto: true } : {}),
      ...(ds.groupId ? { groupId: ds.groupId } : {}),
      ...(ds.parentId ? { parentId: ds.parentId } : {}),
      ...(ds.pocketed ? { pocketed: ds.pocketed } : {}),
    };
  }

  /** Hush layerId → engine numeric id. Falls back to the engine's
   *  active layer if the hush id hasn't been mirrored yet (shouldn't
   *  happen in normal flow — `syncLayers` runs before shapes diff). */
  function findEngineLayerIdForHushLayer(hushLayerId: string): number {
    const id = hushLayerToEngine.get(hushLayerId);
    return id !== undefined ? id : engine.getActiveLayerId();
  }

  /** Engine numeric id → hush string id. Falls back to the current
   *  active hush layer if unknown. */
  function findHushLayerIdForEngineLayer(engineLayerId: number): string {
    const id = engineLayerToHush.get(engineLayerId);
    return id !== undefined ? id : state.activeLayerId;
  }

  /** Reconcile state.layers into the engine's layer list. Runs on
   *  init and on every "layers" notify. Works per-op (add / remove /
   *  rename / move / toggle hidden-or-locked) rather than rebuilding
   *  wholesale so strokes don't get orphaned by layer churn. */
  function syncLayers(): void {
    const current = state.layers;
    const currentIds = new Set(current.map((l) => l.id));

    // Removes first, so moves later in the pass don't bump indexes
    // we'd otherwise have trouble reading.
    for (const prev of lastLayersSnap) {
      if (!currentIds.has(prev.id)) {
        const eid = hushLayerToEngine.get(prev.id);
        if (eid !== undefined) {
          engine.deleteLayer(eid);
          hushLayerToEngine.delete(prev.id);
          engineLayerToHush.delete(eid);
        }
      }
    }

    // Adds second. Use atIndex so new layers land in the right
    // z-position on first paint.
    for (let i = 0; i < current.length; i++) {
      const hl = current[i];
      if (hushLayerToEngine.has(hl.id)) continue;
      const idHint = nextExternalEngineLayerId++;
      engine.createLayer({
        idHint,
        name: hl.name,
        atIndex: i,
        locked: hl.locked,
        hidden: hl.hidden,
      });
      hushLayerToEngine.set(hl.id, idHint);
      engineLayerToHush.set(idHint, hl.id);
    }

    // Updates (rename / hidden / locked) on existing layers.
    for (const hl of current) {
      const eid = hushLayerToEngine.get(hl.id);
      if (eid === undefined) continue;
      const engineLayer = engine.getLayerById(eid);
      if (!engineLayer) continue;
      if (engineLayer.name !== hl.name) engine.renameLayer(eid, hl.name);
      if (engineLayer.hidden !== hl.hidden) engine.setLayerHidden(eid, hl.hidden);
      if (engineLayer.locked !== hl.locked) engine.setLayerLocked(eid, hl.locked);
    }

    // Reorder: engine's getLayers() returns top-first, matching
    // state.layers. For each layer in hush order, move the matching
    // engine layer to the right index. Do this back-to-front so
    // earlier moves don't shift later target indexes.
    for (let want = 0; want < current.length; want++) {
      const hl = current[want];
      const eid = hushLayerToEngine.get(hl.id);
      if (eid === undefined) continue;
      const engineLayers = engine.getLayers();
      const actual = engineLayers.findIndex((l) => l.id === eid);
      if (actual === want) continue;
      engine.moveLayer(actual, want);
    }

    // Active layer.
    const activeEngineId = hushLayerToEngine.get(state.activeLayerId);
    if (activeEngineId !== undefined && engine.getActiveLayerId() !== activeEngineId) {
      engine.setActiveLayer(activeEngineId);
    }

    lastLayersSnap = current.slice();
  }

  /** Engine id lookup for drag-drivers that need to translate hush
   *  selections into engine strokes. */
  function getEngineStrokeId(hushId: string): number | undefined {
    return hushToEngine.get(hushId);
  }

  /** Reverse lookup for bridging engine-selection ids back into Hush's
   *  state.selectedIds (which is a Set of string shape ids). */
  function getHushStrokeId(engineId: number): string | undefined {
    return engineToHush.get(engineId);
  }

  /** Pause the shim's state→engine diff while a hush-level drag
   *  drives the engine's previewTransform directly. No-op if already
   *  paused. */
  function pauseForDrag(): void { pausedForDrag = true; }

  /** Resume. Rebuild `lastSeen` from the current state.shapes so the
   *  drag's accumulated point mutations don't get pushed to the
   *  engine (the engine already committed the equivalent transform
   *  separately via commitTransform). */
  function resumeForDrag(): void {
    if (!pausedForDrag) return;
    pausedForDrag = false;
    lastSeen.clear();
    for (const s of state.shapes) {
      if (s.type === "draw") lastSeen.set(s.id, s as DrawShape);
    }
  }

  return {
    onEngineStrokeAdded,
    onEngineStrokesRemoved,
    onEngineStrokesTransformed,
    destroy,
    /** Call after a wholesale state.shapes replacement (e.g. file-open)
     *  to rebuild the engine's stroke list and rebake once. */
    bulkReplaceFromState,
    getEngineStrokeId,
    getHushStrokeId,
    pauseForDrag,
    resumeForDrag,
    /** True when the shim is mid-diff (state→engine sync). Engine
     *  callbacks fired during this window represent reflections of an
     *  external state change (typically undo/redo), not user actions,
     *  so the drawing layer should skip recording history. */
    isDiffing: () => inDiff,
  };
}
