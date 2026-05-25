import { FONT_FAMILY, LINE_HEIGHT_RATIO, COLOR_PALETTE } from "./types";
import type { Bounds, Camera, DragAreaShape, ImageShape, Layer, Point, SelectionBox, Shape, TextShape } from "./types";
import type { CanvasTheme } from "./themes";
import { computePocketLayout, getShapeBounds, POCKET_ZONE_WIDTH, POCKET_TRAY_WIDTH } from "./utils";
import type { PocketEntry } from "./utils";
import { parseText } from "./markdown";
import { drawSelectionHighlight, drawGroupHighlight, drawSelectionBox, drawCropOverlay, drawEdgeDeleteButton, drawEdgeDeleteDot, drawReorderPreview, drawShadowHeaders } from "./renderer-selection";
import { drawBackground } from "./renderer-background";
import type { FlowchartLayer } from "./flowchart";

export interface RenderState {
  shapes: Shape[];
  selectedIds: Set<string>;
  camera: Camera;
  selectionBox: SelectionBox | null;
  creatingDragArea: { start: Point; end: Point } | null;
  editingShapeId: string | null;
  imageCache: Map<string, HTMLImageElement>;
  theme: CanvasTheme;
  croppingImageId: string | null;
  backgroundPattern: "grid" | "dot-grid" | "lined" | "isometric" | "blank";
  gridSpacing: number;
  gridOpacity: number;
  fontFamily: string;
  isDragging: boolean;
  // Proximity-based pocket reveal. 0 = tray hidden, 1 = cursor inside zone.
  pocketProximity?: number;
  // True while the drag cursor sits inside the pocket drop zone.
  pocketInZone?: boolean;
  leftInset: number; shadowHeaders?: { y: number; level: number; text: string }[];
  /** Layer list, top-first. Used to iterate shapes in layer order
   *  and skip shapes on hidden layers. Optional: falls back to
   *  single-pass iteration when absent (tests, legacy callers). */
  layers?: Layer[];
  /** Style override for the canvas background. Empty / unset falls
   *  back to `theme.canvasBackground`. */
  canvasBackgroundOverride?: string;
  /** Optional drawing-layer handle. When present the pocket / shelf
   *  thumbnail paths blit grouped-drawing regions directly from the
   *  done canvas instead of re-stamping strokes per-frame. */
  drawingLayer?: {
    blitWorldRegion(
      ctx: CanvasRenderingContext2D,
      worldBbox: { minX: number; minY: number; maxX: number; maxY: number },
    ): void;
  };
  /** Device pixel ratio. Injected by the caller (notes-canvas.ts reads
   *  `window.devicePixelRatio`) so this module stays free of global
   *  reads — it only needs to render. */
  dpr?: number;
  /** Optional flowchart layer. When present, arrows render between the
   *  drag-area pass and the text/image pass. */
  flowchart?: FlowchartLayer<Shape>;
  /** id of a shape currently outlined as a flowchart drop target. */
  flowDropTargetId?: string | null;
  /** id of a flowchart edge whose curve the cursor is hovering — the
   *  renderer paints a delete-X badge at the edge midpoint. */
  flowHoveredEdgeId?: string | null;
  /** Flag-name → hex colour map mirrored from Hush's `flagColors`
   *  setting. Used by the highlight painter so `==MISSING==` etc. take
   *  on the user's configured colour instead of the default yellow. */
  flagColors?: Record<string, string>;
  /** True while the drawing engine is mid-transform on its own bbox
   *  (pen-mode lasso grab → move / resize / rotate). The renderer
   *  suppresses the gray group highlight while this is true; the
   *  engine bbox is the only chrome on the canvas during the
   *  gesture. */
  strokeEngineDragging?: boolean;
  /** Reorder mode: active drag-area id (solid accent outline + swap-on-drop). */
  reorderDragAreaId?: string | null;
  /** Reorder hover preview: boundary rects + baked clones at swap destinations. */
  reorderPreview?: { ghostA: Bounds; ghostB: Bounds; draggedShapes: Shape[]; targetShapes: Shape[] } | null;
  /** Hush's iPad Touch-mode flag, mirrored into the render state by
   *  notes-canvas.ts. The flowchart edge-delete dot is a touch-only
   *  affordance (mouse hover already reveals the same X) so we hide
   *  the dot when the user isn't on a touch device — the X still
   *  shows up via the existing pointermove path. */
  touchMode?: boolean;
}

export function render(canvas: HTMLCanvasElement, state: RenderState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = state.dpr ?? 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const { camera, shapes, selectedIds, selectionBox, creatingDragArea, editingShapeId, imageCache, theme, backgroundPattern, gridSpacing, gridOpacity, canvasBackgroundOverride } = state;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = canvasBackgroundOverride || theme.canvasBackground;
  ctx.fillRect(0, 0, w, h);

  if (backgroundPattern !== "blank" && gridOpacity > 0) {
    // Use foreground color at scaled opacity (100% slider = 80% alpha of foreground)
    drawBackground(ctx, camera, w, h, theme.foreground, backgroundPattern, gridSpacing, gridOpacity * 0.8);
  }

  // Compute pocket layout once for this frame. While the user is dragging
  // into the pocket zone, treat the selected shapes as already pocketed so
  // they render in pocket-card style mid-drag.
  const effectiveShapes = state.pocketInZone && selectedIds.size > 0
    ? shapes.map((s) => selectedIds.has(s.id) ? { ...s, pocketed: true } : s)
    : shapes;
  const pocketLayout = computePocketLayout(effectiveShapes, w, state.fontFamily);
  const pocketedIds = pocketLayout.pocketedIds;

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);
  // Build layer order (bottom-first for paint order). If no layers
  // were provided, fall back to a single synthetic layer that contains
  // every shape — same visual result as the pre-layers behavior.
  const layerOrder: { id: string; hidden: boolean }[] = state.layers && state.layers.length
    ? [...state.layers].reverse().map((l) => ({ id: l.id, hidden: l.hidden }))
    : [{ id: "__single__", hidden: false }];
  const shapesByLayer = new Map<string, Shape[]>();
  for (const l of layerOrder) shapesByLayer.set(l.id, []);
  for (const s of shapes) {
    const bucketId = state.layers && state.layers.length ? (s.layerId || layerOrder[layerOrder.length - 1].id) : "__single__";
    const bucket = shapesByLayer.get(bucketId) || shapesByLayer.get(layerOrder[layerOrder.length - 1].id);
    if (bucket) bucket.push(s);
  }

  // Two-pass layered paint: drag-areas (bottom-first), flowchart arrows,
  // then text/image shapes. Drawings handled by the drawing-layer canvas.
  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area" && !pocketedIds.has(shape.id)) {
        drawDragArea(ctx, shape, state.reorderDragAreaId === shape.id, theme.accent, theme);
      }
    }
  }

  // Flowchart arrows render under text shapes; skip pocketed shapes.
  if (state.flowchart) {
    state.flowchart.setArrowColor(theme.foreground);
    state.flowchart.draw(ctx, shapes.filter((s) => !pocketedIds.has(s.id)));
  }

  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    for (const shape of layerShapes) {
      if (shape.type === "drag-area") continue;
      if (shape.id === editingShapeId) continue;
      if (pocketedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue; // drawing layer owns strokes
      if (shape.type === "text") drawTextShape(ctx, shape, theme, state.fontFamily, false, state.flagColors);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, shape.id === state.croppingImageId);
    }
  }

  // Drop-target outline: dashed rectangle around the shape that would be
  // connected if the user released the drag right now.
  if (state.flowDropTargetId) {
    const target = shapes.find((s) => s.id === state.flowDropTargetId);
    if (target && !pocketedIds.has(target.id)) {
      const tb = getShapeBounds(target, state.fontFamily);
      const pad = 8;
      ctx.save();
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / camera.zoom;
      ctx.setLineDash([8 / camera.zoom, 4 / camera.zoom]);
      ctx.strokeRect(
        tb.minX - pad,
        tb.minY - pad,
        tb.maxX - tb.minX + pad * 2,
        tb.maxY - tb.minY + pad * 2,
      );
      ctx.restore();
    }
  }

  if (creatingDragArea) {
    const { start, end } = creatingDragArea;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const rw = Math.abs(end.x - start.x);
    const rh = Math.abs(end.y - start.y);
    ctx.save();
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.fillStyle = "rgba(107, 114, 128, 0.08)";
    ctx.beginPath();
    roundRect(ctx, x, y, rw, rh, 12);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (selectedIds.size > 0) {
    // Suppress group highlight while drawing engine is mid-transform.
    const skipGroupHighlight = !!state.strokeEngineDragging;
    // Group bounding boxes first (behind individual highlights)
    const groupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    if (!skipGroupHighlight) {
      for (const shape of shapes) {
        if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id) || !shape.groupId) continue;
        const b = getShapeBounds(shape, state.fontFamily);
        const existing = groupBounds.get(shape.groupId);
        if (existing) {
          existing.minX = Math.min(existing.minX, b.minX);
          existing.minY = Math.min(existing.minY, b.minY);
          existing.maxX = Math.max(existing.maxX, b.maxX);
          existing.maxY = Math.max(existing.maxY, b.maxY);
        } else {
          groupBounds.set(shape.groupId, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
        }
      }
      for (const bounds of groupBounds.values()) {
        drawGroupHighlight(ctx, bounds, camera.zoom, theme.accent);
      }
    }

    // Stroke selections drawn by the engine's SVG overlay; omitted here.
    for (const shape of shapes) {
      if (!selectedIds.has(shape.id) || pocketedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue; // handled above (group or loose-stroke bbox)
      if (shape.id === state.croppingImageId && shape.type === "image") {
        drawCropOverlay(ctx, shape, camera.zoom);
      } else {
        drawSelectionHighlight(ctx, shape, camera.zoom, theme.accent, state.fontFamily);
      }
    }

    // Reorder-mode ghost preview at swap destinations.
    if (state.reorderPreview) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * 0.55;
      for (const s of state.reorderPreview.draggedShapes) drawGhostShape(ctx, s, state, theme);
      for (const s of state.reorderPreview.targetShapes) drawGhostShape(ctx, s, state, theme);
      ctx.globalAlpha = prev;
      drawReorderPreview(ctx, state.reorderPreview.ghostA, state.reorderPreview.ghostB, theme.accent, camera.zoom);
    }
  }

  ctx.restore();
  if (state.shadowHeaders?.length) drawShadowHeaders(ctx, state.shadowHeaders, theme, state.fontFamily, camera.y, w, h);

  // Per-edge delete affordances — all drawn in screen space so they stay
  // a fixed size regardless of zoom. Touch users tap the dot to reveal
  // the X (which they tap again to delete); mouse users get the same X
  // via hover (handlePointerMove sets flowHoveredEdgeId). Click handling
  // lives in DrawingState.handlePointerDown (canvas-space hit-test
  // against getEdgeMidpoint with a 12 px-screen-radius / zoom threshold).
  if (state.flowchart) {
    const hoveredId = state.flowHoveredEdgeId ?? null;
    const touch = !!state.touchMode;
    for (const e of state.flowchart.edges) {
      const mid = state.flowchart.getEdgeMidpoint(e.id, shapes);
      if (!mid) continue;
      const sx = mid.x * camera.zoom + camera.x;
      const sy = mid.y * camera.zoom + camera.y;
      // Hovered edges always paint the X (mouse hover or touch tap).
      // The persistent dot is only a touch affordance — mouse users
      // discover the X via hover so the dot just adds visual noise.
      if (e.id === hoveredId) drawEdgeDeleteButton(ctx, sx, sy, theme);
      else if (touch) drawEdgeDeleteDot(ctx, sx, sy, theme);
    }
  }

  // Draw pocket tray on left edge, offset by sidebar inset.
  // Proximity-based glow: tray fades in as the drag cursor approaches the
  // pocket zone. Fully visible inside the zone.
  const hasPocketed = pocketLayout.entries.length > 0;
  const leftInset = state.leftInset || 0;
  const proximity = state.pocketProximity ?? (state.isDragging ? 1 : 0);
  if (hasPocketed || proximity > 0) {
    drawPocketTray(ctx, w, h, state.isDragging, hasPocketed, leftInset, proximity);
  }

  // Draw pocketed shapes at fixed screen positions, offset by sidebar inset.
  // Also includes the in-flight selected shapes when the cursor is in the
  // zone (via effectiveShapes above).
  if (pocketLayout.entries.length > 0) {
    ctx.save();
    ctx.translate(leftInset, 0);
    drawPocketEntries(ctx, pocketLayout.entries, selectedIds, theme, state.fontFamily, imageCache, state.drawingLayer, state.flagColors);
    ctx.restore();
  }

  if (selectionBox) drawSelectionBox(ctx, selectionBox, camera);
}

// Reorder-preview ghost — paints a clone via main-pass draw fns; strokes fall back to a polyline.
function drawGhostShape(ctx: CanvasRenderingContext2D, s: Shape, state: RenderState, theme: CanvasTheme): void {
  if (s.type === "text") drawTextShape(ctx, s, theme, state.fontFamily, false, state.flagColors);
  else if (s.type === "image") drawImageShape(ctx, s, state.imageCache, false);
  else if (s.type === "drag-area") drawDragArea(ctx, s);
  else if (s.type === "draw") drawStroke(ctx, s.points, s.color || theme.foreground, 3);
}

// === Draw helpers (pure Canvas 2D — no framework dependencies) ===

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

export function drawDragArea(ctx: CanvasRenderingContext2D, shape: DragAreaShape, reorderActive = false, reorderAccent?: string, theme?: CanvasTheme) {
  const { position, width, height, strokeColor, backgroundColor, borderRadius } = shape;
  ctx.save();
  ctx.strokeStyle = reorderActive ? (reorderAccent || strokeColor) : strokeColor;
  ctx.lineWidth = reorderActive ? 3 : 2;
  if (!reorderActive) ctx.setLineDash([8, 4]);
  ctx.fillStyle = backgroundColor;
  ctx.beginPath();
  roundRect(ctx, position.x, position.y, width, height, borderRadius);
  ctx.fill(); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  if (shape.borderColor) {
    const borderHex = COLOR_PALETTE[shape.borderColor] || shape.borderColor;
    ctx.save();
    ctx.strokeStyle = theme ? resolveThemeColor(borderHex, theme) : borderHex;
    ctx.lineWidth = shape.borderWidth || 1;
    ctx.beginPath();
    roundRect(ctx, position.x, position.y, width, height, borderRadius);
    ctx.stroke(); ctx.restore();
  }
}

export function drawStroke(ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** Resolve sentinel color values ("auto" / "heading") through the
 *  active theme. Regular hex/palette values pass through unchanged. */
function resolveThemeColor(raw: string, theme: CanvasTheme): string {
  return raw === "auto" ? theme.foreground : raw === "heading" ? theme.headingColor : raw;
}

/** Default highlight tint matches the markdown editor's `==…==`
 *  background — keeps Docs and Notebooks visually consistent. */
const DEFAULT_HIGHLIGHT_BG = "rgba(255, 208, 0, 0.3)";

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length !== 6) return DEFAULT_HIGHLIGHT_BG;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Resolve a highlight run's background tint: flag colour when the
 *  parser tagged the run with a known flag, otherwise the shared default. */
export function resolveHighlightBg(flagName: string | undefined, flagColors: Record<string, string> | undefined): string {
  if (flagName && flagColors) {
    const c = flagColors[flagName];
    if (c) return hexToRgba(c, 0.3);
  }
  return DEFAULT_HIGHLIGHT_BG;
}

export function drawTextShape(ctx: CanvasRenderingContext2D, shape: TextShape, theme: CanvasTheme, fontFamily: string, omitGlyphs = false, flagColors?: Record<string, string>) {
  const baseFontSize = shape.fontSize;
  const ff = `${fontFamily}, ${FONT_FAMILY}`;

  // Measure function using the render context for accurate width
  const measure = (text: string, fontSize: number): number => {
    ctx.font = `${fontSize}px ${ff}`;
    return ctx.measureText(text).width;
  };

  // Parse markdown into styled lines
  const parsedLines = parseText(
    shape.text,
    shape.width && shape.width > 0 ? shape.width : undefined,
    baseFontSize,
    measure,
  );

  // Resolve text color: use theme foreground if shape uses default black or "auto"
  const isAutoColor = shape.color === "#000000" || shape.color === "auto";
  const isHeadingColor = shape.color === "heading";
  const textColor = isAutoColor ? theme.foreground : isHeadingColor ? theme.headingColor : shape.color;
  const headingColor = isAutoColor ? theme.headingColor : isHeadingColor ? theme.headingColor : shape.color;

  // Draw background and/or border (10px pad + 5px radius when bordered)
  if (shape.backgroundColor || shape.borderColor) {
    const bounds = getShapeBounds(shape, fontFamily);
    const pad = shape.borderColor ? 10 : 4, r = shape.borderColor ? 5 : 0;
    const bx = bounds.minX - pad, by = bounds.minY - pad;
    const bw = bounds.maxX - bounds.minX + pad * 2, bh = bounds.maxY - bounds.minY + pad * 2;
    ctx.save();
    if (shape.backgroundColor) {
      ctx.fillStyle = resolveThemeColor(COLOR_PALETTE[shape.backgroundColor] || shape.backgroundColor, theme);
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); (ctx as any).roundRect(bx, by, bw, bh, r); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (shape.borderColor) {
      ctx.strokeStyle = resolveThemeColor(COLOR_PALETTE[shape.borderColor] || shape.borderColor, theme);
      ctx.lineWidth = shape.borderWidth || 2;
      ctx.beginPath(); (ctx as any).roundRect(bx, by, bw, bh, r); ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.textBaseline = "top";

  // Per-line indentation for blockquotes and tasks. A blockquote adds
  // a fixed gutter that hosts the left rule; a task line adds a
  // checkbox-width gutter. Both can stack ("> - [ ] item"), but we
  // render whichever is more prominent first.
  const BLOCKQUOTE_GUTTER = baseFontSize * 0.9;     // padding-left
  const BLOCKQUOTE_BORDER = 2;                       // px width of the rule
  const CHECKBOX_SIZE = baseFontSize * 0.85;
  const CHECKBOX_GAP = baseFontSize * 0.4;

  let y = shape.position.y;
  for (const line of parsedLines) {
    const lineScale = line.sizeScale;
    const lineFontSize = baseFontSize * lineScale;
    const lineH = lineFontSize * LINE_HEIGHT_RATIO;
    const isHeading = lineScale > 1;
    let x = shape.position.x;

    if (line.blockquote) {
      // 50% opacity left rule using the text colour. Hex strings
      // become rgba via a quick parse; non-hex falls back to a
      // neutral colour-mix-equivalent.
      ctx.save();
      ctx.fillStyle = textColor;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, y, BLOCKQUOTE_BORDER, lineH);
      ctx.globalAlpha = 1;
      ctx.restore();
      x += BLOCKQUOTE_GUTTER;
    }

    if (line.task !== undefined) {
      // Reserve a checkbox-sized gutter on every task-related line
      // (first or continuation). Only the first line draws the box.
      if (line.task) {
        const cy = y + (lineFontSize - CHECKBOX_SIZE) / 2;
        ctx.save();
        ctx.strokeStyle = textColor;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;
        ctx.strokeRect(x, cy, CHECKBOX_SIZE, CHECKBOX_SIZE);
        if (line.taskChecked) {
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = textColor;
          // Tick: two strokes meeting at a 45° corner.
          ctx.beginPath();
          ctx.moveTo(x + CHECKBOX_SIZE * 0.22, cy + CHECKBOX_SIZE * 0.55);
          ctx.lineTo(x + CHECKBOX_SIZE * 0.42, cy + CHECKBOX_SIZE * 0.78);
          ctx.lineTo(x + CHECKBOX_SIZE * 0.82, cy + CHECKBOX_SIZE * 0.25);
          ctx.lineWidth = 2;
          ctx.strokeStyle = textColor;
          ctx.stroke();
        }
        ctx.restore();
      }
      x += CHECKBOX_SIZE + CHECKBOX_GAP;
    }

    if (line.list) {
      // Nested-list step + a bullet/number-width gutter so wrapped lines
      // hang-indent under the marker. The marker is only drawn on the
      // first wrapped line; continuation lines pass `listMarker = ""`.
      const LIST_DEPTH_STEP = baseFontSize * 1.2;
      const LIST_MARKER_GUTTER = baseFontSize * 1.5;
      x += LIST_DEPTH_STEP * (line.listDepth || 0);
      if (line.listMarker) {
        ctx.save();
        ctx.fillStyle = textColor;
        ctx.globalAlpha = 0.75;
        ctx.font = `normal normal ${lineFontSize}px ${ff}`;
        if (!omitGlyphs) ctx.fillText(line.listMarker, x, y);
        ctx.restore();
      }
      x += LIST_MARKER_GUTTER;
    }

    for (const run of line.runs) {
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      const fontSize = baseFontSize * run.sizeScale;
      ctx.font = `${style} ${weight} ${fontSize}px ${ff}`;
      if (run.highlight) {
        ctx.save();
        ctx.fillStyle = resolveHighlightBg(run.highlightFlag, flagColors);
        ctx.fillRect(x, y, ctx.measureText(run.text).width, fontSize + 2);
        ctx.restore();
      }
      const isLinkish = !!(run.link || run.wikilink);
      ctx.fillStyle = isLinkish ? theme.accent : (isHeading ? headingColor : textColor);
      // PDF export overlays vector text on top, so it asks us to skip the rasterized glyphs.
      if (!omitGlyphs) ctx.fillText(run.text, x, y);
      const runW = ctx.measureText(run.text).width;
      if (isLinkish) {
        ctx.beginPath();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1;
        if (run.wikilink) ctx.setLineDash([3, 2]); // dashed to distinguish from `[…](url)`
        ctx.moveTo(x, y + fontSize + 1);
        ctx.lineTo(x + runW, y + fontSize + 1);
        ctx.stroke();
        if (run.wikilink) ctx.setLineDash([]);
      }
      x += runW;
    }

    y += lineH;
  }
  ctx.restore();
}

export function drawImageShape(ctx: CanvasRenderingContext2D, shape: ImageShape, imageCache: Map<string, HTMLImageElement>, isCropping?: boolean) {
  const img = imageCache.get(shape.id);
  if (img && img.complete) {
    const c = shape.crop || { x: 0, y: 0, w: 1, h: 1 };
    if (isCropping) {
      // Show the full image at 50% opacity behind the crop
      const fullW = shape.width / c.w, fullH = shape.height / c.h;
      const fullX = shape.position.x - c.x * fullW, fullY = shape.position.y - c.y * fullH;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(img, fullX, fullY, fullW, fullH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    const sx = c.x * img.naturalWidth, sy = c.y * img.naturalHeight;
    const sw = c.w * img.naturalWidth, sh = c.h * img.naturalHeight;
    ctx.drawImage(img, sx, sy, sw, sh, shape.position.x, shape.position.y, shape.width, shape.height);
  } else {
    ctx.save();
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 1;
    ctx.strokeRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.fillStyle = "#9ca3af";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shape.name || "Image", shape.position.x + shape.width / 2, shape.position.y + shape.height / 2);
    ctx.restore();
  }
}

const POCKET_BLUE = "rgba(66, 153, 225, 0.18)";
const POCKET_BLUE_HIGHLIGHT = "rgba(66, 153, 225, 0.30)";

// Bounded tray, mirrored from the right-side shelf style.
function drawPocketTray(
  ctx: CanvasRenderingContext2D, _w: number, h: number,
  isDragging: boolean, _hasPocketed: boolean, leftInset = 0, proximity = 0,
) {
  ctx.save();
  const cs = getComputedStyle(document.documentElement);
  const trayBg = (cs.getPropertyValue("--theme-bg") || cs.getPropertyValue("--bg") || "#f4f4f5").trim() || "#f4f4f5";
  const borderColor = (cs.getPropertyValue("--panel-border") || "rgba(128,128,128,0.3)").trim() || "rgba(128,128,128,0.3)";
  const x = leftInset, y = 20, w = POCKET_TRAY_WIDTH, hh = Math.max(0, h - 40), r = 12;
  ctx.globalAlpha = isDragging ? Math.min(1, 0.85 * proximity + 0.15) : 1;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + hh - r); ctx.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh);
  ctx.lineTo(x, y + hh); ctx.closePath();
  ctx.fillStyle = trayBg; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = borderColor; ctx.stroke();
  if (isDragging) {
    ctx.globalAlpha = 0.5 * proximity;
    ctx.fillStyle = POCKET_BLUE_HIGHLIGHT;
    ctx.fillRect(x + w - 4, y + 1, 4, hh - 2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawPocketEntries(
  ctx: CanvasRenderingContext2D, entries: PocketEntry[], selectedIds: Set<string>,
  theme: CanvasTheme, fontFamily: string, imageCache: Map<string, HTMLImageElement>,
  drawingLayer?: RenderState["drawingLayer"],
  flagColors?: Record<string, string>,
) {
  for (const entry of entries) {
    const b = entry.screenBounds;
    const pad = 6;

    // Light blue card background
    ctx.save();
    ctx.fillStyle = POCKET_BLUE;
    ctx.shadowColor = "rgba(0,0,0,0.08)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    roundRect(ctx, b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2, 6);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(66, 153, 225, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Draw shapes with offset + scale transform
    ctx.save();
    ctx.translate(entry.offsetX, entry.offsetY);
    if (entry.scale !== 1) ctx.scale(entry.scale, entry.scale);
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") drawDragArea(ctx, shape);
    }
    for (const shape of entry.shapes) {
      if (shape.type === "drag-area") continue;
      if (shape.type === "text") drawTextShape(ctx, shape, theme, fontFamily, false, flagColors);
      else if (shape.type === "image") drawImageShape(ctx, shape, imageCache, false);
      // DrawShapes are handled in one pass below — we blit the whole
      // group's world bbox from the done canvas at once instead of
      // re-stamping strokes per-frame.
    }
    // Grouped drawings: one drawImage from the drawing layer's done
    // canvas per entry. Cheap (single blit) and pixel-accurate.
    if (drawingLayer) {
      const drawShapesInEntry: Shape[] = [];
      for (const shape of entry.shapes) {
        if (shape.type === "draw") drawShapesInEntry.push(shape);
      }
      if (drawShapesInEntry.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of drawShapesInEntry) {
          const b = getShapeBounds(s, fontFamily);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
        }
        drawingLayer.blitWorldRegion(ctx, { minX, minY, maxX, maxY });
      }
    }
    // Selection highlights for pocketed shapes. Accumulate group
    // bounds first (for grouped selections), then draw per-shape
    // highlights for anything not in a selected-group — DrawShapes
    // in a selected group don't get per-stroke boxes on top of the
    // group bbox (matches main-canvas behavior).
    const pocketGroupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const shape of entry.shapes) {
      if (!selectedIds.has(shape.id) || !shape.groupId) continue;
      const b = getShapeBounds(shape, fontFamily);
      const existing = pocketGroupBounds.get(shape.groupId);
      if (existing) {
        existing.minX = Math.min(existing.minX, b.minX);
        existing.minY = Math.min(existing.minY, b.minY);
        existing.maxX = Math.max(existing.maxX, b.maxX);
        existing.maxY = Math.max(existing.maxY, b.maxY);
      } else {
        pocketGroupBounds.set(shape.groupId, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      }
    }
    for (const bounds of pocketGroupBounds.values()) {
      drawGroupHighlight(ctx, bounds, 1 / entry.scale, theme.accent);
    }
    for (const shape of entry.shapes) {
      if (!selectedIds.has(shape.id)) continue;
      if (shape.type === "draw" && shape.groupId && pocketGroupBounds.has(shape.groupId)) continue;
      drawSelectionHighlight(ctx, shape, 1 / entry.scale, theme.accent, fontFamily);
    }
    ctx.restore();
  }
}

