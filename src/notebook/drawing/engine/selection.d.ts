export function createSelectionEngine(opts: {
  svg: SVGElement;
  layer: SVGElement;
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  strokeEngine: object;
  isSelectable?: (stroke: any) => boolean;
  onExit?: () => void;
  onLassoComplete?: (evt: { selected: boolean }) => void;
  onSelectionDeleted?: () => void;
}): {
  activate(): void;
  deactivate(): void;
  startLassoAtPointer(pointerId: number, point: { x: number; y: number }): void;
  hasSelection(): boolean;
  getSelectedIds(): Set<number>;
  setSelectedIds(ids: Iterable<number>): void;
  setBboxClickable(enabled: boolean): void;
  refreshBBox(): void;
  cancelActive(): void;
};
