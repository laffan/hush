export function createSelectionEngine(opts: {
  svg: SVGElement;
  layer: SVGElement;
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  strokeEngine: object;
  isSelectable?: (stroke: any) => boolean;
  onExit?: () => void;
  /** Hush delta #32 — completed lasso / marquee polygon in engine-local
   *  coords. When supplied the engine skips its own stroke-only hit
   *  test and the host resolves the region across every shape type. */
  onLassoRegion?: (poly: number[][], info: { marquee: boolean }) => void;
  onLassoComplete?: (evt: { selected: boolean }) => void;
  onSelectionDeleted?: () => void;
  onDragStart?: (kind: "move" | "resize" | "rotate", ids: Set<number>) => void;
  onDragMove?: (evt: { kind: string; dx: number; dy: number }) => void;
  /** `cancelled` is true when cancelActive() aborted the drag. */
  onDragEnd?: (cancelled?: boolean) => void;
  /** Hush delta #33 — an in-flight lasso / marquee was abandoned. */
  onRegionCancel?: () => void;
  /** Hush delta #35 — a touch grabbed a live selection and released
   *  without dragging it. */
  onRegionTap?: () => void;
}): {
  activate(): void;
  deactivate(): void;
  startLassoAtPointer(pointerId: number, point: { x: number; y: number }): void;
  /** Hush delta #33 — same handoff for the rectangle marquee. */
  startMarqueeAtPointer(pointerId: number, point: { x: number; y: number }): void;
  /** Hush delta #35 — adopt a move that began in the stroke engine.
   *  False when there's no bbox to move. */
  startMoveAtPointer(pointerId: number, point: { x: number; y: number }): boolean;
  hasSelection(): boolean;
  /** True while a lasso / marquee is mid-gesture. */
  isRegionActive(): boolean;
  getSelectedIds(): Set<number>;
  setSelectedIds(ids: Iterable<number>): void;
  setBboxClickable(enabled: boolean): void;
  setChromeHidden(hidden: boolean): void;
  setChromeInteractive(enabled: boolean): void;
  /** Hush delta #34 — bounds (engine-local) of the selected shapes the
   *  engine doesn't own, unioned into the bbox. */
  setExternalBounds(bbox: { x: number; y: number; w: number; h: number } | null): void;
  /** Hush delta #34 — keep the bbox, drop the resize / rotate handles. */
  setHandlesHidden(hidden: boolean): void;
  setEventActive(active: boolean): void;
  beginExternalDrag(): void;
  endExternalDrag(): void;
  refreshBBox(): void;
  cancelActive(): void;
};
