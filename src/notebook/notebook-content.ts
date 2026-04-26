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

import type { Shape, Layer } from "./types";
import type { FlowEdge } from "./flowchart";

export interface NotebookContent {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
}

export interface NotebookSnapshotInput {
  shapes: Shape[];
  layers?: Layer[];
  flowEdges?: FlowEdge[];
}

/** JSON-encode a notebook snapshot in the envelope format. */
export function encodeNotebookContent(snapshot: NotebookSnapshotInput): string {
  const payload = {
    format: "hushnote",
    version: 1,
    shapes: snapshot.shapes,
    layers: snapshot.layers,
    flowEdges: snapshot.flowEdges,
  };
  return JSON.stringify(payload);
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
    return { shapes, layers, flowEdges };
  }
  return null;
}
