/**
 * Public interface contract for the drawing layer. Lives in its own
 * file so callers (notebook bridge, brush-slots, tool-panel) can import
 * the shape without dragging the implementation into their bundle.
 */
import type { Camera, DrawingSlot } from "../types";
import type { CanvasTheme } from "../themes";

export type EngineTool = "draw" | "erase" | "slice" | "select";

/** Per-stroke style snapshot used by the retroactive styling path. */
export interface SelectionStyleEntry {
  color: string;
  size: number;
  brushId: string;
  mode: "normal" | "highlighter";
  colorIsAuto: boolean;
  colorIsHeading: boolean;
}

/** Style patch accepted by `applyStyleToSelection`. Any subset of
 *  fields is allowed; missing fields are left as-is on each stroke. */
export interface SelectionStylePatch {
  color?: string;              // "auto", "heading", or hex
  size?: number;
  brushId?: string;
  mode?: "normal" | "highlighter";
}

/** Returned handle. The drawing-mode controller (toolbar, flyout,
 *  selection-drag glue) drives these methods. */
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
  /** Configure how long a draw-mode press must hold before it
   *  promotes into a lasso. Exposed as a user setting in the toolbar
   *  (slider 500–2000 ms). */
  setLassoHoldMs(ms: number): void;
  /** Toggle pencil-only stroke gating. When on, only `pointerType="pen"`
   *  (or mouse) can start a stroke; finger touches fall through to the
   *  notebook canvas. Wired by the iOS pencil bridge. */
  setPencilOnly(on: boolean): void;
  /** Render a swatch preview of a slot into a target canvas, using
   *  the engine's atlas. */
  renderSwatch(canvas: HTMLCanvasElement, slot: DrawingSlot): void;
  /** Render a horizontal demo stroke for the slot, walking stamps from
   *  the canvas's left edge to its right edge so thickness, color, and
   *  spacing all read at a glance. The flyout uses this in place of a
   *  static "Pen" header. */
  renderDemoStroke(canvas: HTMLCanvasElement, slot: DrawingSlot): void;
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
   *  grouped-drawing thumbnails into the pocket tray / shelf. */
  blitWorldRegion(ctx: CanvasRenderingContext2D, worldBbox: { minX: number; minY: number; maxX: number; maxY: number }): void;
  /** Blit the entire non-pocketed stroke canvas ("done") into `ctx` at
   *  its current transform, positioned so world coords line up. Used by
   *  the export path. */
  blitDoneCanvasAtWorldOrigin(ctx: CanvasRenderingContext2D): void;
  /** Render ONLY the strokes matching the given hush shape ids into
   *  `ctx` (whose transform must already map world coords → target
   *  pixels), in canonical z-order. Unlike the done-canvas blits this
   *  re-renders each stroke through the atlas, so nothing that overlaps
   *  the same region leaks in. Used by the selection rasterizer.
   *  `colorOverrides` retints theme-tracking strokes (colorIsAuto /
   *  colorIsHeading) for a specific appearance without touching the
   *  engine's stored colours — the dual light/dark raster path. */
  renderStrokesTo(
    ctx: CanvasRenderingContext2D,
    hushIds: Iterable<string>,
    colorOverrides?: { foreground: string; headingColor: string },
  ): void;

  /** True while a stroke is in flight. The autosave pipeline defers
   *  writes until pen-up so the IPC marshal can't starve pointer
   *  events mid-stroke. */
  hasActiveStroke(): boolean;

  // ----- hush select-drag integration -----
  //
  // For DrawShape selections, Hush's select-drag routes move updates
  // through the engine's previewTransform so dragging N strokes is
  // ~free (one GPU preview per frame, no setStrokePoints churn).
  beginSelectionDrag(hushIds: Iterable<string>): void;
  updateSelectionDrag(totalDx: number, totalDy: number): void;
  endSelectionDrag(): void;

  // ----- retroactive selection styling (used by the flyout) -----
  hasSelection(): boolean;
  snapshotSelectedStyle(): Map<number, SelectionStyleEntry>;
  applyStyleToSelection(patch: SelectionStylePatch): void;
  commitStyleHistory(beforeMap: Map<number, SelectionStyleEntry>): void;
  /** Tear down event listeners + DOM. */
  destroy(): void;
}
