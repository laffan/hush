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
 *   fileType: "document" | "notebook" | "pdf" | "project",
 *   width: number,
 *   open: boolean,
 *   scrollY: number,          // doc scroll or camera.y for notebooks
 *   cameraState: object|null, // notebook camera { x, y, zoom }
 *   spineColor: string|null,
 * }
 */

const CURRENT_VERSION = 1;

export function encodeStackContent(items, scrollX, { scrollY = 0, scrollDirection = "horizontal" } = {}) {
  return JSON.stringify({
    format: "hushstack",
    version: CURRENT_VERSION,
    scrollDirection,
    items: items.map((item) => ({
      id: item.id,
      fileId: item.fileId,
      fileType: item.fileType,
      name: item.name || null,
      width: item.width ?? 500,
      height: item.height ?? 600,
      open: item.open !== false,
      scrollY: item.scrollY ?? 0,
      cameraState: item.cameraState ?? null,
      pdfZoom: item.pdfZoom ?? null,
      spineColor: item.spineColor ?? null,
    })),
    scrollX: scrollX ?? 0,
    scrollY: scrollY ?? 0,
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
          // Encoded since the format existed and never read back, so every
          // load → save round trip silently cleared every column's name
          // (stack-spine.js and stack-list-view.js both prefer it over the
          // tree node's). One save after opening a stack was enough.
          name: item.name ?? null,
          width: item.width ?? 500,
          height: item.height ?? 600,
          open: item.open !== false,
          scrollY: item.scrollY ?? 0,
          cameraState: item.cameraState ?? null,
          pdfZoom: item.pdfZoom ?? null,
          spineColor: item.spineColor ?? null,
        })),
        scrollX: data.scrollX ?? 0,
        scrollY: data.scrollY ?? 0,
        scrollDirection: data.scrollDirection || "horizontal",
      };
    }
  } catch (_) {}
  return { items: [], scrollX: 0 };
}
