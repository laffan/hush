/**
 * Notebook persistence format. Used by every save/load path (autosave
 * to disk, .hushnote export, sync push/pull, pane content load) so the
 * envelope shape stays consistent.
 *
 * On disk the file is now a wrapped JSON object so we can carry layers
 * and flowchart edges alongside shapes:
 *
 *   {
 *     "format": "hushnote",
 *     "version": 1,
 *     "shapes":   [...],
 *     "layers":   [...] | undefined,
 *     "flowEdges":[...] | undefined,
 *   }
 *
 * Legacy notebooks were saved as a bare `Shape[]` JSON array — `decode`
 * accepts that shape and returns equivalent envelope fields so callers
 * don't branch on format. Encoding always emits the new envelope.
 */

import type { Shape, Layer, CameraBookmark, Camera, BackgroundPattern } from "./types";
import type { FlowEdge } from "./flowchart";

/** Per-notebook background overrides. Saved alongside shapes so each
 *  notebook remembers its own pattern / spacing / opacity instead of
 *  inheriting whatever the global Hush settings happened to be at open
 *  time. All fields optional; omitted fields fall back to global. */
export interface NotebookBackground {
  pattern?: BackgroundPattern;
  spacing?: number;
  opacity?: number;
}

export interface NotebookContent {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
  bookmarks?: CameraBookmark[];
  camera?: Camera;
  background?: NotebookBackground;
}

export interface NotebookSnapshotInput {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
  bookmarks?: CameraBookmark[];
  camera?: Camera;
  background?: NotebookBackground;
}

/** JSON-encode a notebook snapshot in the envelope format.
 *  DrawShape points are quantized at this boundary: x/y rounded to integer
 *  pixels and pressure rounded to 0.05 buckets (2 decimal places). The
 *  visible difference is sub-pixel — `stroke-render.js`'s stamp radius is
 *  `halfSize * (0.6 + 0.4 * pressure)`, so 0.05 of pressure is 2% of
 *  halfSize, well below brush noise — and the byte savings on dense
 *  Pencil strokes are large (~50%). Serializing the quantized shape is
 *  the only place this lossy rounding happens; in-memory points keep
 *  their original precision while drawing. */
export function encodeNotebookContent(snapshot: NotebookSnapshotInput): string {
  const payload = {
    format: "hushnote",
    version: 1,
    shapes: snapshot.shapes.map(quantizeShape),
    layers: snapshot.layers,
    flowEdges: snapshot.flowEdges,
    bookmarks: snapshot.bookmarks,
    camera: snapshot.camera,
    background: snapshot.background,
  };
  return JSON.stringify(payload);
}

function parseBackground(v: unknown): NotebookBackground | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  const out: NotebookBackground = {};
  if (typeof b.pattern === "string") out.pattern = b.pattern as BackgroundPattern;
  if (typeof b.spacing === "number") out.spacing = b.spacing;
  if (typeof b.opacity === "number") out.opacity = b.opacity;
  return Object.keys(out).length ? out : undefined;
}

function isCamera(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.x === "number" && typeof c.y === "number" && typeof c.zoom === "number";
}

function quantizeShape(s: Shape): Shape {
  if (s.type !== "draw") return s;
  const ds = s as Shape & { points?: Array<{ x: number; y: number; pressure: number }> };
  if (!ds.points || ds.points.length === 0) return s;
  const points = ds.points.map((p) => ({
    x: Math.round(p.x),
    y: Math.round(p.y),
    pressure: Math.round(p.pressure * 20) / 20,
  }));
  return { ...ds, points } as Shape;
}

/** Parse on-disk notebook content. Tolerates the legacy bare-array form
 *  (produced before the envelope migration). Returns null on malformed
 *  input — caller should treat as empty. */
export function decodeNotebookContent(content: string | null | undefined): NotebookContent | null {
  if (!content || !content.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    // Legacy: bare Shape[] array — no layers, no edges.
    return { shapes: parsed as Shape[] };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const shapes = Array.isArray(obj.shapes) ? (obj.shapes as Shape[]) : [];
    const layers = Array.isArray(obj.layers) ? (obj.layers as Layer[]) : undefined;
    const flowEdges = Array.isArray(obj.flowEdges) ? (obj.flowEdges as FlowEdge[]) : undefined;
    const bookmarks = Array.isArray(obj.bookmarks) ? (obj.bookmarks as CameraBookmark[]) : undefined;
    const camera = isCamera(obj.camera) ? (obj.camera as Camera) : undefined;
    const background = parseBackground(obj.background);
    return { shapes, layers, flowEdges, bookmarks, camera, background };
  }
  return null;
}
