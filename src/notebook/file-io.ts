/** Save and open .note files (zip containing data.json + images/) */
import JSZip from "jszip";
import type { Shape, ImageShape, DrawShape, Layer } from "./types";
import { generateId } from "./utils";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readFile } from "@tauri-apps/plugin-fs";

export interface NoteFile {
  shapes: Shape[];
  /** Drawing layers. Top-first ordering (index 0 = top). Absent on
   *  legacy files written before the drawing feature landed; a
   *  default "Layer 1" is seeded on load if missing. */
  layers?: Layer[];
  /** Active drawing layer. Absent on legacy files; defaults to
   *  layers[0].id on load. */
  activeLayerId?: string;
}

/**
 * Prompt native save dialog, then write a .note zip file.
 * Images are extracted from dataUrl and stored in an images/ folder.
 */
export async function saveNoteFile(
  shapes: Shape[],
  layers?: Layer[],
  activeLayerId?: string,
): Promise<boolean> {
  const path = await save({
    title: "Save Note",
    defaultPath: "untitled.note",
    filters: [{ name: "Note", extensions: ["note"] }],
  });
  if (!path) return false;

  const zip = new JSZip();
  const imgFolder = zip.folder("images")!;
  let imgIndex = 0;

  const exportShapes = shapes.map((s) => {
    if (s.type === "image") {
      const imgShape = s as ImageShape;
      const ext = guessExtension(imgShape.dataUrl);
      const imgFilename = `img_${imgIndex++}${ext}`;
      const base64 = imgShape.dataUrl.split(",")[1];
      if (base64) imgFolder.file(imgFilename, base64, { base64: true });
      return { ...imgShape, dataUrl: `images/${imgFilename}` };
    }
    if (s.type === "draw") {
      // Drawings serialize the auto-color sentinel as the literal
      // string so theme-follow survives a round trip.
      return {
        ...s,
        color: s.colorIsAuto ? "auto" : s.color,
      };
    }
    return s;
  });

  const payload: NoteFile = { shapes: exportShapes as Shape[] };
  if (layers && layers.length) {
    payload.layers = layers;
    payload.activeLayerId = activeLayerId ?? layers[0].id;
  }

  zip.file("data.json", JSON.stringify(payload, null, 2));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await writeFile(path, bytes);
  return true;
}

/**
 * Prompt native open dialog, then read and parse a .note zip file.
 * Returns shapes + layers + activeLayerId, with v1→v2 migration for
 * any DrawShapes authored before the drawing feature landed.
 */
export async function openNoteFile(): Promise<{
  shapes: Shape[];
  layers: Layer[];
  activeLayerId: string;
} | null> {
  const path = await open({
    title: "Open Note",
    filters: [{ name: "Note", extensions: ["note", "zip"] }],
    multiple: false,
    directory: false,
  });
  if (!path) return null;

  const bytes = await readFile(path as string);
  const zip = await JSZip.loadAsync(bytes);
  const dataFile = zip.file("data.json");
  if (!dataFile) throw new Error("Invalid .note file: missing data.json");

  const json = await dataFile.async("string");
  const noteData: NoteFile = JSON.parse(json);

  // Seed layers if the file predates the drawing feature.
  const layers: Layer[] = Array.isArray(noteData.layers) && noteData.layers.length
    ? noteData.layers.map((l) => ({
        id: String(l.id),
        name: l.name || "Layer",
        locked: !!l.locked,
        hidden: !!l.hidden,
      }))
    : [{ id: generateId(), name: "Layer 1", locked: false, hidden: false }];
  const activeLayerId = noteData.activeLayerId && layers.some((l) => l.id === noteData.activeLayerId)
    ? noteData.activeLayerId
    : layers[0].id;

  // Top layer is where legacy / unlabelled shapes go. Matches the
  // intuition "new things go on top."
  const topLayerId = layers[0].id;

  const shapes = await Promise.all(noteData.shapes.map(async (s) => {
    // Image re-hydration: replace the images/<file> path with a data URL.
    if (s.type === "image") {
      const imgShape = s as ImageShape;
      const withLayer = imgShape.layerId ? imgShape : { ...imgShape, layerId: topLayerId };
      if (withLayer.dataUrl.startsWith("data:")) return withLayer;
      const imgFile = zip.file(withLayer.dataUrl);
      if (!imgFile) return withLayer;
      const data = await imgFile.async("base64");
      const ext = withLayer.dataUrl.split(".").pop() || "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : `image/${ext}`;
      return { ...withLayer, dataUrl: `data:${mime};base64,${data}` };
    }
    // Drawing migration: v1 had {points:[{x,y}], width, color}. v2 has
    // {points:[{x,y,pressure}], size, brushId, mode, layerId, colorIsAuto?}.
    if (s.type === "draw") return migrateDrawShape(s as DrawShape & LegacyDrawFields, topLayerId);
    // Text / drag-area: assign top layer if missing.
    if (!s.layerId) return { ...s, layerId: topLayerId };
    return s;
  }));

  return { shapes: shapes as Shape[], layers, activeLayerId };
}

// v1 fields that may still exist on disk (pre-drawing-feature saves).
type LegacyDrawFields = {
  width?: number;
  size?: number;
  brushId?: string;
  mode?: "normal" | "highlighter";
  layerId?: string;
};

/** Normalize any on-disk DrawShape into the v2 shape the engine wants.
 *  Idempotent — a v2 file passes through unchanged except `"auto"` →
 *  resolved `colorIsAuto: true` + real color. */
function migrateDrawShape(
  raw: DrawShape & LegacyDrawFields,
  defaultLayerId: string,
): DrawShape {
  const colorIsAuto = raw.color === "auto";
  const points = (raw.points || []).map((p: { x: number; y: number; pressure?: number }) => ({
    x: p.x,
    y: p.y,
    pressure: p.pressure ?? 0.5,
  }));
  const migrated: DrawShape = {
    id: raw.id,
    type: "draw",
    color: colorIsAuto ? "#000000" : raw.color,
    size: raw.size ?? raw.width ?? 4,
    brushId: raw.brushId ?? "brush-1",
    mode: raw.mode ?? "normal",
    layerId: raw.layerId ?? defaultLayerId,
    points,
    ...(raw.parentId ? { parentId: raw.parentId } : {}),
    ...(raw.groupId ? { groupId: raw.groupId } : {}),
    ...(raw.pocketed ? { pocketed: raw.pocketed } : {}),
    ...(colorIsAuto ? { colorIsAuto: true } : {}),
  };
  return migrated;
}

function guessExtension(dataUrl: string): string {
  if (dataUrl.includes("image/png")) return ".png";
  if (dataUrl.includes("image/jpeg") || dataUrl.includes("image/jpg")) return ".jpg";
  if (dataUrl.includes("image/webp")) return ".webp";
  if (dataUrl.includes("image/gif")) return ".gif";
  if (dataUrl.includes("image/svg")) return ".svg";
  return ".png";
}
