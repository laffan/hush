/* src/notebook/drawing/sync-shim-types.ts
 *
 * Interface surface for the sync shim — extracted from sync-shim.ts
 * so the shim's logic file (small, reviewed on every change) stays
 * under the 700-line cap. The types are re-exported from sync-shim.ts
 * so existing importers keep working.
 */

import type { DrawPoint, Layer, Shape } from "../types";

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
  colorIsHeading?: boolean;
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
  insertStrokeAt(stroke: EngineStroke, index: number, opts?: { skipRebake?: boolean }): void;
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
  /** Repaint every pocketed stroke into the pocket stash from scratch.
   *  Called after a bulk replace, which skips the incremental
   *  stash/unstash flow (pocketed strokes are never painted to the
   *  done canvas, so `stashPocketRegion` has nothing to copy). */
  rebuildPocketStash(): void;
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
