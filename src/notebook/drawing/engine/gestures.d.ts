export function createGestures(opts: {
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  strokeEngine: object;
  selectionEngine: object;
  onUndo?: () => void;
  onRedo?: () => void;
}): void;
