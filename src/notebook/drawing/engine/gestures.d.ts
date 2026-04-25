export function createGestures(opts: {
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  strokeEngine: object;
  selectionEngine: object;
  onUndo?: () => void;
  onRedo?: () => void;
  onPanStart?: () => void;
  onPanMove?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  onPinchStart?: (mid: { x: number; y: number }, dist: number) => void;
  onPinchMove?: (mid: { x: number; y: number }, dist: number) => void;
  onPinchEnd?: () => void;
}): { isGesturing: () => boolean };
