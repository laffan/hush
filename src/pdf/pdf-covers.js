/**
 * PDF cover thumbnails — a first-page raster for every PDF in the
 * library, powering the PDF Shelf cards (and any future gallery UI).
 *
 * Covers are a per-device cache exactly like the PDF binaries: rendered
 * once via pdfjs (same pipeline as the Zotero snapshot feature), stored
 * beside the binary through the `save_pdf_cover` / `load_pdf_cover`
 * Tauri commands, and re-rendered on demand if missing. Nothing here
 * rides sync — a fresh device regenerates covers from the re-downloaded
 * binaries.
 *
 * Generation is standard for every import path (Zotero single save,
 * batch background download) and backfilled lazily by the shelf for
 * PDFs saved before covers shipped.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// Rendered pixel height of the stored cover. Shelf cards display at
// ~200 px wide, so ~600 px tall covers stay crisp on 2× displays
// without ballooning the cache.
const COVER_RENDER_HEIGHT = 600;
const COVER_QUALITY = 0.82;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

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

// fileId -> object URL for this session. Object URLs are kept for the
// app's lifetime — covers are small and the shelf re-uses them across
// opens without another IPC round trip.
const _urlCache = new Map();
// fileIds whose generation is already in flight — dedupes concurrent
// ensure calls (import hook + shelf backfill can race).
const _inFlight = new Map();

function bytesToObjectUrl(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Sniff the actual codec — WebKit's canvas may emit PNG where Chromium
  // emits WebP, and a mislabeled Blob type can stop the <img> decoder.
  let type = "";
  if (u8.length > 11 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) type = "image/webp";
  else if (u8.length > 3 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e) type = "image/png";
  else if (u8.length > 2 && u8[0] === 0xff && u8[1] === 0xd8) type = "image/jpeg";
  return URL.createObjectURL(new Blob([u8], type ? { type } : {}));
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Rasterize page 1 of `bytes` and return encoded image bytes (WebP
 *  where the platform canvas supports it, PNG otherwise). */
export async function renderCoverFromPdfBytes(bytes) {
  // pdfjs takes ownership of the buffer it parses — hand it a copy so
  // the caller can still save/reuse the original bytes.
  const data = new Uint8Array(bytes);
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = COVER_RENDER_HEIGHT / baseViewport.height;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    return dataUrlToBytes(canvas.toDataURL("image/webp", COVER_QUALITY));
  } finally {
    await doc.destroy();
  }
}

/** Return the cover's object URL if one is already stored (session
 *  cache or on disk), without generating anything. Null when absent. */
export async function loadPdfCoverUrl(fileId) {
  if (!fileId) return null;
  if (_urlCache.has(fileId)) return _urlCache.get(fileId);
  if (!IS_TAURI) return null;
  try {
    const bytes = await tauriInvoke("load_pdf_cover", { fileId });
    if (!bytes || !bytes.length) return null;
    const url = bytesToObjectUrl(bytes);
    _urlCache.set(fileId, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Make sure a cover exists for `fileId` and return its object URL.
 * `opts.bytes` short-circuits the binary load when the caller already
 * holds the PDF bytes (both import paths do). Returns null when the
 * binary isn't on disk yet (pending download) or rendering fails —
 * callers treat that as "placeholder card".
 */
export async function ensurePdfCover(fileId, opts = {}) {
  if (!fileId) return null;
  const existing = await loadPdfCoverUrl(fileId);
  if (existing) return existing;
  if (_inFlight.has(fileId)) return _inFlight.get(fileId);

  const job = (async () => {
    try {
      let bytes = opts.bytes || null;
      if (!bytes) {
        if (!IS_TAURI) return null;
        try {
          bytes = await tauriInvoke("load_pdf", { fileId });
        } catch {
          return null; // binary not downloaded yet
        }
      }
      if (!bytes || !bytes.length) return null;
      const coverBytes = await renderCoverFromPdfBytes(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      );
      if (IS_TAURI) {
        try {
          await tauriInvoke("save_pdf_cover", { fileId, bytes: Array.from(coverBytes) });
        } catch (e) {
          console.warn("save_pdf_cover failed:", e);
        }
      }
      const url = bytesToObjectUrl(coverBytes);
      _urlCache.set(fileId, url);
      return url;
    } catch (e) {
      console.warn("PDF cover render failed:", e);
      return null;
    } finally {
      _inFlight.delete(fileId);
    }
  })();
  _inFlight.set(fileId, job);
  return job;
}

/** Drop a cover from the session cache (the on-disk file is removed by
 *  the Rust `delete_pdf` path alongside the binary). */
export function evictPdfCover(fileId) {
  const url = _urlCache.get(fileId);
  if (url) {
    try { URL.revokeObjectURL(url); } catch {}
    _urlCache.delete(fileId);
  }
}
