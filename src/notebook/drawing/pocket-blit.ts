/* src/notebook/drawing/pocket-blit.ts
 *
 * Done-canvas / pocket-stash blit helpers extracted from
 * drawing-layer.ts. Pocketed strokes are absent from the done canvas
 * (engine delta #8); on pocket-in we copy the world-bbox region into
 * the stash so the pocket-tray renderer can read it back via
 * `blitWorldRegion`. `blitDoneCanvasAtWorldOrigin` is the export
 * pipeline's "paint every non-pocketed stroke into a target ctx"
 * helper.
 *
 * Origin, worldSize, and DPR are read via getters every call — the
 * drawing layer re-anchors the wrapper world-origin to follow the
 * camera, so any of these can shift between calls.
 */

export interface WorldBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PocketBlitOptions {
  /** Resolve the CURRENT done canvas per call — engine delta #31 swaps
   *  the done role between two elements at each re-anchor, so a
   *  captured reference goes stale. */
  getDoneCanvas: () => HTMLCanvasElement;
  pocketStash: HTMLCanvasElement;
  pocketStashCtx: CanvasRenderingContext2D;
  /** Live world-space origin of the done / stash canvases. Both
   *  canvases cover the rect [origin, origin + worldSize] at the
   *  current DPR. The drawing layer re-anchors origin as the camera
   *  pans, so this is read every call. */
  getOriginX: () => number;
  getOriginY: () => number;
  /** Live side length (CSS px) of the world rect the canvases back.
   *  Grows when the camera zooms out so the canvas keeps covering the
   *  visible viewport. */
  getWorldSize: () => number;
  /** Live DPR of the canvases. The drawing layer caps DPR for memory
   *  safety, so we re-read every call instead of caching. */
  getDpr: () => number;
}

export interface PocketBlit {
  /** Paint a world-bbox region of the *pocket stash* into `ctx` at
   *  its current transform. Pocketed strokes — and only pocketed
   *  strokes — appear on the stash, so this is the read path used by
   *  the pocket tray's renderer. */
  blitWorldRegion(ctx: CanvasRenderingContext2D, worldBbox: WorldBbox): void;
  /** Blit the entire non-pocketed stroke canvas ("done") into `ctx`
   *  at its current transform, positioned so world coords line up. */
  blitDoneCanvasAtWorldOrigin(ctx: CanvasRenderingContext2D): void;
  /** Capture a world-bbox region from the done canvas into the stash
   *  — call before the engine rebakes and removes a pocketed stroke. */
  stashPocketRegion(worldBbox: WorldBbox): void;
  /** Clear a world-bbox region from the stash so it doesn't accumulate
   *  stale pixels after an unpocket. */
  unstashPocketRegion(worldBbox: WorldBbox): void;
}

export function createPocketBlit(opts: PocketBlitOptions): PocketBlit {
  const { getDoneCanvas, pocketStash, pocketStashCtx, getOriginX, getOriginY, getWorldSize, getDpr } = opts;

  function blitWorldRegion(
    ctx: CanvasRenderingContext2D,
    worldBbox: WorldBbox,
  ): void {
    const dpr = getDpr();
    const sx = (worldBbox.minX - getOriginX()) * dpr;
    const sy = (worldBbox.minY - getOriginY()) * dpr;
    const w = worldBbox.maxX - worldBbox.minX;
    const h = worldBbox.maxY - worldBbox.minY;
    const sw = w * dpr;
    const sh = h * dpr;
    if (sx + sw <= 0 || sy + sh <= 0 || sx >= pocketStash.width || sy >= pocketStash.height) return;
    if (w <= 0 || h <= 0) return;
    ctx.drawImage(
      pocketStash,
      sx, sy, sw, sh,
      worldBbox.minX, worldBbox.minY, w, h,
    );
  }

  function blitDoneCanvasAtWorldOrigin(ctx: CanvasRenderingContext2D): void {
    const doneCanvas = getDoneCanvas();
    if (doneCanvas.width === 0 || doneCanvas.height === 0) return;
    ctx.drawImage(doneCanvas, getOriginX(), getOriginY(), getWorldSize(), getWorldSize());
  }

  function stashPocketRegion(worldBbox: WorldBbox): void {
    const doneCanvas = getDoneCanvas();
    const dpr = getDpr();
    const sx = Math.max(0, Math.floor((worldBbox.minX - getOriginX()) * dpr));
    const sy = Math.max(0, Math.floor((worldBbox.minY - getOriginY()) * dpr));
    const sw = Math.ceil((worldBbox.maxX - worldBbox.minX) * dpr);
    const sh = Math.ceil((worldBbox.maxY - worldBbox.minY) * dpr);
    if (sw <= 0 || sh <= 0) return;
    if (sx >= doneCanvas.width || sy >= doneCanvas.height) return;
    pocketStashCtx.drawImage(doneCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }

  function unstashPocketRegion(worldBbox: WorldBbox): void {
    const dpr = getDpr();
    const sx = Math.max(0, Math.floor((worldBbox.minX - getOriginX()) * dpr));
    const sy = Math.max(0, Math.floor((worldBbox.minY - getOriginY()) * dpr));
    const sw = Math.ceil((worldBbox.maxX - worldBbox.minX) * dpr);
    const sh = Math.ceil((worldBbox.maxY - worldBbox.minY) * dpr);
    if (sw <= 0 || sh <= 0) return;
    pocketStashCtx.clearRect(sx, sy, sw, sh);
  }

  return { blitWorldRegion, blitDoneCanvasAtWorldOrigin, stashPocketRegion, unstashPocketRegion };
}
