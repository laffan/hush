/**
 * Split / Grab interaction — the stateful half that `splits.ts` (pure
 * geometry) deliberately doesn't know about.
 *
 * Everything here takes `DrawingState` as its first argument and mutates
 * it through the same rules the rest of the canvas follows: shapes are
 * replaced, never edited in place, and every completed gesture ends in
 * one `recordHistory()`.
 *
 * The pointer entry points return `true` when they consumed the event,
 * so `DrawingState.handlePointer*` can hand off to them before running
 * its own select / text / drag-area logic.
 *
 * ### Locked layers
 *
 * Splits and grabs deliberately ignore layer *locks*. A lock stops the
 * pointer picking a shape up; a split is a cut across the document, and
 * the headline use for it — a PDF proof, whose pages sit on a locked
 * layer precisely so they can't be nudged — is exactly the case where
 * the locked material has to move. Hidden layers ARE skipped: content
 * nobody can see must not silently move or be cut.
 */

import type { Axis, Shape, Split, SplitLine } from "./types";
import type { DrawingState } from "./state";
import { generateId, computePocketLayout } from "./utils";
import {
  type ContentUnit, type SplitAction, type SplitActionRect,
  buildUnits, cutImagesAt, drawnLinePositions, hitTestSplitActions, hitTestSplits,
  idsAfter, idsBefore, idsBetween, mergeImagesAt, splitActionRects,
  translateShapes, translateSplits, withinActionCluster,
} from "./splits";

/** A split line being dragged. `carried` is resolved once, at
 *  pointer-down, so the set can't drift under the user as the content it
 *  contains crosses the line it's attached to. */
export interface SplitDragState {
  splitId: string;
  line: SplitLine;
  orientation: Axis;
  /** Pointer's world cross-axis coordinate at pointer-down. */
  startPointer: number;
  carried: Set<string>;
  /** Splits are re-derived from this pristine copy every move so the
   *  drag stays absolute rather than accumulating rounding. */
  startSplits: Split[];
  startShapes: Shape[];
  moved: boolean;
}

/** Transient hover on a split line: which line, and where along it the
 *  action cluster is anchored (screen px). */
export interface SplitHoverState {
  splitId: string;
  line: SplitLine;
  /** Anchor along the line, in screen px (x for horizontal splits). */
  anchor: number;
  /** Line position in screen px on the cross axis. */
  lineScreen: number;
  /** Action under the pointer, for the hover highlight + label. */
  active: SplitAction | null;
}

/** Live preview of where the split / grab tool would act. */
export interface SplitPreviewState {
  orientation: Axis;
  /** World cross-axis position under the cursor. */
  pos: number;
}

/**
 * A touch contact that WOULD cut a split or place a grab, held until we
 * know it was a tap.
 *
 * Mouse and pen act on pointer-down — "click and it happens" is the
 * gesture the tools describe. A finger can't: the first contact of a
 * two-finger pan is an ordinary pointer-down, so acting on it would cut
 * a split (or drop the grab buffer) every time an iPad user reached for
 * the canvas to scroll. The action is therefore deferred to pointer-up
 * and abandoned if the contact travels, or if a second finger promotes
 * the gesture (`cancelActiveInteraction`).
 */
export interface SplitTapPending {
  kind: "split" | "place";
  orientation: Axis;
  pos: number;
  client: { x: number; y: number };
}

/** Client-px travel (squared) that turns a pending tap into a gesture.
 *  Matches TOUCH_SELECT_SLOP_2 in state.ts — one slop for the canvas. */
const TAP_SLOP_2 = 25;

// ───────────────────────── shared helpers ─────────────────────────

/** Orientation the split / grab tools are currently offering. ⌘ (or
 *  Ctrl) flips the line from horizontal to vertical. */
export function toolOrientation(state: DrawingState): Axis {
  return state.splitVertical ? "vertical" : "horizontal";
}

/** Cross-axis coordinate of a world point for the given orientation. */
export function crossOf(orientation: Axis, p: { x: number; y: number }): number {
  return orientation === "horizontal" ? p.y : p.x;
}

/** Shapes a split may touch: everything except pocketed shapes (screen
 *  space, not world) and hidden layers. */
function splittableSkipIds(state: DrawingState): Set<string> {
  const skip = new Set<string>();
  const hidden = state._hiddenLayerIds();
  const canvasW = state.canvasEl?.clientWidth || 0;
  const { pocketedIds } = computePocketLayout(state.shapes, canvasW, state.fontFamily, state.pocketRightInset);
  for (const s of state.shapes) {
    if (pocketedIds.has(s.id)) skip.add(s.id);
    else if (s.layerId && hidden.has(s.layerId)) skip.add(s.id);
  }
  return skip;
}

function unitsFor(state: DrawingState, orientation: Axis, shapes?: Shape[]): ContentUnit[] {
  return buildUnits(shapes || state.shapes, orientation, state.fontFamily, splittableSkipIds(state));
}

/** Cut every standalone image the coordinate passes through. Returns the
 *  possibly-new shapes array; identity is preserved when nothing was
 *  crossed. */
function cutAt(state: DrawingState, shapes: Shape[], orientation: Axis, pos: number): Shape[] {
  const units = buildUnits(shapes, orientation, state.fontFamily, splittableSkipIds(state));
  return cutImagesAt(shapes, orientation, pos, units);
}

// ───────────────────────── split operations ─────────────────────────

/** Cut a new split at a world coordinate. Images in the way are divided
 *  into crop-masked halves, so the canvas looks identical until a line
 *  is dragged. */
export function createSplitAt(state: DrawingState, orientation: Axis, pos: number): Split {
  state.shapes = cutAt(state, state.shapes, orientation, pos);
  const split: Split = { id: generateId(), orientation, a: pos, b: pos, createdAt: Date.now() };
  state.splits = [...state.splits, split];
  state.recordHistory();
  state.notify("shapes");
  state.notify("splits");
  return split;
}

/** Remove the split lines and leave every piece of content exactly where
 *  it is — including images the split cut, which stay as two masked
 *  halves. */
export function deleteSplit(state: DrawingState, splitId: string): void {
  if (!state.splits.some((s) => s.id === splitId)) return;
  state.splits = state.splits.filter((s) => s.id !== splitId);
  state.recordHistory();
  state.notify("splits");
}

/**
 * Undo the split entirely: throw away what was written in the gap, draw
 * the two edges back together, drop the lines, and re-fuse any image the
 * split had cut.
 *
 * The clearing half is conservative. Units are removed whole, and only
 * when EVERY member is newer than the split — a group that predates the
 * split but has drifted into the gap is left alone, because this means
 * "undo the writing I did in here", not "delete whatever is in this
 * band". Anything older is carried across with the far side instead.
 *
 * The re-fusing half is what makes a collapse leave no trace: pieces of
 * one image, drawn back into contact, become that image again
 * (`mergeImagesAt`), so a split can be cut and collapsed any number of
 * times without accumulating shape records.
 */
export function collapseSplit(state: DrawingState, splitId: string): void {
  const split = state.splits.find((s) => s.id === splitId);
  if (!split) return;
  const { orientation, a, b } = split;
  const gap = b - a;

  const units = unitsFor(state, orientation);
  const byId = new Map(state.shapes.map((s) => [s.id, s]));
  const doomed = new Set<string>();
  for (const u of units) {
    if (u.center < a || u.center > b) continue;
    const allNewer = u.ids.every((id) => {
      const created = byId.get(id)?.createdAt;
      return typeof created === "number" && created > split.createdAt;
    });
    if (allNewer) for (const id of u.ids) doomed.add(id);
  }

  let shapes = doomed.size ? state.shapes.filter((s) => !doomed.has(s.id)) : state.shapes;
  let splits = state.splits.filter((s) => s.id !== splitId);
  if (gap > 0) {
    const remaining = buildUnits(shapes, orientation, state.fontFamily, splittableSkipIds(state));
    shapes = translateShapes(shapes, idsAfter(remaining, b), orientation, -gap);
    splits = translateSplits(splits, orientation, -gap, (p) => p > b);
  }
  // The two cut faces now meet at `a` — that junction is the only place
  // a merge can possibly apply.
  shapes = mergeImagesAt(shapes, orientation, a);

  state.shapes = shapes;
  state.splits = splits;
  if (doomed.size) {
    state.selectedIds = new Set([...state.selectedIds].filter((id) => !doomed.has(id)));
    state.notify("selectedIds");
  }
  state.recordHistory();
  state.notify("shapes");
  state.notify("splits");
}

// ───────────────────────── line dragging ─────────────────────────

/** Begin dragging one of a split's lines. The side it carries is
 *  resolved here, once. */
export function beginSplitDrag(state: DrawingState, split: Split, line: SplitLine, world: { x: number; y: number }): void {
  const units = unitsFor(state, split.orientation);
  const carried = line === "a" ? idsBefore(units, split.a) : idsAfter(units, split.b);
  state.splitDrag = {
    splitId: split.id,
    line,
    orientation: split.orientation,
    startPointer: crossOf(split.orientation, world),
    carried,
    startSplits: state.splits,
    startShapes: state.shapes,
    moved: false,
  };
  state.splitHover = null;
  state.notify("interaction");
}

/** Absolute re-apply of the drag from its start snapshot — never an
 *  incremental accumulation, so a dropped pointer sample can't leave the
 *  content and the line disagreeing about how far they've come. */
export function updateSplitDrag(state: DrawingState, world: { x: number; y: number }): void {
  const drag = state.splitDrag;
  if (!drag) return;
  const start = drag.startSplits.find((s) => s.id === drag.splitId);
  if (!start) return;

  let d = crossOf(drag.orientation, world) - drag.startPointer;
  // The lines may meet but never cross: dragging `a` past `b` would turn
  // the split inside out and invert which side each line carries.
  if (drag.line === "a") d = Math.min(d, start.b - start.a);
  else d = Math.max(d, start.a - start.b);
  if (d === 0 && !drag.moved) return;
  drag.moved = true;

  state.shapes = translateShapes(drag.startShapes, drag.carried, drag.orientation, d);
  const nearSide = drag.line === "a";
  const pivot = nearSide ? start.a : start.b;
  state.splits = translateSplits(
    drag.startSplits,
    drag.orientation,
    d,
    (linePos) => (nearSide ? linePos < pivot : linePos > pivot),
    drag.splitId,
  ).map((s) => {
    if (s.id !== drag.splitId) return s;
    return nearSide ? { ...s, a: start.a + d } : { ...s, b: start.b + d };
  });
  state.notify("shapes");
  state.notify("splits");
}

export function endSplitDrag(state: DrawingState): void {
  const drag = state.splitDrag;
  state.splitDrag = null;
  if (!drag) return;
  if (drag.moved) state.recordHistory();
  state.notify("interaction");
}

// ───────────────────────── grabs ─────────────────────────

/** Start sweeping a grab band. */
export function beginGrabBand(state: DrawingState, orientation: Axis, pos: number): void {
  state.grab = { stage: "band", orientation, a: pos, b: pos, buffer: [], bufferSplits: [], restore: null };
  state.grabBandDrag = { anchor: pos, edge: null };
  state.notify("grab");
}

/** Extend the sweep, or move whichever edge handle is being dragged. */
export function updateGrabBand(state: DrawingState, pos: number): void {
  const g = state.grab;
  const d = state.grabBandDrag;
  if (!g || !d || g.stage !== "band") return;
  if (d.edge === "a") state.grab = { ...g, a: Math.min(pos, g.b), b: g.b };
  else if (d.edge === "b") state.grab = { ...g, a: g.a, b: Math.max(pos, g.a) };
  else state.grab = { ...g, a: Math.min(d.anchor, pos), b: Math.max(d.anchor, pos) };
  state.notify("grab");
}

/** Finish a sweep / handle drag. A band that never opened is discarded —
 *  clicking with the grab tool does nothing, by design. */
export function endGrabBand(state: DrawingState): void {
  const g = state.grab;
  state.grabBandDrag = null;
  if (!g || g.stage !== "band") return;
  if (g.b - g.a < 1 / Math.max(state.camera.zoom, 0.01)) {
    state.grab = null;
  }
  state.notify("grab");
}

/**
 * Lift the band's content into the buffer and draw the two edges
 * together, closing the space it occupied.
 *
 * The edges are cut first (so an image the band crosses contributes its
 * middle slice and keeps its head and tail), then units whose centre
 * lies inside the band are moved into `buffer` with their coordinates
 * rebased to the band's near edge, so the place stage can drop them
 * anywhere.
 */
export function applyGrab(state: DrawingState, restoreOverride?: { shapes: Shape[]; splits: Split[] }): void {
  const g = state.grab;
  if (!g || g.stage !== "band") return;
  const { orientation, a, b } = g;
  const height = b - a;
  if (height <= 0) return;
  // `restoreOverride` exists for "grab split", which removes the split
  // before applying — Cancel has to put that split back too, so the
  // snapshot has to predate the removal.
  const restore = restoreOverride || { shapes: state.shapes, splits: state.splits };

  let shapes = cutAt(state, state.shapes, orientation, a);
  shapes = cutAt(state, shapes, orientation, b);

  const units = buildUnits(shapes, orientation, state.fontFamily, splittableSkipIds(state));
  const lifted = idsBetween(units, a, b);

  const buffer: Shape[] = [];
  const remaining: Shape[] = [];
  for (const s of shapes) (lifted.has(s.id) ? buffer : remaining).push(s);

  // Splits entirely inside the band travel with the content; they're
  // rebased alongside it so a grabbed region keeps its internal
  // structure when it lands somewhere else.
  const bufferSplits: Split[] = [];
  const keptSplits: Split[] = [];
  for (const s of state.splits) {
    if (s.orientation === orientation && s.a >= a && s.b <= b) bufferSplits.push({ ...s, a: s.a - a, b: s.b - a });
    else keptSplits.push(s);
  }

  const afterUnits = buildUnits(remaining, orientation, state.fontFamily, splittableSkipIds(state));
  const pulled = idsAfter(afterUnits, b);
  state.shapes = translateShapes(remaining, pulled, orientation, -height);
  state.splits = translateSplits(keptSplits, orientation, -height, (p) => p > b);
  state.selectedIds = new Set();

  state.grab = {
    stage: "place",
    orientation,
    a,
    b,
    buffer: rebase(buffer, orientation, -a),
    bufferSplits,
    restore,
  };
  state.recordHistory();
  state.notify("shapes");
  state.notify("splits");
  state.notify("selectedIds");
  state.notify("grab");
}

/**
 * Drop the buffer at `pos`: everything below is pushed down by the
 * grabbed height, a split is cut around the landing zone, and the
 * buffered content (and any splits that travelled with it) is rebased
 * into the gap.
 */
export function placeGrab(state: DrawingState, pos: number): void {
  const g = state.grab;
  if (!g || g.stage !== "place") return;
  const { orientation } = g;
  const height = g.b - g.a;

  let shapes = cutAt(state, state.shapes, orientation, pos);
  const units = buildUnits(shapes, orientation, state.fontFamily, splittableSkipIds(state));
  shapes = translateShapes(shapes, idsAfter(units, pos), orientation, height);

  const landed = rebase(g.buffer, orientation, pos);
  state.shapes = [...shapes, ...landed];
  state.splits = [
    ...translateSplits(state.splits, orientation, height, (p) => p > pos),
    { id: generateId(), orientation, a: pos, b: pos + height, createdAt: Date.now() },
    ...g.bufferSplits.map((s) => ({ ...s, id: generateId(), a: s.a + pos, b: s.b + pos })),
  ];
  // A placed grab leaves nothing selected. Selecting what landed reads
  // as a live selection the user didn't make — on a proof it puts
  // handles around the page image that came along for the ride, and the
  // next tap on the canvas is spent dismissing it.
  state.selectedIds = new Set();
  state.grab = null;
  state.recordHistory();
  state.notify("shapes");
  state.notify("splits");
  state.notify("selectedIds");
  state.notify("grab");
}

/** Abandon the grab at whatever stage it reached. During the band stage
 *  nothing has moved yet, so this is a plain dismissal; after Apply the
 *  pre-lift snapshot goes back verbatim. */
export function cancelGrab(state: DrawingState): void {
  const g = state.grab;
  if (!g) return;
  state.grab = null;
  state.grabBandDrag = null;
  if (g.restore) {
    state.shapes = g.restore.shapes;
    state.splits = g.restore.splits;
    state.selectedIds = new Set();
    state.recordHistory();
    state.notify("shapes");
    state.notify("splits");
    state.notify("selectedIds");
  }
  state.notify("grab");
}

/** Turn an existing split's gap into a grab: lift what's inside it, drop
 *  the split, and hand the user the place bar. */
export function grabSplit(state: DrawingState, splitId: string): void {
  const split = state.splits.find((s) => s.id === splitId);
  // A split that was never opened has no gap and so nothing to grab —
  // leave it alone rather than handing the user an empty buffer.
  if (!split || split.b <= split.a) return;
  const restore = { shapes: state.shapes, splits: state.splits };
  state.splits = state.splits.filter((s) => s.id !== splitId);
  state.grab = {
    stage: "band",
    orientation: split.orientation,
    a: split.a,
    b: split.b,
    buffer: [],
    bufferSplits: [],
    restore: null,
  };
  state.splitHover = null;
  applyGrab(state, restore);
}

function rebase(shapes: Shape[], orientation: Axis, d: number): Shape[] {
  const ids = new Set(shapes.map((s) => s.id));
  return translateShapes(shapes, ids, orientation, d);
}

// ───────────────────────── pointer routing ─────────────────────────

/** Screen-space action rects for the current hover, or an empty list. */
export function hoverActionRects(state: DrawingState): SplitActionRect[] {
  const hv = state.splitHover;
  if (!hv) return [];
  const split = state.splits.find((s) => s.id === hv.splitId);
  if (!split) return [];
  return splitActionRects(split.orientation, hv.line, hv.lineScreen, hv.anchor);
}

/**
 * Pointer-down routing for splits and grabs. Runs ahead of the regular
 * tool logic in `DrawingState.handlePointerDown`.
 *
 * Order matters: a hovered action button wins over the line under it,
 * the line wins over creating a new split on top of it, and the place
 * bar wins over everything while a grab is waiting to land.
 */
export function splitPointerDown(
  state: DrawingState,
  screen: { x: number; y: number },
  world: { x: number; y: number },
  e: { pointerType: string; clientX: number; clientY: number },
): boolean {
  const touch = e.pointerType === "touch";
  const client = { x: e.clientX, y: e.clientY };
  state.splitTapPending = null;

  const g = state.grab;
  if (g && g.stage === "place") {
    if (touch) state.splitTapPending = { kind: "place", orientation: g.orientation, pos: crossOf(g.orientation, world), client };
    else placeGrab(state, crossOf(g.orientation, world));
    return true;
  }

  const action = hitTestSplitActions(hoverActionRects(state), screen.x, screen.y);
  if (action && state.splitHover) {
    const id = state.splitHover.splitId;
    state.splitHover = null;
    if (action === "collapse") collapseSplit(state, id);
    else if (action === "delete") deleteSplit(state, id);
    else grabSplit(state, id);
    return true;
  }

  if (g && g.stage === "band") {
    const edge = grabEdgeUnderPointer(state, world);
    if (edge) {
      state.grabBandDrag = { anchor: edge === "a" ? g.b : g.a, edge };
      return true;
    }
  }

  // Split lines are draggable from the Select tool too — once a split
  // exists the user shouldn't have to re-pick the tool that made it.
  if (state.tool === "select" || state.tool === "split" || state.tool === "grab") {
    const hit = hitTestSplits(state.splits, world, state.camera.zoom);
    if (hit) {
      beginSplitDrag(state, hit.split, hit.line, world);
      return true;
    }
  }

  if (state.tool === "split") {
    const orientation = toolOrientation(state);
    const pos = crossOf(orientation, world);
    if (touch) state.splitTapPending = { kind: "split", orientation, pos, client };
    else createSplitAt(state, orientation, pos);
    return true;
  }

  if (state.tool === "grab") {
    const orientation = toolOrientation(state);
    beginGrabBand(state, orientation, crossOf(orientation, world));
    return true;
  }

  return false;
}

export function splitPointerMove(
  state: DrawingState,
  screen: { x: number; y: number },
  world: { x: number; y: number },
  client?: { x: number; y: number },
): boolean {
  const pending = state.splitTapPending;
  if (pending && client) {
    const dx = client.x - pending.client.x, dy = client.y - pending.client.y;
    if (dx * dx + dy * dy > TAP_SLOP_2) state.splitTapPending = null;
  }
  if (state.splitDrag) { updateSplitDrag(state, world); return true; }
  if (state.grabBandDrag && state.grab) {
    updateGrabBand(state, crossOf(state.grab.orientation, world));
    return true;
  }

  // Tool preview line under the cursor.
  if ((state.tool === "split" || state.tool === "grab") && !state.grab) {
    const orientation = toolOrientation(state);
    state.splitPreview = { orientation, pos: crossOf(orientation, world) };
    state.notify("interaction");
  } else if (state.grab?.stage === "place") {
    state.splitPreview = { orientation: state.grab.orientation, pos: crossOf(state.grab.orientation, world) };
    state.notify("interaction");
  } else if (state.splitPreview) {
    state.splitPreview = null;
    state.notify("interaction");
  }

  updateSplitHover(state, screen, world);
  return false;
}

export function splitPointerUp(
  state: DrawingState,
  screen?: { x: number; y: number },
  world?: { x: number; y: number },
  pointerType?: string,
): boolean {
  const pending = state.splitTapPending;
  if (pending) {
    state.splitTapPending = null;
    if (pending.kind === "split") createSplitAt(state, pending.orientation, pending.pos);
    else placeGrab(state, pending.pos);
    return true;
  }
  if (state.splitDrag) {
    const drag = state.splitDrag;
    endSplitDrag(state);
    // A finger that touched a split line and let go without travelling
    // is asking to see the line's actions, not to move it — the same
    // tap-to-reveal the flowchart edge badges use, and the only way a
    // touch device can reach a hover affordance at all.
    if (!drag.moved && pointerType === "touch" && screen && world) {
      revealHoverAt(state, drag.splitId, drag.line, screen, world);
    }
    return true;
  }
  if (state.grabBandDrag) { endGrabBand(state); return true; }
  return false;
}

/** Pin the action cluster to a specific line at a screen position. */
function revealHoverAt(
  state: DrawingState, splitId: string, line: SplitLine,
  screen: { x: number; y: number }, world: { x: number; y: number },
): void {
  const split = state.splits.find((s) => s.id === splitId);
  if (!split) return;
  const drawn = drawnLinePositions(split, state.camera.zoom);
  const horiz = split.orientation === "horizontal";
  const lineScreen = horiz
    ? screen.y + (drawn[line] - world.y) * state.camera.zoom
    : screen.x + (drawn[line] - world.x) * state.camera.zoom;
  state.splitHover = { splitId, line, anchor: horiz ? screen.x : screen.y, lineScreen, active: null };
  state.notify("interaction");
}

/** Hover bookkeeping for the action cluster. The anchor follows the
 *  pointer along the line, but freezes once the pointer enters the
 *  cluster — otherwise the buttons would slide away from the hand
 *  reaching for them. */
function updateSplitHover(
  state: DrawingState,
  screen: { x: number; y: number },
  world: { x: number; y: number },
): void {
  if (state.grab || state.splitDrag) {
    if (state.splitHover) { state.splitHover = null; state.notify("interaction"); }
    return;
  }
  const prev = state.splitHover;
  const rects = hoverActionRects(state);
  if (prev && withinActionCluster(rects, screen.x, screen.y)) {
    const active = hitTestSplitActions(rects, screen.x, screen.y);
    if (active !== prev.active) { state.splitHover = { ...prev, active }; state.notify("interaction"); }
    return;
  }

  const hit = hitTestSplits(state.splits, world, state.camera.zoom);
  if (!hit) {
    if (prev) { state.splitHover = null; state.notify("interaction"); }
    return;
  }
  const drawn = drawnLinePositions(hit.split, state.camera.zoom);
  const horiz = hit.split.orientation === "horizontal";
  // The cluster is chrome: it stays upright and screen-sized, so its
  // anchor is measured in screen px even when the camera is rotated.
  const lineWorld = drawn[hit.line];
  const lineScreen = horiz
    ? screen.y + (lineWorld - world.y) * state.camera.zoom
    : screen.x + (lineWorld - world.x) * state.camera.zoom;
  const anchor = horiz ? screen.x : screen.y;
  if (prev && prev.splitId === hit.split.id && prev.line === hit.line
    && Math.abs(prev.anchor - anchor) < 1 && Math.abs(prev.lineScreen - lineScreen) < 1) return;
  state.splitHover = { splitId: hit.split.id, line: hit.line, anchor, lineScreen, active: null };
  state.notify("interaction");
}

/** Which band edge (if any) a world point is close enough to grab. */
function grabEdgeUnderPointer(state: DrawingState, world: { x: number; y: number }): SplitLine | null {
  const g = state.grab;
  if (!g) return null;
  const r = 8 / Math.max(state.camera.zoom, 0.01);
  const p = crossOf(g.orientation, world);
  if (Math.abs(p - g.a) <= r) return "a";
  if (Math.abs(p - g.b) <= r) return "b";
  return null;
}

/** Escape / tool switch teardown. Returns true when something was
 *  actually dismissed, so callers can swallow the key. */
export function dismissSplitInteraction(state: DrawingState): boolean {
  if (state.splitTapPending) { state.splitTapPending = null; return true; }
  if (state.grab) { cancelGrab(state); return true; }
  if (state.splitDrag) { endSplitDrag(state); return true; }
  if (state.splitHover) { state.splitHover = null; state.notify("interaction"); return true; }
  return false;
}

