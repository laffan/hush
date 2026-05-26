/**
 * Stack content format — encode/decode for the .hushstack JSON envelope.
 *
 * Envelope shape:
 * {
 *   format: "hushstack",
 *   version: 1,
 *   items: StackItem[],
 *   scrollX: number,
 * }
 *
 * Each StackItem:
 * {
 *   id: string,
 *   fileId: string,
 *   fileType: "document" | "notebook" | "pdf",
 *   width: number,
 *   open: boolean,
 *   scrollY: number,          // doc scroll or camera.y for notebooks
 *   cameraState: object|null, // notebook camera { x, y, zoom }
 *   spineColor: string|null,
 * }
 */

const CURRENT_VERSION = 1;

export function encodeStackContent(items, scrollX) {
  return JSON.stringify({
    format: "hushstack",
    version: CURRENT_VERSION,
    items: items.map((item) => ({
      id: item.id,
      fileId: item.fileId,
      fileType: item.fileType,
      width: item.width ?? 500,
      open: item.open !== false,
      scrollY: item.scrollY ?? 0,
      cameraState: item.cameraState ?? null,
      pdfZoom: item.pdfZoom ?? null,
      spineColor: item.spineColor ?? null,
    })),
    scrollX: scrollX ?? 0,
  });
}

export function decodeStackContent(raw) {
  if (!raw || typeof raw !== "string") {
    return { items: [], scrollX: 0 };
  }
  try {
    const data = JSON.parse(raw);
    if (data.format === "hushstack" && Array.isArray(data.items)) {
      const safe = data.items.filter((item) => item.fileType !== "stack");
      return {
        items: safe.map((item) => ({
          id: item.id || crypto.randomUUID(),
          fileId: item.fileId,
          fileType: item.fileType || "document",
          width: item.width ?? 500,
          open: item.open !== false,
          scrollY: item.scrollY ?? 0,
          cameraState: item.cameraState ?? null,
          pdfZoom: item.pdfZoom ?? null,
          spineColor: item.spineColor ?? null,
        })),
        scrollX: data.scrollX ?? 0,
      };
    }
  } catch (_) {}
  return { items: [], scrollX: 0 };
}
