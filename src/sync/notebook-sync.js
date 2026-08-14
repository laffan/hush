/**
 * Notebook sync serialization — pack/unpack .hushnote zip files.
 *
 * .hushnote is a ZIP archive containing:
 *   data.json   — the notebook envelope, with image dataUrls in shapes
 *                 replaced by relative paths ("images/img_N.png") into
 *                 the zip
 *   images/     — extracted image binaries
 *
 * Internal storage keeps images inline as base64 dataUrls; the zip format
 * extracts them so the file is portable and smaller on disk.
 *
 * **The envelope passes through whole.** The only thing this codec knows
 * about the notebook format is `shapes[].dataUrl`; every other field is
 * carried across untouched, exactly as the Rust twin (`hushnote.rs`)
 * does. That is not a nicety — it's the invariant this file exists to
 * hold. It has been broken twice: the first version packed only
 * `shapes`, so layers and flowEdges vanished on every sync and
 * cross-device notebooks looked empty; the fix named the three fields
 * that existed then, which quietly turned every field added later —
 * camera, background, bookmarks, splits, and the `proof` metadata that
 * makes a proofread notebook a proofread notebook — into data this codec
 * deleted on the next save. A whitelist here is a data-loss bug waiting
 * for the next feature. Both directions tolerate the legacy bare-array
 * form on input for back-compat.
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

/** Normalize parsed content to an envelope object, keeping every field
 *  the input carried. `format` / `version` / `shapes` are written first
 *  so the serialized form still opens with `{"format":"hushnote"` — the
 *  prefix Rust's `hushnote::pack` fast-path sniffs for. */
function toEnvelope(parsed) {
  if (Array.isArray(parsed)) {
    // Legacy bare Shape[] — no other fields existed.
    return { format: "hushnote", version: 1, shapes: parsed };
  }
  if (parsed && typeof parsed === "object") {
    const { format, version, shapes, ...rest } = parsed;
    return {
      format: "hushnote",
      version: 1,
      shapes: Array.isArray(shapes) ? shapes : [],
      ...rest,
    };
  }
  return { format: "hushnote", version: 1, shapes: [] };
}

/** Parse on-disk / in-memory content into an envelope. Malformed input
 *  degrades to an empty envelope rather than throwing — a notebook that
 *  opens empty can be recovered from a version snapshot; a load that
 *  throws strands the file. */
function parseEnvelope(jsonContent) {
  if (!jsonContent || !jsonContent.trim()) return toEnvelope(null);
  try {
    return toEnvelope(JSON.parse(jsonContent));
  } catch {
    return toEnvelope(null);
  }
}

/**
 * Pack a notebook's internal JSON content into a .hushnote zip (Uint8Array).
 * Accepts either the envelope format produced by `encodeNotebookContent` or
 * the legacy bare `Shape[]` array. Always emits the envelope inside the zip.
 * @param {string} jsonContent
 * @returns {Promise<Uint8Array>}
 */
export async function packNotebook(jsonContent) {
  const envelope = parseEnvelope(jsonContent);

  const zip = new JSZip();
  const imgFolder = zip.folder("images");
  let imgIndex = 0;

  envelope.shapes = envelope.shapes.map((s) => {
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
  const zip = await JSZip.loadAsync(zipData);
  const dataFile = zip.file("data.json");
  if (!dataFile) return JSON.stringify(toEnvelope(null));

  const envelope = parseEnvelope(await dataFile.async("string"));

  envelope.shapes = await Promise.all(envelope.shapes.map(async (s) => {
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

  return JSON.stringify(envelope);
}
