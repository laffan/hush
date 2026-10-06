import type { GrabSession, Shape, Layer, Split, NotebookBookmark } from "./types";
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
  /** Split lines. Not shapes, so they need their own slot; without it
   *  undoing a split-line drag would put the content back and leave the
   *  lines where the drag left them. */
  splits: Split[];
  /** The in-flight grab, if any. Riding the checkpoint is what makes
   *  ⌘Z after placing a grab step back INTO the place stage (the
   *  checkpoint taken at Apply carries `stage: "place"`) instead of
   *  unwinding the whole two-stage operation at once. */
  grab: GrabSession | null;
  /** Bookmarks. Not shapes either, and Splits and Grabs move them, so
   *  undoing a line drag has to put them back with the content. */
  bookmarks?: NotebookBookmark[];
}

/** Checkpoint copy with structural sharing.
 *
 *  Shapes are shared BY REFERENCE across checkpoints and with the live
 *  `state.shapes` array — only the array itself is copied. This is what
 *  makes `recordHistory()` O(shape count) per stroke instead of a
 *  structuredClone of every point ever drawn (the clone was the single
 *  largest per-pen-up cost in long handwriting sessions, and retaining
 *  up to 100 deep copies was the memory blow-up behind the crashes).
 *
 *  LOAD-BEARING INVARIANT: a Shape must never be mutated in place once
 *  it has entered `state.shapes` — every mutation replaces the shape
 *  object (`shapes.map(s => ({ ...s, ... }))`). The drawing engine's
 *  sync shim already requires this (its diff is identity-based), and
 *  every DrawingState mutation follows it; an in-place write would now
 *  also silently rewrite history entries holding the same reference.
 *
 *  Layers and flow edges are tiny, so they're defensively copied per
 *  element in BOTH directions (record and restore) — cheap insurance
 *  against in-place edits of either list.
 *
 *  A structural-sharing side benefit: after undo/redo, unchanged shapes
 *  keep their identity, so the sync shim's diff sees only the shapes
 *  that actually differ instead of re-applying every stroke. */
function snapshot(cp: NotebookCheckpoint): NotebookCheckpoint {
  return {
    shapes: cp.shapes.slice(),
    flowEdges: (cp.flowEdges || []).map((e) => ({ ...e })),
    layers: (cp.layers || []).map((l) => ({ ...l })),
    // Splits are a handful of numbers each — copy per element, like
    // layers and edges, so an in-place line drag can't rewrite history.
    splits: (cp.splits || []).map((s) => ({ ...s })),
    bookmarks: (cp.bookmarks || []).map((b) => ({ ...b })),
    // The grab session's arrays hold live shape references (same
    // structural sharing as `shapes`); only the record itself and its
    // two lists need their own identity per checkpoint.
    grab: cp.grab
      ? {
        ...cp.grab,
        buffer: cp.grab.buffer.slice(),
        bufferSplits: cp.grab.bufferSplits.map((s) => ({ ...s })),
        bufferBookmarks: (cp.grab.bufferBookmarks || []).map((b) => ({ ...b })),
        restore: cp.grab.restore
          ? {
            shapes: cp.grab.restore.shapes.slice(),
            splits: cp.grab.restore.splits.map((s) => ({ ...s })),
            bookmarks: (cp.grab.restore.bookmarks || []).map((b) => ({ ...b })),
          }
          : null,
      }
      : null,
  };
}

/** Two shapes hold the same content: the same object, or copies whose
 *  own fields are all identical (`{ ...s, text }` with an unchanged text
 *  keeps every nested reference). */
function sameShape(a: Shape, b: Shape): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return ka.every((k) => ra[k] === rb[k]);
}

function sameRecords<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  const x = a || [], y = b || [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i] as unknown as Record<string, unknown>;
    const q = y[i] as unknown as Record<string, unknown>;
    if (p === q) continue;
    const kp = Object.keys(p);
    if (kp.length !== Object.keys(q).length || !kp.every((k) => p[k] === q[k])) return false;
  }
  return true;
}

/** A checkpoint that changes nothing against `prev`. Recording one put a
 *  step on the stack that ⌘Z then spent doing nothing visible — opening
 *  a text box and leaving it unchanged, a tap that commits nothing — so
 *  undo read as broken, needing an extra press per no-op. */
function unchanged(prev: NotebookCheckpoint, next: NotebookCheckpoint): boolean {
  if (prev.shapes.length !== next.shapes.length) return false;
  for (let i = 0; i < prev.shapes.length; i++) {
    if (!sameShape(prev.shapes[i], next.shapes[i])) return false;
  }
  return prev.grab === next.grab
    && sameRecords(prev.flowEdges, next.flowEdges)
    && sameRecords(prev.layers, next.layers)
    && sameRecords(prev.splits, next.splits)
    && sameRecords(prev.bookmarks, next.bookmarks);
}

/**
 * Snapshot-based undo/redo manager.
 *
 * History is an array of checkpoints (structurally-shared state
 * snapshots — see `snapshot()` above). The index points to the
 * "current" checkpoint. record() appends a new checkpoint after the
 * current index (discarding any redo entries). undo()/redo() move the
 * index and return the checkpoint to restore.
 */
export class UndoManager {
  private _history: NotebookCheckpoint[] = [];
  private _index = -1;

  /** Capture the initial state. Call once on startup / after loading shapes. */
  init(checkpoint: NotebookCheckpoint) {
    this._history = [snapshot(checkpoint)];
    this._index = 0;
  }

  /** Record the state after a completed action (creates a new checkpoint). */
  record(checkpoint: NotebookCheckpoint) {
    const current = this._history[this._index];
    if (current && unchanged(current, checkpoint)) return;
    // Discard any redo entries past the current index
    this._history.splice(this._index + 1);
    this._history.push(snapshot(checkpoint));
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
    return snapshot(this._history[this._index]);
  }

  /** Go forward one checkpoint. Returns the state to restore, or null if at the end. */
  redo(): NotebookCheckpoint | null {
    if (this._index >= this._history.length - 1) return null;
    this._index++;
    return snapshot(this._history[this._index]);
  }

  get canUndo(): boolean { return this._index > 0; }
  get canRedo(): boolean { return this._index < this._history.length - 1; }
}
