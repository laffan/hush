/**
 * Notebook sync serialization — pack/unpack .hushnote zip files.
 *
 * .hushnote is a ZIP archive containing:
 *   data.json   — the notebook envelope (shapes + layers + flowEdges) with
 *                 image dataUrls in shapes replaced by relative paths
 *                 ("images/img_N.png") into the zip
 *   images/     — extracted image binaries
 *
 * Internal storage keeps images inline as base64 dataUrls; the zip format
 * extracts them so the file is portable and smaller on disk.
 *
 * The envelope shape mirrors `notebook/notebook-content.ts`:
 *   { format: "hushnote", version: 1, shapes, layers?, flowEdges? }
 *
 * Earlier versions of this file packed only `shapes` and dropped layers
 * and flowEdges on every sync, which made cross-device notebooks look
 * empty. Both pack/unpack are now envelope-aware and tolerate the
 * legacy bare-array form on input for back-compat.
 */

import JSZip from "jszip";

function guessExtension(dataUrl) {
  if (dataUrl.includes("image/png")) return ".png";
  if (dataUrl.includes("image/jpeg") || dataUrl.includes("image/jpg")) return ".jpg";
  if (dataUrl.includes("image/webp")) return ".webp";
  if (dataUrl.includes("image/gif")) return ".gif";
  if (dataUrl.includes("image/svg")) return ".svg";
  return ".png";
}

/** Best-effort parse of the on-disk content into `{ shapes, layers, flowEdges }`.
 *  Tolerates the legacy bare-array form. Mirrors `decodeNotebookContent`
 *  in notebook-content.ts but lives here to keep this module dependency-free. */
function parseEnvelope(jsonContent) {
  if (!jsonContent || !jsonContent.trim()) {
    return { shapes: [], layers: undefined, flowEdges: undefined };
  }
  let parsed;
  try { parsed = JSON.parse(jsonContent); }
  catch { return { shapes: [], layers: undefined, flowEdges: undefined }; }

  if (Array.isArray(parsed)) {
    return { shapes: parsed, layers: undefined, flowEdges: undefined };
  }
  if (parsed && typeof parsed === "object") {
    return {
      shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [],
      layers: Array.isArray(parsed.layers) ? parsed.layers : undefined,
      flowEdges: Array.isArray(parsed.flowEdges) ? parsed.flowEdges : undefined,
    };
  }
  return { shapes: [], layers: undefined, flowEdges: undefined };
}

/**
 * Pack a notebook's internal JSON content into a .hushnote zip (Uint8Array).
 * Accepts either the envelope format produced by `encodeNotebookContent` or
 * the legacy bare `Shape[]` array. Always emits the envelope inside the zip.
 * @param {string} jsonContent
 * @returns {Promise<Uint8Array>}
 */
export async function packNotebook(jsonContent) {
  const { shapes, layers, flowEdges } = parseEnvelope(jsonContent);

  const zip = new JSZip();
  const imgFolder = zip.folder("images");
  let imgIndex = 0;

  const exportShapes = shapes.map((s) => {
    if (s.type !== "image" || !s.dataUrl) return s;
    // Already pointing at a zip-relative path (e.g. mid-pack edge case) —
    // leave alone.
    if (!s.dataUrl.startsWith("data:")) return s;
    const ext = guessExtension(s.dataUrl);
    const imgFilename = `img_${imgIndex++}${ext}`;
    const base64 = s.dataUrl.split(",")[1];
    if (base64) imgFolder.file(imgFilename, base64, { base64: true });
    return { ...s, dataUrl: `images/${imgFilename}` };
  });

  const envelope = {
    format: "hushnote",
    version: 1,
    shapes: exportShapes,
    layers,
    flowEdges,
  };
  zip.file("data.json", JSON.stringify(envelope, null, 2));
  return await zip.generateAsync({ type: "uint8array" });
}

/**
 * Unpack a .hushnote zip into the internal JSON envelope string.
 * Re-inlines images from images/ as base64 dataUrls; returns a string the
 * editor's `decodeNotebookContent` can read directly. Tolerates the
 * legacy bare-array form for back-compat with old `.hushnote` files.
 * @param {ArrayBuffer|Uint8Array} zipData
 * @returns {Promise<string>}
 */
export async function unpackNotebook(zipData) {
  // .hushnote ships in two forms: a zip envelope from the sync path
  // (packNotebook) and a plain pretty-printed JSON envelope from the
  // export modal (notebook-export.ts). Both carry the same shapes
  // payload — sniff the leading "PK" zip magic so either round-trips
  // back into the canvas.
  const bytes = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData);
  const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    const text = new TextDecoder().decode(bytes);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return JSON.stringify({ format: "hushnote", version: 1, shapes: [] }); }
    if (Array.isArray(parsed)) {
      return JSON.stringify({ format: "hushnote", version: 1, shapes: parsed });
    }
    if (parsed && typeof parsed === "object") {
      return JSON.stringify({
        format: "hushnote",
        version: 1,
        shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [],
        layers: Array.isArray(parsed.layers) ? parsed.layers : undefined,
        flowEdges: Array.isArray(parsed.flowEdges) ? parsed.flowEdges : undefined,
      });
    }
    return JSON.stringify({ format: "hushnote", version: 1, shapes: [] });
  }

  const zip = await JSZip.loadAsync(bytes);
  const dataFile = zip.file("data.json");
  if (!dataFile) return JSON.stringify({ format: "hushnote", version: 1, shapes: [] });

  const json = await dataFile.async("string");
  let parsed;
  try { parsed = JSON.parse(json); }
  catch { return JSON.stringify({ format: "hushnote", version: 1, shapes: [] }); }

  let shapes, layers, flowEdges;
  if (Array.isArray(parsed)) {
    shapes = parsed; layers = undefined; flowEdges = undefined;
  } else if (parsed && typeof parsed === "object") {
    shapes = Array.isArray(parsed.shapes) ? parsed.shapes : [];
    layers = Array.isArray(parsed.layers) ? parsed.layers : undefined;
    flowEdges = Array.isArray(parsed.flowEdges) ? parsed.flowEdges : undefined;
  } else {
    shapes = []; layers = undefined; flowEdges = undefined;
  }

  const inlinedShapes = await Promise.all(shapes.map(async (s) => {
    if (s.type !== "image" || !s.dataUrl) return s;
    if (s.dataUrl.startsWith("data:")) return s;
    const imgFile = zip.file(s.dataUrl);
    if (!imgFile) return s;
    const data = await imgFile.async("base64");
    const ext = s.dataUrl.split(".").pop() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp" : `image/${ext}`;
    return { ...s, dataUrl: `data:${mime};base64,${data}` };
  }));

  return JSON.stringify({
    format: "hushnote",
    version: 1,
    shapes: inlinedShapes,
    layers,
    flowEdges,
  });
}
