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
//   flow.draw(ctx, shapes);      // on render, after the camera transform
//   flow.removeNode(deletedId);  // on node deletion
//   const data = flow.serialize(); flow.deserialize(data);  // persistence
//
// `tryConnect` (on drop) and `tidy` (re-layout a subtree) return new
// *bounding-box top-lefts*, not shape positions — the host translates:
//
//   const newTL = flow.tryConnect(droppedId, target.id, shapes);
//   if (newTL) {
//     const old = getShapeBounds(droppedShape);
//     applyPositionDelta(droppedId, newTL.minX - old.minX, newTL.minY - old.minY);
//   }

import {
  edgeGeometry, offsetGeometry, exitSide, oppositeSide, sideAxis,
  bezier, pointToSegment,
} from "./flowchart-geometry";
import type { Pt, EdgeGeometry } from "./flowchart-geometry";

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
  arrowLineCap: CanvasLineCap;
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
      arrowLineCap: "round",
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
    const offsets = this.edgeOffsets(byId);
    for (const e of this.edges) {
      const geom = this.placedGeometry(e, byId, offsets);
      if (!geom) continue;
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
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);
    const geom = this.placedGeometry(e, byId, this.edgeOffsets(byId));
    return geom ? bezier(geom, 0.5) : null;
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

  /** Side of `parent` that `child` sits on — same gap-based axis pick
   *  `geometryClosest` uses to route arrows, so Tidy can't flip a
   *  child off the side its arrow already points to. */
  private _sideOfChild(parent: S, child: S): "right" | "left" | "up" | "down" {
    const pb = this.cfg.getBounds(parent), cb = this.cfg.getBounds(child);
    const ccx = (cb.minX + cb.maxX) / 2, ccy = (cb.minY + cb.maxY) / 2;
    const pcx = (pb.minX + pb.maxX) / 2, pcy = (pb.minY + pb.maxY) / 2;
    const horizGap = ccx >= pcx ? cb.minX - pb.maxX : pb.minX - cb.maxX;
    const vertGap  = ccy >= pcy ? cb.minY - pb.maxY : pb.minY - cb.maxY;
    if (horizGap >= vertGap) return ccx >= pcx ? "right" : "left";
    return ccy >= pcy ? "down" : "up";
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

  /** Anchor pair for one edge, before any stacking offset. */
  private geometry(ab: FlowBounds, bb: FlowBounds): EdgeGeometry {
    return edgeGeometry(ab, bb, this.cfg.connectMode, this.cfg.arrowHeadSize);
  }

  /**
   * Per-edge endpoint offsets that keep arrows sharing a box side from
   * landing on top of each other. Both ends of an edge anchor at the
   * *midpoint* of the side they touch, so a node with an arrow coming in
   * and another going out on the same side draws them straight through
   * one another. Group every endpoint by (node, side), then fan each
   * group out along that side — incoming first, so it sits above (or
   * left of) the outgoing one.
   */
  private edgeOffsets(byId: Map<string, S>): Map<string, { s: Pt; e: Pt }> {
    const out = new Map<string, { s: Pt; e: Pt }>();
    if (this.edges.length < 2) return out;
    // key = `${nodeId}\u0000${side}` → endpoints landing there.
    const groups = new Map<string, { id: string; incoming: boolean; side: string }[]>();
    const add = (key: string, v: { id: string; incoming: boolean; side: string }) => {
      const list = groups.get(key);
      if (list) list.push(v); else groups.set(key, [v]);
    };
    for (const e of this.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const side = exitSide(this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b)));
      const inSide = oppositeSide(side);
      add(`${e.from}\u0000${side}`, { id: e.id, incoming: false, side });
      add(`${e.to}\u0000${inSide}`, { id: e.id, incoming: true, side: inSide });
    }
    const step = this.cfg.arrowWidth * 1.6 + 4;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((x, y) => Number(y.incoming) - Number(x.incoming));
      const axis = sideAxis(list[0].side);
      list.forEach((m, i) => {
        const d = (i - (list.length - 1) / 2) * step;
        const cur = out.get(m.id) || { s: { x: 0, y: 0 }, e: { x: 0, y: 0 } };
        const end = m.incoming ? cur.e : cur.s;
        end.x += axis.x * d;
        end.y += axis.y * d;
        out.set(m.id, cur);
      });
    }
    return out;
  }

  /** Geometry for one edge with its stacking offset applied. */
  private placedGeometry(
    e: FlowEdge, byId: Map<string, S>, offsets: Map<string, { s: Pt; e: Pt }>,
  ): EdgeGeometry | null {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return null;
    const g = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));
    const off = offsets.get(e.id);
    return off ? offsetGeometry(g, off.s, off.e) : g;
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
    ctx.lineCap = this.cfg.arrowLineCap;
    ctx.lineJoin = "round";

    const ah = this.cfg.arrowHeadSize;
    const offsets = this.edgeOffsets(byId);
    for (const e of this.edges) {
      const g = this.placedGeometry(e, byId, offsets);
      if (!g) continue;

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

  /** Override the arrow metrics at runtime — stroke width, arrowhead
   *  size (both canvas units) and line cap. Hosts that render at a
   *  different visual weight than the default (Hush's Desktop
   *  document-order chain) set these per frame alongside the colour.
   *  A butt cap matters once the stroke is thick and translucent: a
   *  round cap laps over the arrowhead it terminates against, and the
   *  double-painted sliver reads as a dark notch. */
  setArrowMetrics(width: number, headSize: number, lineCap: CanvasLineCap = "round"): void {
    this.cfg.arrowWidth = width;
    this.cfg.arrowHeadSize = headSize;
    this.cfg.arrowLineCap = lineCap;
  }
}

function genId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

