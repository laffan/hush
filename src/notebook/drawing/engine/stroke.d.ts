/* Companion declarations for stroke.js. The engine's source stays
 * plain JS — this file is the minimal structural surface that
 * TypeScript callers in `../drawing-layer.ts` and `../sync-shim.ts`
 * rely on. Loose on purpose: the engine is the source of truth and
 * we don't want shape drift. */

export function createStrokeEngine(opts: {
  svg: SVGElement;
  doneCanvas: HTMLCanvasElement;
  previewCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  eraserCursor: SVGElement;
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  getDpr?: () => number;
  brushUrl?: (id: string) => string | null;
  blitCanvas?: HTMLCanvasElement;
  /** Hush delta #38 — the highlighter bake target, its swap spare, and
   *  the multiply-blended wrapper both live in. */
  hlCanvas?: HTMLCanvasElement;
  hlBlitCanvas?: HTMLCanvasElement;
  hlHost?: HTMLElement;
  /** Hush delta #33 — a pencil-only finger dragged instead of holding;
   *  the host promotes the contact into a rectangle marquee. */
  onFingerDragSelect?: (evt: { pointerId: number; point: { x: number; y: number } }) => void;
  /** Hush delta #33 — pen touched down during a finger-started select;
   *  return true after restoring the brush to let the contact draw. */
  onPenResumeDraw?: () => boolean;
  /** Hush delta #33 — a finger tapped without drifting or holding. */
  onFingerTap?: () => void;
  onLongPress?: (e: { pointerId: number; point: { x: number; y: number } }) => void;
  onStrokeAdded?: (stroke: any, index: number) => void;
  onStrokesRemoved?: (removed: { stroke: any; index: number }[]) => void;
  onStrokesTransformed?: (entries: { id: number; before: any; after: any }[]) => void;
  onStrokesSliced?: (evt: {
    removed: { stroke: any; originalIndex: number }[];
    added: { stroke: any; finalIndex: number }[];
  }) => void;
  onBrushAtlasLoaded?: (brushId: string) => void;
  onLayersChanged?: () => void;
}): {
  setTool(t: string): void;
  cancelActiveStroke(): boolean;
  setColor(c: string): void;
  setColorAutoSource(source: "auto" | "heading" | null): void;
  setSize(n: number): void;
  setEraserSize(n: number): void;
  getEraserSize(): number;
  setBrush(id: string): void;
  setMode(m: string): void;
  /** Hush delta #38 — highlighter strokes drawn from here composite
   *  `multiply` against the page under them. */
  setBlend(on: boolean): void;
  getBlend(): boolean;
  /** Hush delta #38 — what a highlighter stroke with no `blend` of its
   *  own does. Per notebook; changing it repaints. */
  setHighlightBlendDefault(on: boolean): void;
  getBrushList(): { id: string; name: string }[];
  getCurrentBrush(): string;
  getCurrentMode(): string;
  setStreamline(v: number): void;
  setSmoothing(v: number): void;
  setSpacing(v: number): void;
  setLongPressMs(ms: number): void;
  /** Hush delta #37 — ruled-line capture for the draw tool. */
  setStraightLine(on: boolean): void;
  renderBrushSwatch(
    brushId: string,
    color: string,
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    mode?: string,
  ): void;
  resize(w: number, h: number): void;
  getStrokes(): any[];
  getDoneCanvas(): HTMLCanvasElement;
  getStrokeNode(): null;
  hasActiveStroke(): boolean;
  removeStrokes(ids: number[] | Set<number>): void;
  insertStrokeAt(stroke: any, index: number, opts?: { skipRebake?: boolean }): void;
  setStrokePoints(id: number, points: any[]): void;
  setStrokesStyle(ids: number[] | Set<number>, patch: object): void;
  setStrokesStyleMap(map: Map<number, object>): void;
  previewTransform(idsSet: Set<number>, descriptor: object | null): void;
  commitTransform(idsSet: Set<number>, fn: (x: number, y: number) => [number, number], sizeScale?: number): void;
  clear(): void;
  fullRebake(): void;
  translateAllStrokePoints(dx: number, dy: number): void;
  reAnchorTranslate(dx: number, dy: number): void;
  renderStrokeTo(ctx: CanvasRenderingContext2D, stroke: any): void;
  getLayers(): { id: number; name: string; locked: boolean; hidden: boolean }[];
  getLayerById(id: number): { id: number; name: string; locked: boolean; hidden: boolean } | null;
  getActiveLayerId(): number;
  setActiveLayer(id: number): void;
  createLayer(opts?: {
    idHint?: number;
    name?: string;
    atIndex?: number;
    locked?: boolean;
    hidden?: boolean;
  }): { layer: object; index: number } | null;
  deleteLayer(id: number): object | null;
  restoreLayerSnapshot(snap: object): void;
  renameLayer(id: number, name: string): boolean;
  setLayerLocked(id: number, locked: boolean): boolean;
  setLayerHidden(id: number, hidden: boolean): boolean;
  moveLayer(fromIdx: number, toIdx: number): boolean;
};
