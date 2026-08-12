// Canvas clipboard envelope shared with Steiner. Both apps detect the same
// `schema` string and shape, so copy/paste round-trips between them.
//
// Format (text/plain JSON):
//   {
//     "schema": "canvas-clipboard@1",
//     "shapes": [...],
//     "flowEdges": [...]
//   }
//
// Field naming mirrors the in-memory Shape / FlowEdge types (camelCase).
// Unknown fields are preserved on round-trip but not relied on.

import type { Shape, Point } from "./types";
import type { FlowEdge } from "./flowchart";
import { generateId, getShapeBounds } from "./utils";

export const CLIPBOARD_SCHEMA = "canvas-clipboard@1";

export interface ClipboardEnvelope {
  schema: typeof CLIPBOARD_SCHEMA;
  shapes: Shape[];
  flowEdges?: FlowEdge[];
  // Forward compatibility: ignore unknown extras.
  [k: string]: unknown;
}

export function encodeSelection(shapes: Shape[], edges: FlowEdge[]): string {
  const ids = new Set(shapes.map((s) => s.id));
  // Only carry edges whose endpoints are both in the copy set, so an orphan
  // edge never lands on the receiver.
  const carried = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const env: ClipboardEnvelope = {
    schema: CLIPBOARD_SCHEMA,
    shapes: shapes.map((s) => structuredClone(s)),
    flowEdges: carried.map((e) => ({ ...e })),
  };
  return JSON.stringify(env);
}

export function tryDecode(text: string): ClipboardEnvelope | null {
  if (!text) return null;
  // Cheap header check before parsing — clipboard text often isn't JSON at all.
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  if (!trimmed.includes(CLIPBOARD_SCHEMA)) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema !== CLIPBOARD_SCHEMA) return null;
    if (!Array.isArray(parsed.shapes)) return null;
    return parsed as ClipboardEnvelope;
  } catch {
    return null;
  }
}

export interface RemappedPaste {
  shapes: Shape[];
  edges: FlowEdge[];
  /** New IDs in the same order as the input shapes (handy for selecting after paste). */
  newIds: string[];
}

export interface RemapOptions {
  /** Layer to attach pasted shapes to. Source layerIds are dropped — they
   *  belong to the source notebook and won't exist on the receiver. */
  activeLayerId?: string;
  /** Font family for text-shape bounds calculation (affects centering). */
  fontFamily?: string;
}

/**
 * Remap shape IDs and edge endpoints so a paste never collides with existing
 * canvas IDs. Edges referring to shapes outside the paste set are dropped.
 * parentId / groupId references are remapped when both sides are in the set
 * and cleared otherwise. Pasted shapes are attached to the receiver's active
 * layer; `pocketed` is cleared so a pasted shape never lands in the shelf.
 * Translates positions (or points, for stroke shapes) so the paste's
 * bounding-box center lands at `targetCenter` (canvas coordinates).
 */
export function remapForPaste(
  env: ClipboardEnvelope,
  targetCenter: Point,
  opts: RemapOptions = {},
): RemappedPaste {
  const idMap = new Map<string, string>();
  const newIds: string[] = [];
  for (const s of env.shapes) {
    const nid = generateId();
    idMap.set(s.id, nid);
    newIds.push(nid);
  }

  // Compute current bounds-center to translate the paste as a unit. Use
  // getShapeBounds so stroke shapes (no position, points-only) participate.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of env.shapes) {
    const b = getShapeBounds(s, opts.fontFamily);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  const haveBounds = isFinite(minX);
  const cx = haveBounds ? (minX + maxX) / 2 : 0;
  const cy = haveBounds ? (minY + maxY) / 2 : 0;
  const dx = haveBounds ? targetCenter.x - cx : 0;
  const dy = haveBounds ? targetCenter.y - cy : 0;

  const shapes: Shape[] = env.shapes.map((s) => {
    const clone = structuredClone(s);
    const cAny = clone as {
      id: string;
      parentId?: string;
      groupId?: string;
      pocketed?: boolean;
      layerId?: string;
      position?: Point;
      points?: Point[];
    };
    cAny.id = idMap.get(s.id)!;
    // A paste is new material on this canvas whatever the source's age,
    // so it gets a fresh creation stamp — otherwise pasting into a split
    // would produce content "Clear split content" refuses to remove.
    (cAny as { createdAt?: number }).createdAt = Date.now();
    if (cAny.parentId) {
      const mapped = idMap.get(cAny.parentId);
      if (mapped) cAny.parentId = mapped;
      else delete cAny.parentId;
    }
    if (cAny.groupId) {
      const mapped = idMap.get(cAny.groupId);
      if (mapped) cAny.groupId = mapped;
      else delete cAny.groupId;
    }
    // Source layer doesn't exist on the receiver — pin to the active layer
    // (or drop the field entirely if the receiver doesn't track layers).
    if (opts.activeLayerId) cAny.layerId = opts.activeLayerId;
    else delete cAny.layerId;
    // Don't auto-pocket pasted shapes — the source's pocketed state is
    // notebook-local.
    if (cAny.pocketed) delete cAny.pocketed;
    if (cAny.position) {
      cAny.position = { x: cAny.position.x + dx, y: cAny.position.y + dy };
    } else if (cAny.points) {
      cAny.points = cAny.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }
    return clone;
  });

  const edges: FlowEdge[] = (env.flowEdges || [])
    .map((e) => {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      if (!from || !to) return null;
      return { id: generateId(), from, to };
    })
    .filter((e): e is FlowEdge => !!e);

  return { shapes, edges, newIds };
}
