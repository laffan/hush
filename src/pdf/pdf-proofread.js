/**
 * Proofread PDF — build a notebook from the open PDF.
 *
 * Every page is rasterised once, at import time, into an `ImageShape`
 * laid out in a single vertical column with a fixed gutter between
 * pages. The result is an ordinary `.hushnote`: the pages are shapes on
 * a locked bottom layer, the annotation layer above it is a normal
 * notebook layer, and every notebook tool — ink, text, drag boxes,
 * splits, grabs — works on it without knowing it came from a PDF.
 *
 * ### Why bake rather than render live
 *
 * The PDF viewer keeps a live pdfjs document and rasterises on demand.
 * A proof can't: it must survive the source PDF being moved, renamed, or
 * opened on another device, and the whole point is to cut the pages up —
 * a live renderer has no way to draw "the bottom two thirds of page 4,
 * shifted 200 px down". So the bytes ride in the notebook.
 *
 * ### The two costs that matter
 *
 * 1. **Envelope size.** A page raster is base64 inside the notebook
 *    JSON, and the JSON is re-serialised on content saves. Pages are
 *    therefore capped at `MAX_PAGE_RASTER_WIDTH` and encoded as JPEG —
 *    on scanned or text-heavy pages that is several times smaller than
 *    PNG, and the notebook's save gate (quiet-moment + backpressure)
 *    covers the rest.
 * 2. **Decoded bitmaps.** Fifty full-size pages decoded at once is
 *    hundreds of megabytes. `notebook/image-budget.ts` keeps only the
 *    pages near the viewport decoded, which is why the thumbnail rail
 *    gets its OWN small rasters here rather than pointing at the page
 *    images — a rail of fifty full-page `<img>`s would reintroduce
 *    exactly the problem the budget removes.
 */

import { getPdfjs } from "./pdfjs-loader.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Vertical space between pages, in canvas world units. */
const PAGE_GAP = 50;

/** World size of a page relative to its own point size.
 *
 *  A page at 1× would be its PDF point size on the canvas — "100 % =
 *  actual size" — which sounds right and reads too small, because the
 *  notebook camera clamps zoom at 1 and so cannot magnify it any
 *  further. Baking the pages at 2× is the only way to give a proof
 *  room to be read and written on. The raster above is sized
 *  independently, so this costs nothing in bytes: it just spends the
 *  same pixels over twice the world area (a US-Letter page ends up at
 *  ~2.3 device px per world px, still comfortably sharp at zoom 1). */
const PAGE_WORLD_SCALE = 2;

/** Longest edge, in raster px, any page is rendered at.
 *
 *  This and `PAGE_WORLD_SCALE` together set how sharp a page looks: a
 *  US-Letter page lands at 2800 raster px over 1224 world px, so ~2.3
 *  device px per world px — crisp at the camera's maximum zoom of 1 on a
 *  Retina display, with a little headroom. It is also the single
 *  largest term in the notebook's file size (base64, inside JSON that is
 *  re-serialised on content saves), and it grows with the SQUARE of this
 *  number, so raising it is not free. Pages wider than this in points
 *  fall back to whatever scale fits, which is what the cap is for. */
const MAX_PAGE_RASTER_WIDTH = 2800;

/** Ceiling on the render scale itself, so a page that is already tiny
 *  in points doesn't get blown up past what its content can support. */
const MAX_PAGE_RASTER_SCALE = 4;

/** JPEG quality for page rasters. Still below the 0.9 the Zotero
 *  snapshot path uses — a snapshot is one image, a proof is fifty — but
 *  high enough that compression noise isn't what limits how sharp a page
 *  looks. Once the raster is past the display's pixel density, quality
 *  buys more visible fidelity per byte than resolution does, and this is
 *  the knob to reach for first if pages ever look soft. */
const PAGE_QUALITY = 0.8;

/** Thumbnail raster width. The rail is resizable up to 300 CSS px and
 *  draws page *pieces* out of these rasters (see `ui/proof-thumbnails`),
 *  so they have to stay legible at the widest setting — but they are also
 *  the one part of the proof that is decoded all at once, so this is
 *  deliberately far below the page rasters above. */
const THUMB_RASTER_WIDTH = 480;
const THUMB_QUALITY = 0.6;

/** Above this many pages we ask first: the bake is linear in page count
 *  and the notebook it produces is linear in size, and a user who hit
 *  ⌘P on a 400-page book deserves the chance to say no. */
const CONFIRM_ABOVE_PAGES = 60;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Let the browser paint between pages so the progress overlay actually
 *  advances and the app stays responsive through a long bake. */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function makeProgressOverlay(total) {
  const el = document.createElement("div");
  el.className = "proofread-progress";
  el.innerHTML = `<div class="proofread-progress-box">
      <div class="proofread-progress-label">Preparing proof…</div>
      <div class="proofread-progress-track"><div class="proofread-progress-fill"></div></div>
    </div>`;
  document.body.appendChild(el);
  const label = el.querySelector(".proofread-progress-label");
  const fill = el.querySelector(".proofread-progress-fill");
  return {
    step(n) {
      label.textContent = `Rendering page ${n} of ${total}…`;
      fill.style.width = `${Math.round((n / total) * 100)}%`;
    },
    done() { el.remove(); },
  };
}

/** Render one page to a JPEG data URL plus a small thumbnail, then drop
 *  both canvases. Nothing but the two strings survives the call — a
 *  retained canvas per page is the memory leak this whole module is
 *  arranged to avoid. */
async function rasterizePage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_PAGE_RASTER_SCALE, MAX_PAGE_RASTER_WIDTH / Math.max(base.width, 1));
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;
  // JPEG, not WebP: `toDataURL("image/webp")` silently falls back to PNG
  // on WebKit (see README-TECHNICAL's platform gotchas), which would
  // quietly triple the envelope on macOS and iPad.
  const dataUrl = canvas.toDataURL("image/jpeg", PAGE_QUALITY);

  const thumb = document.createElement("canvas");
  const tScale = THUMB_RASTER_WIDTH / canvas.width;
  thumb.width = THUMB_RASTER_WIDTH;
  thumb.height = Math.max(1, Math.round(canvas.height * tScale));
  const tctx = thumb.getContext("2d");
  tctx.fillStyle = "#ffffff";
  tctx.fillRect(0, 0, thumb.width, thumb.height);
  tctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const thumbDataUrl = thumb.toDataURL("image/jpeg", THUMB_QUALITY);

  // Release the backing stores now rather than waiting for GC — on
  // iPadOS each one is an IOSurface and fifty of them outlive the bake.
  canvas.width = canvas.height = 0;
  thumb.width = thumb.height = 0;

  return {
    dataUrl,
    thumbDataUrl,
    width: base.width * PAGE_WORLD_SCALE,
    height: base.height * PAGE_WORLD_SCALE,
  };
}

function makeId(prefix, i) {
  return `${prefix}_${Date.now().toString(36)}_${i}`;
}

/**
 * Build the notebook envelope for a proof. Pure apart from the pdfjs
 * calls and the progress callback, so it can be reused by any future
 * entry point (a folder-wide proof run, a Zotero attachment).
 *
 * Layers are stored top-first, so index 0 is the annotation layer the
 * user draws on and index 1 is the locked page layer beneath it. The
 * page layer starts locked because every gesture in a proofreading
 * session is aimed at the ink, not at the paper — but it is an ordinary
 * layer lock, so the layers panel can unlock it whenever the user does
 * want to move a page.
 */
export async function buildProofNotebookContent(bytes, sourceName, sourcePdfFileId, onProgress) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const pageLayerId = makeId("layer", 0);
    const inkLayerId = makeId("layer", 1);
    const shapes = [];
    const pages = [];
    let y = 0;
    const createdAt = Date.now();

    for (let i = 0; i < doc.numPages; i++) {
      onProgress?.(i + 1);
      await nextFrame();
      const page = await doc.getPage(i + 1);
      const raster = await rasterizePage(page);
      // pdfjs caches per-page render state; the proof never revisits a
      // page, so hand it back immediately.
      page.cleanup();
      const shapeId = makeId("page", i);
      shapes.push({
        id: shapeId,
        type: "image",
        position: { x: 0, y },
        width: raster.width,
        height: raster.height,
        dataUrl: raster.dataUrl,
        name: `Page ${i + 1}`,
        color: "#000000",
        layerId: pageLayerId,
        createdAt,
        proofPageIndex: i,
      });
      pages.push({
        index: i,
        shapeId,
        y,
        height: raster.height,
        width: raster.width,
        thumbDataUrl: raster.thumbDataUrl,
      });
      y += raster.height + PAGE_GAP;
    }

    const { encodeNotebookContent } = await import("../notebook/notebook-content.ts");
    return encodeNotebookContent({
      shapes,
      layers: [
        { id: inkLayerId, name: "Notes", locked: false, hidden: false },
        { id: pageLayerId, name: "Pages", locked: true, hidden: false },
      ],
      // Open at the top of page 1 with a little breathing room, rather
      // than at the world origin.
      camera: { x: 40, y: 40, zoom: 1 },
      // A proof is a stack of pages, and a dot grid showing through the
      // gaps between them just reads as noise on paper. Per-notebook, so
      // it doesn't touch the user's default for ordinary notebooks.
      background: { pattern: "blank" },
      proof: { sourcePdfFileId, sourceName, pageLayerId, pages },
    });
  } finally {
    await doc.destroy();
  }
}

/** Page count without paying for a full render — used for the
 *  are-you-sure gate on very long documents. */
async function pageCountOf(bytes) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/**
 * Command-palette entry point: turn the currently open PDF into a
 * `<name>-Proof` notebook in the desk's Inbox and open it.
 */
export async function proofreadCurrentPdf(state) {
  const fileId = state.currentPdfFileId;
  if (!fileId || !IS_TAURI) return null;

  const { findNodeByFileId } = await import("../state/tree-helpers.js");
  const node = findNodeByFileId(state.fileTree, fileId);
  const sourceName = (node?.name || "PDF").replace(/\.pdf$/i, "");

  let bytes;
  try {
    bytes = await tauriInvoke("load_pdf", { fileId });
  } catch (e) {
    console.error("Proofread PDF: failed to load the PDF:", e);
    window.alert("Could not read that PDF.");
    return null;
  }
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  let total;
  try {
    total = await pageCountOf(data);
  } catch (e) {
    console.error("Proofread PDF: failed to parse the PDF:", e);
    window.alert("Could not read that PDF.");
    return null;
  }
  if (total > CONFIRM_ABOVE_PAGES) {
    const ok = await confirmLongProof(total);
    if (!ok) return null;
  }

  const progress = makeProgressOverlay(total);
  let content;
  try {
    content = await buildProofNotebookContent(data, sourceName, fileId, (n) => progress.step(n));
  } catch (e) {
    console.error("Proofread PDF: render failed:", e);
    window.alert("Rendering the proof failed partway through. Nothing was created.");
    return null;
  } finally {
    progress.done();
  }

  return state.createNotebook(`${sourceName}-Proof`, null, { initialContent: content });
}

function confirmLongProof(total) {
  return new Promise((resolve) => {
    import("../sidebar/files-panel-shared.js").then(({ showConfirmModal }) => {
      showConfirmModal({
        title: "Proofread PDF",
        message: `This PDF has ${total} pages. Every page is rendered into the notebook, which will take a while and produce a large file.`,
        confirmLabel: "Proofread anyway",
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    }).catch(() => resolve(true));
  });
}
