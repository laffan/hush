/**
 * Which proof page an image shape came from.
 *
 * `ImageShape.proofPageIndex` is the normal route, and it rides every
 * cut for free — a split spreads the original shape, so both halves
 * carry the same index and both resolve to the same page raster. Proofs
 * baked before that field existed fall back to matching the page
 * entries' recorded `shapeId`, so an old proof still resolves its uncut
 * pages instead of silently losing them.
 *
 * Two callers need this and they need it in the same shape: the page
 * rail, which paints a minimap out of the small rasters, and the
 * canvas's own proxy tier (`image-budget.ts`), which paints the same
 * rasters in place of a page the decode budget can't afford to hold
 * sharp. The legacy map is built once per lookup session rather than
 * once per shape, which is why this hands back a closure.
 */

import type { ImageShape } from "./types";

interface ProofSource {
  proof?: { pages: { index: number; shapeId: string; thumbDataUrl: string }[] } | null;
}

/** Lookup for one pass over the shapes. Builds its legacy `shapeId` map
 *  lazily, and only if some shape actually needs it. */
export function makeProofPageLookup(state: ProofSource): (img: ImageShape) => number | undefined {
  let legacy: Map<string, number> | null = null;
  return (img: ImageShape) => {
    if (typeof img.proofPageIndex === "number") return img.proofPageIndex;
    if (!legacy) {
      legacy = new Map();
      for (const p of state.proof?.pages || []) legacy.set(p.shapeId, p.index);
    }
    return legacy.get(img.id);
  };
}

/** The small raster baked for a page at import time, or "" if there
 *  isn't one (a notebook that isn't a proof, or an index the envelope
 *  doesn't carry). */
export function proofThumbDataUrl(state: ProofSource, pageIndex: number): string {
  // `?.pages.find` would only guard the `proof`, and a proof envelope
  // that survived a partial write (the codec preserves fields it does
  // not know) can carry no `pages` at all.
  return state.proof?.pages?.find((p) => p.index === pageIndex)?.thumbDataUrl || "";
}
