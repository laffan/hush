export function createHistory(): {
  push(entry: { undo: () => void; redo: () => void }): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  isReplaying(): boolean;
  clear(): void;
};
