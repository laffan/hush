/**
 * Zotero PDF snapshot pipeline.
 *
 * Given a Zotero item key for a PDF attachment, downloads the PDF (if not
 * already cached locally), rasterizes a single page at the user's chosen
 * render height, and returns a `{ dataUrl, width, height }` ready to be
 * saved through the standard image pipeline.
 *
 * PDFs themselves are kept in `{data_dir}/zotero_pdfs/` (Tauri-only) so
 * subsequent inserts of a different page from the same paper skip the
 * network fetch.
 *
 * Imports `pdfjs-dist` lazily so the ~1MB worker bundle is only paid for
 * by users who actually use the snapshot feature.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const ZOTERO_API = "https://api.zotero.org";

let pdfjsPromise = null;

async function getPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Download a PDF attachment from Zotero into local storage.
 *
 * In Tauri, the request runs server-side via `download_zotero_pdf` —
 * the Zotero file endpoint redirects to a presigned S3 URL whose CORS
 * policy rejects the webview's `null` origin, so a webview-side fetch
 * fails after the redirect. Outside Tauri (browser dev fallback) we
 * still attempt a direct fetch; it'll succeed only if the user's
 * browser/CORS situation allows it. */
async function fetchAndCachePdf(itemKey, userId, apiKey) {
  if (IS_TAURI) {
    const bytes = await tauriInvoke("download_zotero_pdf", {
      itemKey,
      userId,
      apiKey,
    });
    return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  }
  const url = `${ZOTERO_API}/users/${userId}/items/${itemKey}/file?key=${apiKey}`;
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`PDF download failed: HTTP ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}

/** Get the page count for a cached or freshly-downloaded PDF. */
export async function getPdfPageCount(itemKey, userId, apiKey) {
  const bytes = await fetchAndCachePdf(itemKey, userId, apiKey);
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/**
 * Render a single PDF page to a WebP data URL at the specified pixel
 * height. Width is derived from the page's aspect ratio. Quality is a
 * 0–1 float (mapped from the user's 1–100 setting upstream).
 */
export async function renderPdfPage(itemKey, userId, apiKey, pageNumber, renderHeight, quality = 0.9) {
  const bytes = await fetchAndCachePdf(itemKey, userId, apiKey);
  // pdfjs takes ownership of the buffer it parses — pass a copy so we
  // can keep the original around for caching / re-renders.
  const data = new Uint8Array(bytes);
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const safePage = Math.min(Math.max(1, pageNumber | 0), doc.numPages);
    const page = await doc.getPage(safePage);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = renderHeight / baseViewport.height;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // pdfjs v5: pass the canvas itself; the engine retrieves its own
    // 2D context. Don't pre-fill — pdfjs paints the page background
    // colour itself, and pre-filling on top of an already-rendered page
    // can produce blank output if rendering finishes before the fill.
    const renderTask = page.render({ canvas, viewport, background: "#ffffff" });
    await renderTask.promise;
    // WebP — visually close to PNG for typical academic pages and
    // several times smaller. Matters because the snapshot dataUrl
    // rides inside the notebook's JSON envelope.
    const dataUrl = canvas.toDataURL("image/webp", quality);
    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      pageCount: doc.numPages,
    };
  } finally {
    await doc.destroy();
  }
}
