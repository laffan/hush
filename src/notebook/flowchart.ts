// Flowchart layer — a portable add-on for canvas apps with a "text object"
// architecture. Knows nothing about the host app's specific shape types
// beyond what it's told via the config callbacks (getBounds, isFlowable).
//
// Usage:
//
//   const flow = new FlowchartLayer<Shape>({
//     getBounds: (s) => getShapeBounds(s),
//     isFlowable: (s) => s.type === "text",
//   });
//
//   // On drop:
//   const target = flow.findDropTarget(droppedCenter, shapes, droppedId);
//   if (target) {
//     const newTL = flow.tryConnect(droppedId, target.id, shapes);
//     if (newTL) {
//       // Translate from "new bounds top-left" to "new shape position".
//       const old = getShapeBounds(droppedShape);
//       applyPositionDelta(droppedId, newTL.minX - old.minX, newTL.minY - old.minY);
//     }
//   }
//
//   // On render (after camera transform is applied):
//   flow.draw(ctx, shapes);
//
//   // On node deletion:
//   flow.removeNode(deletedId);
//
//   // Tidy a subtree (anchors root, repositions descendants):
//   const layout = flow.tidy(rootId, shapes);
//   for (const [id, tl] of layout) {
//     const old = getShapeBounds(shapes.find((s) => s.id === id)!);
//     applyPositionDelta(id, tl.minX - old.minX, tl.minY - old.minY);
//   }
//
//   // Persistence:
//   const data = flow.serialize();
//   flow.deserialize(loadedData);

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

export interface FlowNode {
  id: string;
}

export interface FlowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * "horizontal" — always exit the parent's right (or left) edge and enter the
 *   child's opposite horizontal edge. This is the legacy behaviour: an arrow
 *   connecting two vertically-stacked boxes still snakes out of the right
 *   side, around, and back to the left.
 * "closest" — pick whichever pair of opposing cardinal edges (top/bottom or
 *   left/right) is closest. Boxes stacked vertically connect bottom→top with
 *   a straight-down line; horizontally-adjacent boxes still connect
 *   right→left like before.
 */
export type FlowConnectMode = "horizontal" | "closest";

export interface FlowchartConfig<S extends FlowNode> {
  /** Returns the canvas-space bounds of the node. */
  getBounds: (node: S) => FlowBounds;
  /** Footprint reserved for this node by `tidy`. Defaults to `getBounds`.
   * Hosts can return a wider box (e.g. node + grouped items) so siblings
   * don't overlap the attached items. The node still anchors via `getBounds`. */
  getLayoutBounds?: (node: S) => FlowBounds;
  /** Predicate for which nodes can be flowable flowchart vertices. Defaults to all. */
  isFlowable?: (node: S) => boolean;
  /** Horizontal gap between parent's right edge and child's left edge. */
  gapX?: number;
  /** Vertical gap between siblings stacked under the parent. */
  gapY?: number;
  /** Horizontal parent→child gap used by `tidy`. */
  tidyGapX?: number;
  /** Vertical sibling gap used by `tidy`. */
  tidyGapY?: number;
  /** Stroke color for the arrows. */
  arrowColor?: string;
  /** Arrow line width (canvas units). */
  arrowWidth?: number;
  /** Arrowhead size (canvas units). */
  arrowHeadSize?: number;
  /** How to choose which edges of the parent + child the arrow connects.
   *  Defaults to "closest". */
  connectMode?: FlowConnectMode;
}

interface ResolvedConfig<S extends FlowNode> {
  getBounds: (node: S) => FlowBounds;
  getLayoutBounds: (node: S) => FlowBounds;
  isFlowable: (node: S) => boolean;
  gapX: number;
  gapY: number;
  tidyGapX: number;
  tidyGapY: number;
  arrowColor: string;
  arrowWidth: number;
  arrowHeadSize: number;
  connectMode: FlowConnectMode;
}

export class FlowchartLayer<S extends FlowNode> {
  edges: FlowEdge[] = [];
  private cfg: ResolvedConfig<S>;

  constructor(config: FlowchartConfig<S>) {
    this.cfg = {
      getBounds: config.getBounds,
      getLayoutBounds: config.getLayoutBounds ?? config.getBounds,
      isFlowable: config.isFlowable ?? (() => true),
      gapX: config.gapX ?? 60,
      gapY: config.gapY ?? 16,
      tidyGapX: config.tidyGapX ?? 90,
      tidyGapY: config.tidyGapY ?? 25,
      arrowColor: config.arrowColor ?? "#666",
      arrowWidth: config.arrowWidth ?? 1.5,
      arrowHeadSize: config.arrowHeadSize ?? 11,
      connectMode: config.connectMode ?? "closest",
    };
  }

  /** Switch between horizontal-only and closest-edge arrow routing. */
  setConnectMode(mode: FlowConnectMode): void {
    this.cfg.connectMode = mode;
  }

  /** Re-export the host's isFlowable predicate so callers iterating
   *  shapes (drop-target search, hover detection) can mirror the same
   *  filter without duplicating it. */
  isFlowable(node: S): boolean {
    return this.cfg.isFlowable(node);
  }

  // --- State ---

  serialize(): FlowEdge[] {
    return this.edges.map((e) => ({ ...e }));
  }

  deserialize(edges: FlowEdge[] | undefined | null): void {
    this.edges = Array.isArray(edges) ? edges.map((e) => ({ ...e })) : [];
  }

  hasEdge(from: string, to: string): boolean {
    return this.edges.some((e) => e.from === from && e.to === to);
  }

  parentOf(childId: string): string | null {
    const e = this.edges.find((e) => e.to === childId);
    return e ? e.from : null;
  }

  childrenOf(parentId: string): string[] {
    return this.edges.filter((e) => e.from === parentId).map((e) => e.to);
  }

  /** All descendants of `id` (transitive). Used for cycle prevention. */
  descendantsOf(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const c of this.childrenOf(cur)) {
        if (!out.has(c)) {
          out.add(c);
          stack.push(c);
        }
      }
    }
    return out;
  }

  /** Remove every edge that references this node. */
  removeNode(id: string): void {
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  /** Add an edge from `from` to `to`. Replaces any existing parent for `to`.
   * Caller is responsible for cycle prevention if needed. */
  addEdge(from: string, to: string): FlowEdge {
    this.edges = this.edges.filter((e) => e.to !== to);
    const edge: FlowEdge = { id: genId(), from, to };
    this.edges.push(edge);
    return edge;
  }

  /** Remove a single edge by id. No-op if not found. */
  removeEdge(edgeId: string): void {
    this.edges = this.edges.filter((e) => e.id !== edgeId);
  }

  /**
   * Find the edge whose curve passes within `threshold` units of `point`.
   * Returns null if none. Threshold is in canvas units — callers should
   * scale by 1/zoom for a screen-space threshold.
   */
  findEdgeNear(
    point: { x: number; y: number },
    shapes: S[],
    threshold: number,
  ): FlowEdge | null {
    let best: FlowEdge | null = null;
    let bestDist = threshold;
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);
    for (const e of this.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const geom = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));
      // Sample 16 points along the bezier and check each segment.
      let prev = bezier(geom, 0);
      for (let i = 1; i <= 16; i++) {
        const cur = bezier(geom, i / 16);
        const d = pointToSegment(point, prev, cur);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
        prev = cur;
      }
    }
    return best;
  }

  /** Midpoint of the edge's curve (t = 0.5), in canvas coordinates. */
  getEdgeMidpoint(
    edgeId: string,
    shapes: S[],
  ): { x: number; y: number } | null {
    const e = this.edges.find((e) => e.id === edgeId);
    if (!e) return null;
    const a = shapes.find((s) => s.id === e.from);
    const b = shapes.find((s) => s.id === e.to);
    if (!a || !b) return null;
    const geom = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));
    return bezier(geom, 0.5);
  }

  // --- Drop logic ---

  /**
   * Find the topmost flowable node whose bounds contain `point`, ignoring
   * `excludeId`. Iterates in reverse — assumes later items in `shapes` are
   * drawn on top.
   */
  findDropTarget(
    point: { x: number; y: number },
    shapes: S[],
    excludeId: string,
  ): S | null {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.id === excludeId) continue;
      if (!this.cfg.isFlowable(s)) continue;
      const b = this.cfg.getBounds(s);
      if (
        point.x >= b.minX &&
        point.x <= b.maxX &&
        point.y >= b.minY &&
        point.y <= b.maxY
      ) {
        return s;
      }
    }
    return null;
  }

  /**
   * Wire `droppedId` as a child of `targetId`, replacing any existing parent.
   * Returns the new top-left of the dropped node's bounding box (in canvas
   * coordinates), or null if the connection is rejected (cycle, missing
   * shapes, non-flowable, self-drop).
   *
   * The caller translates this to a shape-specific position update — e.g.
   *   delta = newTL - oldBounds.{minX,minY}; shape.position += delta
   */
  tryConnect(
    droppedId: string,
    targetId: string,
    shapes: S[],
  ): { minX: number; minY: number } | null {
    if (droppedId === targetId) return null;
    if (this.descendantsOf(droppedId).has(targetId)) return null;
    const target = shapes.find((s) => s.id === targetId);
    const dropped = shapes.find((s) => s.id === droppedId);
    if (!target || !dropped) return null;
    if (!this.cfg.isFlowable(target) || !this.cfg.isFlowable(dropped)) return null;

    // Detach from prior parent (if any), then attach to new.
    this.edges = this.edges.filter((e) => e.to !== droppedId);
    this.edges.push({ id: genId(), from: targetId, to: droppedId });

    return this.computeTopLeftUnder(target, dropped, shapes);
  }

  private computeTopLeftUnder(
    target: S,
    dropped: S,
    shapes: S[],
  ): { minX: number; minY: number } {
    const tb = this.cfg.getBounds(target);
    const db = this.cfg.getBounds(dropped);
    const dw = db.maxX - db.minX, dh = db.maxY - db.minY;

    // Default to the side the target itself is attached to from its
    // parent — "any new parent/child connection inherits the parent's
    // attachment side". Roots (no parent) fall back to right.
    let side: "right" | "left" | "up" | "down" = "right";
    const pid = this.parentOf(target.id);
    if (pid) {
      const parent = shapes.find((s) => s.id === pid);
      if (parent) side = this._sideOfChild(parent, target);
    }
    // Stack behind existing same-side children so siblings don't pile up.
    const sameSide: FlowBounds[] = [];
    for (const cid of this.childrenOf(target.id)) {
      if (cid === dropped.id) continue;
      const c = shapes.find((s) => s.id === cid);
      if (!c) continue;
      if (this._sideOfChild(target, c) === side) sameSide.push(this.cfg.getBounds(c));
    }
    if (side === "right" || side === "left") {
      let baseY = tb.minY;
      for (const cb of sameSide) if (cb.maxY + this.cfg.gapY > baseY) baseY = cb.maxY + this.cfg.gapY;
      const x = side === "right" ? tb.maxX + this.cfg.gapX : tb.minX - this.cfg.gapX - dw;
      return { minX: x, minY: baseY };
    }
    let baseX = tb.minX;
    for (const cb of sameSide) if (cb.maxX + this.cfg.gapY > baseX) baseX = cb.maxX + this.cfg.gapY;
    const y = side === "down" ? tb.maxY + this.cfg.gapX : tb.minY - this.cfg.gapX - dh;
    return { minX: baseX, minY: y };
  }

  /** Closest cardinal side of `parent` that `child` currently sits on.
   *  Mirrors geometryClosest's axis pick. Shared between tidy + tryConnect. */
  private _sideOfChild(parent: S, child: S): "right" | "left" | "up" | "down" {
    const pb = this.cfg.getBounds(parent), cb = this.cfg.getBounds(child);
    const dx = (cb.minX + cb.maxX) / 2 - (pb.minX + pb.maxX) / 2;
    const dy = (cb.minY + cb.maxY) / 2 - (pb.minY + pb.maxY) / 2;
    if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? "down" : "up";
    return dx >= 0 ? "right" : "left";
  }

  // --- Tidy ---

  /**
   * Re-layout the subtree rooted at `rootId`, anchoring the root at its
   * current top-left. Each child is placed on whichever side it currently
   * occupies (right / left / down / up) — preserving the user's wiring —
   * with reading order kept (top-to-bottom for L/R, left-to-right for
   * U/D). Node centers are aligned with the parent's mid-line so single
   * chains stay straight; sibling stacks distribute around that mid-line.
   * Per-call gap overrides accepted via `opts`. Returns the new top-left
   * for every shape in the subtree; the caller applies the delta the
   * same way as `tryConnect`.
   */
  tidy(
    rootId: string,
    shapes: S[],
    opts?: { tidyGapX?: number; tidyGapY?: number },
  ): Map<string, { minX: number; minY: number }> {
    const out = new Map<string, { minX: number; minY: number }>();
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);
    const root = byId.get(rootId);
    if (!root) return out;

    const gapX = opts?.tidyGapX ?? this.cfg.tidyGapX;
    const gapY = opts?.tidyGapY ?? this.cfg.tidyGapY;

    // Defensive cycle guard: even though tryConnect/addEdge enforce a tree,
    // bad data could yield cycles and this recursion has no other backstop.
    const visited = new Set<string>();

    type Side = "right" | "left" | "up" | "down";
    interface CB { id: string; w: number; h: number; nodeLeft: number; nodeTop: number; nodeW: number; nodeH: number; }
    const cx = (s: S) => { const b = this.cfg.getBounds(s); return (b.minX + b.maxX) / 2; };
    const cy = (s: S) => { const b = this.cfg.getBounds(s); return (b.minY + b.maxY) / 2; };

    // Place node at (0, 0); position children around it so node centers
    // align with parent's mid-line (single child → straight line; multi
    // children → averaged so the spread is centered). Track the
    // resulting bbox dynamically and normalize at the end.
    const layout = (id: string, _parentSide: Side): { width: number; height: number; nodeLeft: number; nodeTop: number; nodeW: number; nodeH: number } => {
      if (visited.has(id)) return { width: 0, height: 0, nodeLeft: 0, nodeTop: 0, nodeW: 0, nodeH: 0 };
      visited.add(id);
      const node = byId.get(id);
      if (!node) return { width: 0, height: 0, nodeLeft: 0, nodeTop: 0, nodeW: 0, nodeH: 0 };
      const nb = this.cfg.getBounds(node), lb = this.cfg.getLayoutBounds(node);
      const lw = lb.maxX - lb.minX, lh = lb.maxY - lb.minY;
      const offX = nb.minX - lb.minX, offY = nb.minY - lb.minY;
      out.set(id, { minX: offX, minY: offY });

      const childIds = this.childrenOf(id).filter((c) => byId.has(c) && !visited.has(c));
      if (childIds.length === 0) return { width: lw, height: lh, nodeLeft: 0, nodeTop: 0, nodeW: lw, nodeH: lh };

      const buckets: Record<Side, CB[]> = { right: [], left: [], up: [], down: [] };
      for (const cid of childIds) {
        const side = this._sideOfChild(node, byId.get(cid)!);
        const sz = layout(cid, side);
        buckets[side].push({ id: cid, w: sz.width, h: sz.height, nodeLeft: sz.nodeLeft, nodeTop: sz.nodeTop, nodeW: sz.nodeW, nodeH: sz.nodeH });
      }
      buckets.right.sort((a, b) => cy(byId.get(a.id)!) - cy(byId.get(b.id)!));
      buckets.left.sort((a, b) => cy(byId.get(a.id)!) - cy(byId.get(b.id)!));
      buckets.down.sort((a, b) => cx(byId.get(a.id)!) - cx(byId.get(b.id)!));
      buckets.up.sort((a, b) => cx(byId.get(a.id)!) - cx(byId.get(b.id)!));

      let bx0 = 0, by0 = 0, bx1 = lw, by1 = lh;
      // Stack along the perpendicular axis (vertical for R/L, horizontal
      // for U/D). The stack origin is picked so the AVERAGE of child
      // node-centers equals the parent's mid-line — for a single child
      // this collapses to "align child node center with parent" (straight
      // line); for multiple it spreads them around the parent.
      const placeStack = (arr: CB[], horiz: boolean, primary: (c: CB) => number) => {
        if (arr.length === 0) return;
        const sizes = arr.map((c) => horiz ? c.w : c.h);
        const offs: number[] = []; let acc = 0;
        for (let i = 0; i < arr.length; i++) { offs.push(acc); acc += sizes[i] + gapY; }
        let sumCenters = 0;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          sumCenters += offs[i] + (horiz ? c.nodeLeft + c.nodeW / 2 : c.nodeTop + c.nodeH / 2);
        }
        const start = (horiz ? lw : lh) / 2 - sumCenters / arr.length;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          const dx = horiz ? start + offs[i] : primary(c) - c.nodeLeft;
          const dy = horiz ? primary(c) - c.nodeTop : start + offs[i];
          shiftSubtree(c.id, dx, dy);
          bx0 = Math.min(bx0, dx); bx1 = Math.max(bx1, dx + c.w);
          by0 = Math.min(by0, dy); by1 = Math.max(by1, dy + c.h);
        }
      };
      placeStack(buckets.right, false, () => lw + gapX);
      placeStack(buckets.left,  false, (c) => -gapX - c.nodeW);
      placeStack(buckets.down,  true,  () => lh + gapX);
      placeStack(buckets.up,    true,  (c) => -gapX - c.nodeH);

      if (bx0 !== 0 || by0 !== 0) shiftSubtree(id, -bx0, -by0);
      return { width: bx1 - bx0, height: by1 - by0, nodeLeft: -bx0, nodeTop: -by0, nodeW: lw, nodeH: lh };
    };

    // Translate every position already assigned within the subtree of `id`.
    const shiftSubtree = (id: string, dx: number, dy: number): void => {
      const seen = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const p = out.get(cur);
        if (p) {
          p.minX += dx;
          p.minY += dy;
        }
        for (const c of this.childrenOf(cur)) {
          if (byId.has(c)) stack.push(c);
        }
      }
    };

    // Root has no parent side to inherit; sideOf bucketing takes over per-child.
    layout(rootId, "right");

    // Anchor: shift the whole layout so the root keeps its current top-left.
    const rootBounds = this.cfg.getBounds(root);
    const rootRel = out.get(rootId);
    if (!rootRel) return out;
    const ox = rootBounds.minX - rootRel.minX;
    const oy = rootBounds.minY - rootRel.minY;
    for (const p of out.values()) {
      p.minX += ox;
      p.minY += oy;
    }
    return out;
  }

  // --- Rendering ---

  private geometry(ab: FlowBounds, bb: FlowBounds): EdgeGeometry {
    return this.cfg.connectMode === "closest"
      ? this.geometryClosest(ab, bb)
      : this.geometryHorizontal(ab, bb);
  }

  private geometryHorizontal(ab: FlowBounds, bb: FlowBounds): EdgeGeometry {
    // Pick the side of each box closer to the other so the arrow looks sane
    // even if the user drags the child to the parent's left/below.
    const childOnRight = (bb.minX + bb.maxX) / 2 >= (ab.minX + ab.maxX) / 2;
    const sx = childOnRight ? ab.maxX : ab.minX;
    const sy = (ab.minY + ab.maxY) / 2;
    const sign = childOnRight ? 1 : -1;
    // Visual breathing room: tip stops 10px shy of the child's edge.
    const TIP_GAP = 10;
    const tipX = childOnRight ? bb.minX - TIP_GAP : bb.maxX + TIP_GAP;
    const tipY = (bb.minY + bb.maxY) / 2;
    // Back the line off by `ah` more so it terminates at the BASE of the
    // arrowhead (rather than the tip). Tangent at t=1 is horizontal by
    // construction.
    const ah = this.cfg.arrowHeadSize;
    const ex = tipX - sign * ah;
    const ey = tipY;
    const dx = Math.max(40, Math.abs(ex - sx) * 0.5);
    const cp1x = sx + sign * dx;
    const cp2x = ex - sign * dx;
    return {
      p0: { x: sx, y: sy },
      cp1: { x: cp1x, y: sy },
      cp2: { x: cp2x, y: ey },
      p3: { x: ex, y: ey },
      tip: { x: tipX, y: tipY },
      sign,
      perpX: 0,
      perpY: sign,
    };
  }

  private geometryClosest(ab: FlowBounds, bb: FlowBounds): EdgeGeometry {
    const acx = (ab.minX + ab.maxX) / 2;
    const acy = (ab.minY + ab.maxY) / 2;
    const bcx = (bb.minX + bb.maxX) / 2;
    const bcy = (bb.minY + bb.maxY) / 2;

    // Signed gap between facing edges along each axis. Positive = clear
    // separation, negative = overlap on that axis. The axis with the larger
    // gap is the one with clearer separation, so route the arrow that way.
    const horizGap = bcx >= acx ? bb.minX - ab.maxX : ab.minX - bb.maxX;
    const vertGap = bcy >= acy ? bb.minY - ab.maxY : ab.minY - bb.maxY;

    let dirX = 0, dirY = 0;
    let sx: number, sy: number, cx: number, cy: number;
    if (horizGap >= vertGap) {
      // Connect right↔left (or left↔right) — anchor at the vertical midpoint
      // of each edge so the line is fixed to the centre of the side rather
      // than sliding along it as the other box moves.
      if (bcx >= acx) {
        sx = ab.maxX; cx = bb.minX; dirX = 1;
      } else {
        sx = ab.minX; cx = bb.maxX; dirX = -1;
      }
      sy = acy;
      cy = bcy;
    } else {
      // Connect bottom↔top (or top↔bottom) — anchor at the horizontal
      // midpoint of each edge.
      if (bcy >= acy) {
        sy = ab.maxY; cy = bb.minY; dirY = 1;
      } else {
        sy = ab.minY; cy = bb.maxY; dirY = -1;
      }
      sx = acx;
      cx = bcx;
    }

    const TIP_GAP = 10;
    const tipX = cx - dirX * TIP_GAP;
    const tipY = cy - dirY * TIP_GAP;

    const ah = this.cfg.arrowHeadSize;
    const ex = tipX - dirX * ah;
    const ey = tipY - dirY * ah;

    // Pull bezier control points along the arrow direction from each end so
    // the curve leaves and arrives perpendicular to the edges it touches.
    const span = Math.max(40, (Math.abs(ex - sx) + Math.abs(ey - sy)) * 0.5);
    const cp1x = sx + dirX * span;
    const cp1y = sy + dirY * span;
    const cp2x = ex - dirX * span;
    const cp2y = ey - dirY * span;

    // Perpendicular unit vector — used to splay the arrowhead base.
    const perpX = -dirY;
    const perpY = dirX;
    // `sign` is retained for legacy renderers that assume horizontal arrows.
    // Picks something sensible for vertical arrows but new code should use
    // perpX/perpY directly.
    const sign = dirX !== 0 ? dirX : dirY;

    return {
      p0: { x: sx, y: sy },
      cp1: { x: cp1x, y: cp1y },
      cp2: { x: cp2x, y: cp2y },
      p3: { x: ex, y: ey },
      tip: { x: tipX, y: tipY },
      sign,
      perpX,
      perpY,
    };
  }

  /**
   * Draw all edges as cubic-bezier arrows from the right edge of the parent
   * to the left edge of the child. Call after the camera transform is
   * applied (canvas space).
   */
  draw(ctx: CanvasRenderingContext2D, shapes: S[]): void {
    if (this.edges.length === 0) return;
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);

    ctx.save();
    ctx.strokeStyle = this.cfg.arrowColor;
    ctx.fillStyle = this.cfg.arrowColor;
    ctx.lineWidth = this.cfg.arrowWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const ah = this.cfg.arrowHeadSize;
    for (const e of this.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const g = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));

      // Bezier from parent edge to base of arrowhead.
      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.bezierCurveTo(g.cp1.x, g.cp1.y, g.cp2.x, g.cp2.y, g.p3.x, g.p3.y);
      ctx.stroke();

      // Arrowhead — base at p3, tip at .tip. perpX/perpY is the unit vector
      // perpendicular to the arrow direction so the base splays both ways.
      ctx.beginPath();
      ctx.moveTo(g.tip.x, g.tip.y);
      ctx.lineTo(g.p3.x + ah * 0.55 * g.perpX, g.p3.y + ah * 0.55 * g.perpY);
      ctx.lineTo(g.p3.x - ah * 0.55 * g.perpX, g.p3.y - ah * 0.55 * g.perpY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Override the arrow color at runtime (e.g. for a theme change). */
  setArrowColor(color: string): void {
    this.cfg.arrowColor = color;
  }
}

function genId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

interface Pt {
  x: number;
  y: number;
}

interface EdgeGeometry {
  p0: Pt;
  cp1: Pt;
  cp2: Pt;
  /** End of the line — base of the arrowhead. */
  p3: Pt;
  /** Tip of the arrowhead — touches the child shape's edge. */
  tip: Pt;
  /** Legacy hint kept for renderers that assume horizontal arrows.
   *  +1 if child is to the right/below parent, -1 if to the left/above. */
  sign: number;
  /** Unit vector perpendicular to the arrow direction at the tip — used to
   *  splay the arrowhead base. For a horizontal arrow this is (0, ±1); for
   *  a vertical arrow (±1, 0). */
  perpX: number;
  perpY: number;
}


function bezier(g: EdgeGeometry, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * g.p0.x + b * g.cp1.x + c * g.cp2.x + d * g.p3.x,
    y: a * g.p0.y + b * g.cp1.y + c * g.cp2.y + d * g.p3.y,
  };
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
