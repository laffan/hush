/**
 * The first half of an Inbox notebook snapshot (inbox-notebook-thumb.js
 * draws it): what the snapshot needs, taken from the canvas as the save
 * lands, while the canvas still holds the notebook that was saved. Kept
 * apart from the renderer so the save path can call it synchronously
 * without loading any drawing code.
 */

/** The crop, in screen px, centred on the view. */
export const CROP_W = 1024;
export const CROP_H = 768;

/** What a snapshot needs from `canvasInstance`, taken now: null when
 *  the canvas isn't on screen (keep the snapshot there is), `{ empty:
 *  true }` when it holds nothing (drop it). */
export function captureScene(canvasInstance) {
  const st = canvasInstance?.state;
  const host = canvasInstance?.container;
  if (!st || !host) return null;
  const vw = host.clientWidth;
  const vh = host.clientHeight;
  if (!vw || !vh) return null;
  const shapes = st.shapes || [];
  if (!shapes.some((s) => !s.pocketed)) return { empty: true };
  const cam = st.camera || { x: 0, y: 0, zoom: 1 };
  return {
    shapes,
    layers: st.layers,
    flowEdges: st.flowEdgesLocked ? [] : st.flowchart?.serialize?.() || [],
    // The crop's corner becomes the origin, so the camera shifts by it.
    camera: { x: cam.x - (vw - CROP_W) / 2, y: cam.y - (vh - CROP_H) / 2, zoom: cam.zoom || 1 },
    themes: {
      light: st.themeForVariant?.("light") || st.theme,
      dark: st.themeForVariant?.("dark") || st.theme,
    },
    fontFamily: st.fontFamily || "Inter",
    gridSpacing: st.gridSpacing || 25,
    imageCache: canvasInstance.getImageCache?.() || new Map(),
  };
}
