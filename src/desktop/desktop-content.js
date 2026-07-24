/**
 * Desktop content assembly — pure-ish helpers extracted from
 * desktop-view.js (700-line cap): merging the saved envelope with the
 * live file list into a shape array, thumbnail (re)hydration, the
 * fit-everything camera, and the shelf deep-search index.
 */

import { collectDesktopFiles } from "./desktop-files.js";
import { computeDesktopGrid, DESKTOP_GRID_GAP, loadFileContent } from "./desktop-thumbs.js";
import { normalizeDesktopStacks } from "./desktop-stacks.js";

export function refOf(entry) {
  return {
    key: entry.key, kind: entry.kind, fileId: entry.fileId, nodeId: entry.nodeId,
    name: entry.name, ...(entry.hasGutter ? { hasGutter: true } : {}),
  };
}

/** Re-arm a persisted fileRef shape with its (possibly regenerated)
 *  thumbnail at the thumbnail's natural size — thumbnails aren't
 *  resizable, so display dims always mirror the render. Stack
 *  membership survives (refOf carries no stackId — keep the saved one). */
export function hydrateShape(s, entry, thumb) {
  const keepStack = s.fileRef?.stackId ? { stackId: s.fileRef.stackId } : {};
  const out = { ...s, name: entry.name, fileRef: { ...refOf(entry), ...keepStack } };
  if (thumb) {
    out.dataUrl = thumb.dataUrl || thumb.url || "";
    if (thumb.frameless) out.fileRef.frameless = true;
    if (thumb.w > 0 && thumb.h > 0) {
      out.width = thumb.w;
      out.height = thumb.h;
    }
  }
  return out;
}

export function shapeBottom(s) {
  if (s.type === "draw" && Array.isArray(s.points)) {
    let m = 0;
    for (const p of s.points) if (p.y > m) m = p.y;
    return m;
  }
  const h = s.height || 0;
  return (s.position?.y || 0) + h + (s.fileRef ? 24 : 0);
}

export function newThumbShape(entry, rect, thumb) {
  const t = thumb || { w: 220, h: 280 };
  return {
    id: crypto.randomUUID(),
    type: "image",
    position: { x: rect?.x ?? 0, y: rect?.y ?? 0 },
    width: rect?.w ?? t.w,
    height: rect?.h ?? t.h,
    dataUrl: t.dataUrl || t.url || "",
    name: entry.name,
    color: "#000000",
    fileRef: { ...refOf(entry), ...(t.frameless ? { frameless: true } : {}) },
  };
}

/** Merge the saved envelope with the live file list: saved thumbnails
 *  keep their position / grouping, dead ones drop out, new files grid
 *  in below the existing content, user-added shapes (text, drag areas,
 *  strokes) pass through untouched. */
export function buildShapes(envelope, entries, thumbs) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const seen = new Set();
  const shapes = [];
  let maxY = 0;
  let hasSaved = false;

  for (const s of envelope?.shapes || []) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "image" && s.fileRef) {
      const entry = byKey.get(s.fileRef.key);
      if (!entry || seen.has(entry.key)) continue; // deleted file / duplicate
      seen.add(entry.key);
      shapes.push(hydrateShape(s, entry, thumbs.get(entry.key)));
    } else {
      shapes.push(s);
    }
    hasSaved = true;
    const b = shapeBottom(s);
    if (b > maxY) maxY = b;
  }

  const missing = entries.filter((e) => !seen.has(e.key));
  if (missing.length) {
    const startY = hasSaved ? maxY + DESKTOP_GRID_GAP : 0;
    const rects = computeDesktopGrid(missing, thumbs, startY);
    for (const entry of missing) {
      shapes.push(newThumbShape(entry, rects.get(entry.key), thumbs.get(entry.key)));
    }
  }
  return normalizeDesktopStacks(shapes);
}

/** Camera that fits every non-pocketed shape into `w × h` with padding
 *  (zoom capped at 1). Used on first open, Reset View, and as the
 *  fallback when no camera was persisted. */
export function fitCameraFor(shapes, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    if (s.pocketed) continue;
    const x = s.position?.x ?? 0, y = s.position?.y ?? 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (s.width || 0));
    maxY = Math.max(maxY, y + (s.height || 0) + 24);
  }
  if (!Number.isFinite(minX)) return { x: 60, y: 60, zoom: 1 };
  const pad = 60;
  const zoom = Math.max(0.1, Math.min(1,
    (w - pad * 2) / Math.max(1, maxX - minX),
    (h - pad * 2) / Math.max(1, maxY - minY)));
  return {
    x: (w - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: Math.max(20, (h - (maxY - minY) * zoom) / 2) - minY * zoom,
    zoom,
  };
}

/** Build the per-file search text the shape shelf reads through
 *  `window.__hushDesktopSearchText`: doc bodies, notebook text-shape
 *  contents, PDF metadata + bookmark names + cached Zotero annotation
 *  text. Fire-and-forget — the shelf reads `sink` live at query time,
 *  so entries land as they resolve. `isLive()` aborts a stale pass. */
export async function buildSearchIndex(state, entries, sink, isLive, collectOpts = {}) {
  for (const entry of entries) {
    if (!isLive()) return;
    let text = entry.name || "";
    try {
      if (entry.kind === "doc") {
        text += "\n" + (await loadFileContent(state, entry.fileId));
      } else if (entry.kind === "notebook") {
        const { extractSnapshotText } = await import("../sidebar/notebook-snapshot-preview.js");
        text += "\n" + extractSnapshotText(await loadFileContent(state, entry.fileId));
      } else if (entry.kind === "pdf") {
        const { getPdfMeta, getPdfBookmarks } = await import("../sync/pdf-sync.js");
        const meta = getPdfMeta(entry.fileId);
        const parts = [meta?.title, meta?.authors, meta?.year];
        for (const bm of getPdfBookmarks(entry.fileId)) parts.push(bm.name);
        if (meta?.zoteroAttKey) {
          const { getCachedAnnotations } = await import("../zotero-annotations.js");
          const annots = await getCachedAnnotations(meta.zoteroAttKey).catch(() => []);
          for (const a of annots) parts.push([a.text, a.comment].filter(Boolean).join(" "));
        }
        text += "\n" + parts.filter(Boolean).join("\n");
      } else if (entry.kind === "project") {
        const collected = collectDesktopFiles(state, entry.nodeId, collectOpts);
        text += "\n" + (collected?.entries || []).map((e) => e.name).join("\n");
      }
    } catch { /* best effort — the name alone still matches */ }
    if (!isLive()) return;
    sink.set(entry.key, text);
  }
}
