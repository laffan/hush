/**
 * Desktop thumbnail stacks — drop one file thumbnail onto another and
 * they pile up: members cascade at 30 px offsets (right + down), their
 * captions hide (desktop-hover shows the pile's names below it on
 * hover), and the pile drags as one because members share a groupId.
 * ⌘-dragging a member pulls it back out (state.ts skips the group
 * promotion for that gesture; the release itself happens here on
 * pointer-up).
 *
 * A stack is: `fileRef.stackId` shared across members + `groupId ===
 * stackId`, so the engine's existing group mechanics (drag, selection
 * promotion) do the heavy lifting. Everything persists through the
 * normal envelope; `normalizeDesktopStacks` heals half-states (a lone
 * member, an ungrouped member) on every rebuild.
 */

import { screenToCanvas } from "../notebook/utils.ts";
import { findShapeAtPoint } from "../notebook/state-helpers.ts";

export const STACK_OFFSET = 50;

/** Cascade a stack's members from `base` — 30 px right + down per slot,
 *  in the given order (later = higher z, drawn on top). */
function cascadePositions(members, base) {
  return members.map((s, i) => ({
    ...s,
    position: { x: base.x + i * STACK_OFFSET, y: base.y + i * STACK_OFFSET },
  }));
}

/** Union bounds of a stack (by stackId) — used by the hover overlay to
 *  park the name list below the pile. */
export function stackBounds(shapes, stackId, fontFamily) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    if (s.fileRef?.stackId !== stackId) continue;
    minX = Math.min(minX, s.position.x);
    minY = Math.min(minY, s.position.y);
    maxX = Math.max(maxX, s.position.x + (s.width || 0));
    maxY = Math.max(maxY, s.position.y + (s.height || 0));
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Members of a stack in visual order (array order = z order). */
export function stackMembers(shapes, stackId) {
  return shapes.filter((s) => s.fileRef?.stackId === stackId);
}

/** Heal stack bookkeeping after loads / reconciles: an ungrouped member
 *  (e.g. the user ran Ungroup) drops its stackId, and a stack reduced
 *  to a single member dissolves. Pure — returns a new array when
 *  anything changed, the input otherwise. */
export function normalizeDesktopStacks(shapes) {
  const counts = new Map();
  for (const s of shapes) {
    if (s.fileRef?.stackId && s.groupId === s.fileRef.stackId) {
      counts.set(s.fileRef.stackId, (counts.get(s.fileRef.stackId) || 0) + 1);
    }
  }
  let changed = false;
  const next = shapes.map((s) => {
    const sid = s.fileRef?.stackId;
    if (!sid) return s;
    const grouped = s.groupId === sid;
    if (grouped && (counts.get(sid) || 0) >= 2) return s;
    changed = true;
    const fileRef = { ...s.fileRef };
    delete fileRef.stackId;
    const out = { ...s, fileRef };
    if (grouped) delete out.groupId;
    return out;
  });
  return changed ? next : shapes;
}

/** Merge the dragged fileRef shapes (plus their existing stack mates)
 *  into the target's stack. Returns the new shapes array. */
function mergeIntoStack(shapes, draggedIds, target) {
  const stackId = target.fileRef.stackId || crypto.randomUUID();

  const memberIds = new Set();
  const collect = (s) => {
    if (s.fileRef?.stackId) {
      for (const m of shapes) if (m.fileRef?.stackId === s.fileRef.stackId) memberIds.add(m.id);
    } else {
      memberIds.add(s.id);
    }
  };
  collect(target);
  for (const s of shapes) if (draggedIds.has(s.id) && s.fileRef) collect(s);

  // Order: target's existing pile first (array order), then the dragged
  // shapes in array order — the drop lands on top.
  const targetFirst = [];
  const rest = [];
  for (const s of shapes) {
    if (!memberIds.has(s.id)) continue;
    if (target.fileRef.stackId ? s.fileRef?.stackId === target.fileRef.stackId : s.id === target.id) {
      targetFirst.push(s);
    } else {
      rest.push(s);
    }
  }
  const ordered = [...targetFirst, ...rest].map((s) => ({
    ...s,
    groupId: stackId,
    fileRef: { ...s.fileRef, stackId },
  }));
  const base = targetFirst[0]?.position || ordered[0].position;
  const placed = cascadePositions(ordered, { ...base });

  // Members become contiguous at the top of the z-order so the cascade
  // reads front-to-back correctly.
  return [...shapes.filter((s) => !memberIds.has(s.id)), ...placed];
}

/** Move a pile member to the top (end of the cascade) — clicking its
 *  title in the hover list. Returns the new shapes array. */
export function moveToTopOfStack(shapes, shapeId) {
  const shape = shapes.find((s) => s.id === shapeId);
  const stackId = shape?.fileRef?.stackId;
  if (!stackId) return shapes;
  const members = stackMembers(shapes, stackId);
  if (members.length < 2 || members[members.length - 1]?.id === shapeId) return shapes;
  const base = { ...members[0].position };
  const reordered = [...members.filter((s) => s.id !== shapeId), shape];
  const placed = cascadePositions(reordered, base);
  const memberIds = new Set(placed.map((s) => s.id));
  return [...shapes.filter((s) => !memberIds.has(s.id)), ...placed];
}

/** Release `shape` from its stack (⌘-drag pull-out), re-cascading what
 *  remains. Returns the new shapes array. */
function releaseFromStack(shapes, shapeId) {
  const released = shapes.find((s) => s.id === shapeId);
  const stackId = released?.fileRef?.stackId;
  if (!stackId) return shapes;
  let next = shapes.map((s) => {
    if (s.id !== shapeId) return s;
    const fileRef = { ...s.fileRef };
    delete fileRef.stackId;
    const out = { ...s, fileRef };
    delete out.groupId;
    return out;
  });
  // Re-cascade the remaining pile from its current base.
  const remaining = next.filter((s) => s.fileRef?.stackId === stackId);
  if (remaining.length >= 2) {
    const base = { ...remaining[0].position };
    const placedById = new Map(cascadePositions(remaining, base).map((s) => [s.id, s]));
    next = next.map((s) => placedById.get(s.id) || s);
  }
  return normalizeDesktopStacks(next);
}

/**
 * Wire the stack gestures onto a Desktop canvas. Listens after the
 * engine's own pointer handlers (registration order), so on pointer-up
 * the drag has already committed shape positions. Returns a cleanup fn.
 */
export function attachDesktopStacking(canvasEl, notesCanvas, opts = {}) {
  const state = notesCanvas.state;
  let down = null; // { x, y, shapeId, stackId, cmd }
  let moved = false;

  const onPointerDown = (e) => {
    down = null;
    moved = false;
    if (e.button !== 0 || state.tool !== "select" || state.isPanning) return;
    const rect = canvasEl.getBoundingClientRect();
    const world = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);
    const hit = findShapeAtPoint(world, state.shapes, state.fontFamily);
    if (!hit || hit.type !== "image" || !hit.fileRef || hit.pocketed) return;
    down = {
      x: e.clientX, y: e.clientY,
      shapeId: hit.id,
      stackId: hit.fileRef.stackId || null,
      cmd: e.metaKey || e.ctrlKey,
    };
  };

  const onPointerMove = (e) => {
    if (!down || moved) return;
    if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) moved = true;
  };

  const onPointerUp = (e) => {
    const gesture = down;
    down = null;
    if (!gesture || !moved) return;
    if (state.tool !== "select") return;

    // ⌘-drag on a stacked member: it was dragged out solo (state.ts
    // skipped the group promotion) — release it from the pile.
    if (gesture.cmd && gesture.stackId) {
      state.shapes = releaseFromStack(state.shapes, gesture.shapeId);
      state.recordHistory();
      state.notify("shapes");
      opts.onStacksChanged?.();
      return;
    }
    if (gesture.cmd) return;

    // Plain drag: dropping fileRef thumbnails onto another thumbnail
    // stacks them. The dragged set is whatever the engine just moved —
    // the selection — filtered to file thumbnails.
    const draggedIds = new Set(
      state.shapes.filter((s) => state.selectedIds.has(s.id) && s.type === "image" && s.fileRef)
        .map((s) => s.id),
    );
    if (!draggedIds.size || !draggedIds.has(gesture.shapeId)) return;
    const rect = canvasEl.getBoundingClientRect();
    const world = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);
    const target = findShapeAtPoint(
      world,
      state.shapes.filter((s) => !draggedIds.has(s.id) && !s.pocketed),
      state.fontFamily,
    );
    if (!target || target.type !== "image" || !target.fileRef) return;

    state.shapes = mergeIntoStack(state.shapes, draggedIds, target);
    // Keep the just-dropped shapes selected (ids are unchanged).
    state.recordHistory();
    state.notify("shapes");
    opts.onStacksChanged?.();
  };

  canvasEl.addEventListener("pointerdown", onPointerDown);
  canvasEl.addEventListener("pointermove", onPointerMove);
  canvasEl.addEventListener("pointerup", onPointerUp);
  return () => {
    canvasEl.removeEventListener("pointerdown", onPointerDown);
    canvasEl.removeEventListener("pointermove", onPointerMove);
    canvasEl.removeEventListener("pointerup", onPointerUp);
  };
}
