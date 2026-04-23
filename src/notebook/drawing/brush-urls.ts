/* Vite-resolved brush atlas URLs.
 *
 * The engine's atlas cache (`engine/stroke-atlas.js`) accepts a
 * `brushUrl(id) => url | null` resolver. We map each brush id to the
 * right PNG via Vite's `?url` asset import, which produces a hashed
 * URL in production builds and the dev-server URL while developing.
 * Returning null for a brush with no PNG tells the loader to skip
 * the fetch (engine delta #1b). `brush-highlighter` intentionally
 * has no PNG — it uses the procedural flat fallback in the atlas. */

import brush1 from "./engine/brushes/brush-1.png?url";
import brush2 from "./engine/brushes/brush-2.png?url";
import brush3 from "./engine/brushes/brush-3.png?url";
import brush4 from "./engine/brushes/brush-4.png?url";
import brush5 from "./engine/brushes/brush-5.png?url";

const URLS: Record<string, string | null> = {
  "brush-1": brush1,
  "brush-2": brush2,
  "brush-3": brush3,
  "brush-4": brush4,
  "brush-5": brush5,
  "brush-highlighter": null,
};

export function brushUrl(id: string): string | null {
  return URLS[id] ?? null;
}
