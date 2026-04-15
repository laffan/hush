/**
 * Notebook sync serialization — pack/unpack .hushnote zip files.
 *
 * .hushnote is a ZIP archive containing:
 *   data.json   — shapes array (image dataUrls replaced with relative paths)
 *   images/     — extracted image files
 *
 * This mirrors the .note format from tauri-drawing (file-io.ts).
 * Internal storage keeps images as inline base64 dataUrls; the zip format
 * extracts them so the file is portable and smaller on disk.
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

/**
 * Pack a notebook's internal JSON content into a .hushnote zip (Uint8Array).
 * @param {string} jsonContent — the internal JSON string (shapes array with inline base64 images)
 * @returns {Promise<Uint8Array>}
 */
export async function packNotebook(jsonContent) {
  let shapes;
  try {
    shapes = JSON.parse(jsonContent);
  } catch (_) {
    shapes = [];
  }
  if (!Array.isArray(shapes)) shapes = [];

  const zip = new JSZip();
  const imgFolder = zip.folder("images");
  let imgIndex = 0;

  const exportShapes = shapes.map((s) => {
    if (s.type !== "image") return s;
    const ext = guessExtension(s.dataUrl || "");
    const imgFilename = `img_${imgIndex++}${ext}`;
    const base64 = (s.dataUrl || "").split(",")[1];
    if (base64) imgFolder.file(imgFilename, base64, { base64: true });
    return { ...s, dataUrl: `images/${imgFilename}` };
  });

  zip.file("data.json", JSON.stringify({ shapes: exportShapes }, null, 2));
  return await zip.generateAsync({ type: "uint8array" });
}

/**
 * Unpack a .hushnote zip into the internal JSON content string.
 * Re-inlines images from the images/ folder as base64 dataUrls.
 * @param {ArrayBuffer|Uint8Array} zipData — the raw zip bytes
 * @returns {Promise<string>} — JSON string of shapes array
 */
export async function unpackNotebook(zipData) {
  const zip = await JSZip.loadAsync(zipData);
  const dataFile = zip.file("data.json");
  if (!dataFile) return "[]";

  const json = await dataFile.async("string");
  let noteData;
  try {
    noteData = JSON.parse(json);
  } catch (_) {
    return "[]";
  }

  const shapes = noteData.shapes || [];

  const result = await Promise.all(shapes.map(async (s) => {
    if (s.type !== "image") return s;
    if (s.dataUrl && s.dataUrl.startsWith("data:")) return s;
    const imgFile = zip.file(s.dataUrl);
    if (!imgFile) return s;
    const data = await imgFile.async("base64");
    const ext = (s.dataUrl || "").split(".").pop() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp" : `image/${ext}`;
    return { ...s, dataUrl: `data:${mime};base64,${data}` };
  }));

  return JSON.stringify(result);
}
