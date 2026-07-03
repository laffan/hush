import type { Shape, Layer } from "./types";
import type { FlowEdge } from "./flowchart";

const MAX_HISTORY = 100;

/** A full undoable notebook state: shapes plus the flowchart edges and
 *  layer list that travel with them. Historically only `shapes` was
 *  captured, so undoing e.g. an edge delete restored the shapes but not
 *  the edge — the checkpoint now carries everything the canvas needs to
 *  return to a consistent state. */
export interface NotebookCheckpoint {
  shapes: Shape[];
  flowEdges: FlowEdge[];
  layers: Layer[];
}

/**
 * Snapshot-based undo/redo manager.
 *
 * History is an array of checkpoints (full state snapshots). The index
 * points to the "current" checkpoint. record() appends a new checkpoint
 * after the current index (discarding any redo entries). undo()/redo()
 * move the index and return the checkpoint to restore.
 */
export class UndoManager {
  private _history: NotebookCheckpoint[] = [];
  private _index = -1;

  /** Capture the initial state. Call once on startup / after loading shapes. */
  init(checkpoint: NotebookCheckpoint) {
    this._history = [structuredClone(checkpoint)];
    this._index = 0;
  }

  /** Record the state after a completed action (creates a new checkpoint). */
  record(checkpoint: NotebookCheckpoint) {
    // Discard any redo entries past the current index
    this._history.splice(this._index + 1);
    this._history.push(structuredClone(checkpoint));
    // Enforce max history
    if (this._history.length > MAX_HISTORY) {
      this._history.shift();
    }
    this._index = this._history.length - 1;
  }

  /** Go back one checkpoint. Returns the state to restore, or null if at the start. */
  undo(): NotebookCheckpoint | null {
    if (this._index <= 0) return null;
    this._index--;
    return structuredClone(this._history[this._index]);
  }

  /** Go forward one checkpoint. Returns the state to restore, or null if at the end. */
  redo(): NotebookCheckpoint | null {
    if (this._index >= this._history.length - 1) return null;
    this._index++;
    return structuredClone(this._history[this._index]);
  }

  get canUndo(): boolean { return this._index > 0; }
  get canRedo(): boolean { return this._index < this._history.length - 1; }
}
