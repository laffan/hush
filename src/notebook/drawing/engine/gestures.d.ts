export function createGestures(opts: {
  getRect: () => DOMRect | { left: number; top: number; width: number; height: number };
  pointToLocal?: (p: { x: number; y: number }) => { x: number; y: number };
  strokeEngine: object;
  selectionEngine: object;
  onUndo?: () => void;
  onRedo?: () => void;
  onGestureStart?: () => void;
  onPanStart?: () => void;
  onPanMove?: (dx: number, dy: number) => void;
  onPanEnd?: () => void;
  onPinchStart?: (mid: { x: number; y: number }, dist: number, angle: number) => void;
  onPinchMove?: (mid: { x: number; y: number }, dist: number, angle: number) => void;
  onPinchEnd?: () => void;
}): { isGesturing: () => boolean };
