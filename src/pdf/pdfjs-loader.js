/**
 * Shared lazy pdfjs-dist loader — one worker setup for every consumer
 * (viewer, folds, thumbnails, covers, proofs, doc-export render).
 */

let pdfjsPromise = null;

export async function getPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}

/** Where pdf.js finds what it loads at run time (vite.config.js serves
 *  and bundles them under /pdfjs/). Without `wasmUrl` the JBIG2 and
 *  JPEG 2000 decoders never load, and a scanned PDF renders blank
 *  around its OCR text. Every getDocument call spreads these in. */
const assetDir = (dir) => new URL(`pdfjs/${dir}/`,
  typeof document !== "undefined" ? document.baseURI : "/").href;

export const PDFJS_ASSETS = {
  wasmUrl: assetDir("wasm"),
  iccUrl: assetDir("iccs"),
  standardFontDataUrl: assetDir("standard_fonts"),
  cMapUrl: assetDir("cmaps"),
  cMapPacked: true,
};
