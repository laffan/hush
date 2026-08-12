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

import type { Shape, Layer, CameraBookmark, Camera, BackgroundPattern, ProofMeta, Split } from "./types";
import type { FlowEdge } from "./flowchart";

/** Per-notebook background overrides. Saved alongside shapes so each
 *  notebook remembers its own pattern / spacing / opacity instead of
 *  inheriting whatever the global Hush settings happened to be at open
 *  time. All fields optional; omitted fields fall back to global. */
export interface NotebookBackground {
  pattern?: BackgroundPattern;
  spacing?: number;
  opacity?: number;
  /** Two-finger canvas-rotation gesture opt-in (canvas settings menu).
   *  Rides the background envelope so it stays per-notebook like the
   *  rest of the canvas-surface options. */
  rotationEnabled?: boolean;
}

export interface NotebookContent {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
  bookmarks?: CameraBookmark[];
  camera?: Camera;
  background?: NotebookBackground;
  splits?: Split[];
  proof?: ProofMeta;
}

export interface NotebookSnapshotInput {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
  bookmarks?: CameraBookmark[];
  camera?: Camera;
  background?: NotebookBackground;
  splits?: Split[];
  proof?: ProofMeta;
}

/** JSON-encode a notebook snapshot in the envelope format.
 *  DrawShape points are quantized at this boundary: x/y rounded to integer
 *  pixels and pressure rounded to 0.05 buckets (2 decimal places). The
 *  visible difference is sub-pixel — `stroke-render.js`'s stamp radius is
 *  `halfSize * (0.6 + 0.4 * pressure)`, so 0.05 of pressure is 2% of
 *  halfSize, well below brush noise — and the byte savings on dense
 *  Pencil strokes are large (~50%). Serializing the quantized shape is
 *  the only place this lossy rounding happens; in-memory points keep
 *  their original precision while drawing.
 *
 *  The encode is split in two so camera-only autosaves can skip the
 *  expensive half: `encodeNotebookBody` serializes the content fields
 *  (shapes / layers / flowEdges / bookmarks — the multi-MB part on a
 *  stroke-heavy notebook, and a felt main-thread stall when it ran on
 *  every pan-position save), and `assembleNotebookContent` wraps a body
 *  — fresh or cached — with the envelope header and the cheap
 *  per-save tail (camera + background). `encodeNotebookContent`
 *  composes the two, so all three emit byte-identical envelopes for
 *  identical input. */
export function encodeNotebookContent(snapshot: NotebookSnapshotInput): string {
  return assembleNotebookContent(
    encodeNotebookBody(snapshot),
    snapshot.camera,
    snapshot.background,
  );
}

/** Serialize the content fields to an envelope fragment (the object
 *  body text without braces, e.g. `"shapes":[...],"layers":[...]`).
 *  `undefined` fields are omitted, matching JSON.stringify. `shapes`
 *  is required, so the fragment is never empty. */
export function encodeNotebookBody(
  snapshot: Pick<NotebookSnapshotInput, "shapes" | "layers" | "flowEdges" | "bookmarks" | "splits" | "proof">,
): string {
  const payload = {
    shapes: snapshot.shapes.map(quantizeShape),
    layers: snapshot.layers,
    flowEdges: snapshot.flowEdges,
    bookmarks: snapshot.bookmarks,
    // Splits and proofread metadata are content, not viewport — they
    // belong in the cached body so a camera-only save reuses them.
    splits: snapshot.splits && snapshot.splits.length ? snapshot.splits : undefined,
    proof: snapshot.proof || undefined,
  };
  return JSON.stringify(payload).slice(1, -1);
}

/** Wrap a body fragment from `encodeNotebookBody` with the envelope
 *  header and the per-save tail. The tail is tiny (camera + background)
 *  so callers holding a cached body pay only this on a camera-only
 *  save instead of re-serializing every shape. */
export function assembleNotebookContent(
  body: string,
  camera?: Camera,
  background?: NotebookBackground,
): string {
  const tail = JSON.stringify({ camera, background }).slice(1, -1);
  return `{"format":"hushnote","version":1,${body}${tail ? "," + tail : ""}}`;
}

function parseBackground(v: unknown): NotebookBackground | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  const out: NotebookBackground = {};
  if (typeof b.pattern === "string") out.pattern = b.pattern as BackgroundPattern;
  if (typeof b.spacing === "number") out.spacing = b.spacing;
  if (typeof b.opacity === "number") out.opacity = b.opacity;
  if (typeof b.rotationEnabled === "boolean") out.rotationEnabled = b.rotationEnabled;
  return Object.keys(out).length ? out : undefined;
}

/** Splits carry no bounds and no ids into anything else, so validation
 *  is just "are the two line positions real numbers". A malformed entry
 *  is dropped rather than failing the whole decode — losing one split
 *  line beats refusing to open the notebook. */
function isSplit(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string"
    && (s.orientation === "horizontal" || s.orientation === "vertical")
    && typeof s.a === "number" && Number.isFinite(s.a)
    && typeof s.b === "number" && Number.isFinite(s.b);
}

function parseProof(v: unknown): ProofMeta | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.pages)) return undefined;
  const pages = (p.pages as Record<string, unknown>[])
    .filter((pg) => pg && typeof pg.shapeId === "string")
    .map((pg, i) => ({
      index: typeof pg.index === "number" ? pg.index : i,
      shapeId: pg.shapeId as string,
      y: typeof pg.y === "number" ? pg.y : 0,
      height: typeof pg.height === "number" ? pg.height : 0,
      thumbDataUrl: typeof pg.thumbDataUrl === "string" ? pg.thumbDataUrl : "",
    }));
  if (!pages.length) return undefined;
  return {
    sourcePdfFileId: typeof p.sourcePdfFileId === "string" ? p.sourcePdfFileId : null,
    sourceName: typeof p.sourceName === "string" ? p.sourceName : "",
    pageLayerId: typeof p.pageLayerId === "string" ? p.pageLayerId : "",
    pages,
  };
}

function isCamera(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.x === "number" && typeof c.y === "number" && typeof c.zoom === "number";
}

function quantizeShape(s: Shape): Shape {
  if (s.type !== "draw") return s;
  const ds = s as Shape & { points?: Array<{ x: number; y: number; pressure: number; t?: number }> };
  if (!ds.points || ds.points.length === 0) return s;
  const points = ds.points.map((p) => ({
    x: Math.round(p.x),
    y: Math.round(p.y),
    pressure: Math.round(p.pressure * 20) / 20,
    // Capture timestamp (ms) — feeds the ML Kit ink recognizer's
    // velocity model; whole ms is plenty. Omitted for legacy points
    // so the JSON doesn't grow "t": undefined noise.
    ...(p.t !== undefined ? { t: Math.round(p.t) } : {}),
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
    const splits = Array.isArray(obj.splits) ? (obj.splits as Split[]).filter(isSplit) : undefined;
    const proof = parseProof(obj.proof);
    return { shapes, layers, flowEdges, bookmarks, camera, background, splits, proof };
  }
  return null;
}
