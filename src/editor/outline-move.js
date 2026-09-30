/**
 * Moving outline items in a Doc — by keyboard (Alt-Arrow) and by drag.
 *
 * An item never moves alone: it takes every item nested under it (its
 * "unit"), so a parent can't be torn away from its children. Both the
 * keyboard move and the drag end in the same edit — the unit's lines
 * lifted out of the block and set down somewhere else in it, re-indented
 * to the depth they land at — and both are one transaction, so ⌘Z puts
 * the whole move back.
 *
 * The drag half is surface-agnostic: `startOutlineDrag` knows nothing of
 * CodeMirror or of the pinned panel's rows. Each surface hands it the
 * items, a way to measure the ones on screen, and somewhere to draw the
 * drop marker; the in-flow outline (`outline-drag-plugin.js`) and the
 * pinned panel (`outline-dom.js`) are the two callers.
 */

/** Last item index of the unit rooted at `i` — the item plus every
 *  following item indented deeper than it. */
export function unitEnd(items, i) {
  let end = i;
  while (end + 1 < items.length && items[end + 1].depth > items[i].depth) end += 1;
  return end;
}

/** Shift a line's leading whitespace by `levels` nesting levels, two
 *  spaces a level (`outline-model.ts#indentDepth` counts a tab as one
 *  level and every two spaces as one). Outdenting takes a tab or two
 *  spaces off the front per level, and stops at the margin. */
export function reindentLine(text, levels) {
  if (!levels) return text;
  if (levels > 0) return "  ".repeat(levels) + text;
  let out = text;
  for (let k = 0; k < -levels; k++) {
    if (out.startsWith("\t")) out = out.slice(1);
    else if (out.startsWith("  ")) out = out.slice(2);
    else if (out.startsWith(" ")) out = out.slice(1);
    else break;
  }
  return out;
}

/**
 * The depths a unit may take when set down just before `items[at]` (or
 * after the last item, for `at === items.length`), with the unit
 * `[s, e]` already lifted out.
 *
 * No deeper than one under the item it lands after — it can become that
 * item's child, not its grandchild — and no shallower than the item it
 * lands before, which would otherwise be adopted as the moved item's
 * child: a drag moves one subtree, it doesn't restructure the ones
 * around it.
 */
export function dropDepthRange(items, s, e, at) {
  let p = at - 1;
  while (p >= s && p <= e) p = s - 1; // the item before the lifted unit
  let n = at;
  while (n >= s && n <= e) n = e + 1;
  const prev = p >= 0 ? items[p] : null;
  const next = n < items.length ? items[n] : null;
  const base = items.reduce((m, it) => Math.min(m, it.depth), Infinity);
  const max = prev ? prev.depth + 1 : base;
  const min = next ? Math.min(next.depth, max) : base;
  return { min: Math.min(min, max), max };
}

/**
 * The changes that move the unit rooted at `items[src]` to just before
 * `items[at]` (or to the end of the block when `at === items.length`),
 * at nesting `depth`. `items` carry 1-based document line numbers, as
 * the outline field's `scanBlocks` produces them.
 *
 * Returns `{ changes, lineOffset }` or null for a move that changes
 * nothing. `lineOffset` is how far the unit's first line ends up from
 * where it began, in lines — the caller uses it to follow the unit with
 * the caret or with the focus.
 */
export function outlineMoveChanges(doc, items, src, at, depth) {
  const s = src;
  const e = unitEnd(items, src);
  if (at > s && at <= e) return null; // inside itself
  const delta = depth - items[s].depth;
  const samePlace = at === s || at === e + 1;
  if (samePlace && delta === 0) return null;

  const first = doc.line(items[s].line);
  const last = doc.line(items[e].line);
  const moved = [];
  for (let n = items[s].line; n <= items[e].line; n++) {
    moved.push(reindentLine(doc.line(n).text, delta));
  }
  const text = moved.join("\n");

  // Re-indent in place: one replacement over the unit's own lines.
  if (samePlace) {
    return { changes: [{ from: first.from, to: last.to, insert: text }], lineOffset: 0 };
  }

  // Lift the unit with the newline after it — or, when it ends the
  // document, the one before it — and set it down before `items[at]`,
  // or after the block's last line.
  const del = last.to < doc.length
    ? { from: first.from, to: last.to + 1 }
    : { from: first.from - 1, to: last.to };
  let ins;
  let landLine;
  if (at < items.length) {
    const target = doc.line(items[at].line);
    ins = { from: target.from, insert: text + "\n" };
    landLine = items[at].line;
  } else {
    const end = doc.line(items[items.length - 1].line);
    ins = { from: end.to, insert: "\n" + text };
    landLine = items[items.length - 1].line + 1;
  }
  const count = e - s + 1;
  // Lines before the unit move up by its length once it's lifted.
  const lineOffset = landLine > items[e].line
    ? landLine - count - items[s].line
    : landLine - items[s].line;
  return { changes: [del, ins], lineOffset };
}

/**
 * Keyboard move (Alt-Arrow): the unit under the selection swaps with the
 * sibling unit above or below it, and never leaves its parent — there is
 * no sibling above the first child or below the last, so the key does
 * nothing there rather than flattening the tree to make room.
 */
function selectedItems(edState, blocks) {
  const sel = edState.selection.main;
  const fromLine = edState.doc.lineAt(sel.from).number;
  const toLine = edState.doc.lineAt(sel.to).number;
  for (const block of blocks) {
    if (block.fromLine > fromLine || block.toLine < toLine) continue;
    const a = block.items.findIndex((it) => it.line === fromLine);
    const b = block.items.findIndex((it) => it.line === toLine);
    if (a < 0 || b < 0) return null;
    return { items: block.items, a, b };
  }
  return null;
}

export function moveOutlineUnit(view, blocks, dir) {
  if (!blocks || !blocks.length) return false;
  const found = selectedItems(view.state, blocks);
  if (!found) return false;
  const { items, a, b } = found;

  // Whole units only: a selection that stops halfway through a subtree
  // still moves the subtree.
  const start = a;
  const end = unitEnd(items, Math.max(unitEnd(items, a), b));
  const level = items[start].depth;

  let tStart;
  let tEnd;
  if (dir > 0) {
    const next = end + 1;
    // Past the last sibling, or past the end of the parent's children.
    if (next >= items.length || items[next].depth !== level) return true;
    tStart = next;
    tEnd = unitEnd(items, next);
  } else {
    let p = start - 1;
    while (p >= 0 && items[p].depth > level) p -= 1;
    if (p < 0 || items[p].depth !== level) return true;
    tStart = p;
    tEnd = start - 1;
  }

  const doc = view.state.doc;
  const movedFrom = doc.line(items[start].line).from;
  const movedTo = doc.line(items[end].line).to;
  const targetFrom = doc.line(items[tStart].line).from;
  const targetTo = doc.line(items[tEnd].line).to;
  const moved = doc.sliceString(movedFrom, movedTo);
  const target = doc.sliceString(targetFrom, targetTo);

  const sel = view.state.selection.main;
  const from = dir > 0 ? movedFrom : targetFrom;
  const to = dir > 0 ? targetTo : movedTo;
  const insert = dir > 0 ? `${target}\n${moved}` : `${moved}\n${target}`;
  const delta = dir > 0 ? target.length + 1 : -(target.length + 1);

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: sel.anchor + delta, head: sel.head + delta },
    scrollIntoView: true,
    userEvent: "move.outline",
  });
  return true;
}

/**
 * Apply a drag's move to the document. When the selection sat inside the
 * moved unit it travels with it — mapped through the lift it would land
 * at the hole the unit left behind.
 */
export function applyOutlineMove(view, items, src, at, depth) {
  const plan = outlineMoveChanges(view.state.doc, items, src, at, depth);
  if (!plan) return null;
  const doc = view.state.doc;
  const e = unitEnd(items, src);
  const unitFrom = doc.line(items[src].line).from;
  const unitTo = doc.line(items[e].line).to;
  const sel = view.state.selection.main;
  const spec = { changes: plan.changes, userEvent: "move.outline" };
  const tr = view.state.update(spec);
  if (sel.head >= unitFrom && sel.head <= unitTo) {
    const newDoc = tr.state.doc;
    const landing = items[src].line + plan.lineOffset;
    if (landing >= 1 && landing <= newDoc.lines) {
      const pos = newDoc.line(landing).to;
      view.dispatch(view.state.update({ ...spec, selection: { anchor: pos } }));
      return plan;
    }
  }
  view.dispatch(tr);
  return plan;
}

/** The six-dot grip the handles draw. */
export const GRIP_ICON =
  '<svg viewBox="0 0 8 12" aria-hidden="true">'
  + '<circle cx="2" cy="2" r="1.1" fill="currentColor"/><circle cx="6" cy="2" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="6" r="1.1" fill="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/>'
  + '<circle cx="2" cy="10" r="1.1" fill="currentColor"/><circle cx="6" cy="10" r="1.1" fill="currentColor"/>'
  + '</svg>';

/** Horizontal travel, in px, that changes the dragged item's depth by
 *  one level. Much wider than one level of indent actually is (two
 *  spaces of the UI face, under 10 px), which would make the depth
 *  flicker with every tremor of the hand. */
const DEPTH_STEP_PX = 24;

/** Travel before a press on a handle becomes a drag. */
const DRAG_SLOP = 3;

/**
 * Run one drag of an outline item.
 *
 * @param {PointerEvent} e              The handle's pointerdown.
 * @param {object} o
 * @param {Array<{depth:number}>} o.items   The block's items, in order.
 * @param {number} o.src                Index of the item being dragged.
 * @param {() => Array<{index:number, top:number, bottom:number, left:number}>} o.measure
 *   The items on screen that can be dropped beside (the dragged unit
 *   excluded), in client px: their row's top and bottom, and the left
 *   edge of their checkbox. Called once when the drag starts.
 * @param {number} o.indentPx           Width of one nesting level on screen.
 * @param {number} o.srcLeft            Left edge of the dragged item's checkbox.
 * @param {HTMLElement} o.markerHost    Positioned element the marker lives in.
 * @param {number} o.markerRight        Client x the marker runs to.
 * @param {(at:number, depth:number) => void} o.onDrop
 * @param {() => void} [o.onStart]
 * @param {() => void} [o.onEnd]
 */
export function startOutlineDrag(e, o) {
  const { items, src } = o;
  const s = src;
  const unitE = unitEnd(items, src);
  const startX = e.clientX;
  const startY = e.clientY;
  let started = false;
  let slots = null;
  let marker = null;
  let target = null;

  const begin = () => {
    started = true;
    document.body.classList.add("outline-drag-active");
    o.onStart?.();
    const rows = o.measure().filter((r) => r.index < s || r.index > unitE);
    // One slot per gap: above every visible row, and one under the last.
    slots = rows.map((r, k) => ({
      at: r.index,
      y: k === 0 ? r.top : (rows[k - 1].bottom + r.top) / 2,
    }));
    if (rows.length) {
      const lastRow = rows[rows.length - 1];
      slots.push({ at: unitEnd(items, lastRow.index) + 1, y: lastRow.bottom });
    }
    // Where the lifted unit sat, so dropping it back is a slot too (it
    // may still change depth there).
    const before = rows.filter((r) => r.index < s).pop();
    const after = rows.find((r) => r.index > unitE);
    if (before || after) {
      const y = before && after ? (before.bottom + after.top) / 2 : before ? before.bottom : after.top;
      slots.push({ at: s, y });
    }
    // Several visible rows can share one index gap (hidden items between
    // them); keep the first slot found for each.
    const seen = new Set();
    slots = slots.filter((sl) => (seen.has(sl.at) ? false : (seen.add(sl.at), true)))
      .sort((a, b) => a.y - b.y);

    marker = document.createElement("div");
    marker.className = "outline-drop-marker";
    o.markerHost.appendChild(marker);
  };

  const update = (x, y) => {
    if (!slots || !slots.length) return;
    let best = slots[0];
    for (const sl of slots) if (Math.abs(sl.y - y) < Math.abs(best.y - y)) best = sl;
    const range = dropDepthRange(items, s, unitE, best.at);
    const want = items[s].depth + Math.round((x - startX) / DEPTH_STEP_PX);
    const depth = Math.max(range.min, Math.min(range.max, want));
    target = { at: best.at, depth };

    const hostRect = o.markerHost.getBoundingClientRect();
    const left = o.srcLeft + (depth - items[s].depth) * o.indentPx;
    marker.style.top = `${best.y - hostRect.top + o.markerHost.scrollTop}px`;
    marker.style.left = `${left - hostRect.left + 6}px`;
    marker.style.width = `${Math.max(24, o.markerRight - left - 6)}px`;
  };

  const onMove = (me) => {
    if (!started) {
      if (Math.abs(me.clientX - startX) < DRAG_SLOP && Math.abs(me.clientY - startY) < DRAG_SLOP) return;
      begin();
    }
    me.preventDefault();
    update(me.clientX, me.clientY);
  };

  const finish = (commit) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    if (marker) marker.remove();
    document.body.classList.remove("outline-drag-active");
    if (started) o.onEnd?.();
    if (commit && started && target) o.onDrop(target.at, target.depth);
  };
  const onUp = (ue) => { ue.preventDefault(); finish(true); };
  const onCancel = () => finish(false);
  const onKey = (ke) => {
    if (ke.key !== "Escape") return;
    ke.preventDefault();
    ke.stopPropagation();
    finish(false);
  };

  // Listened for on the window rather than captured on the handle: the
  // in-flow handle is repositioned (and the pinned rows rebuilt) while
  // the gesture runs, which would drop a pointer capture mid-drag.
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
}
