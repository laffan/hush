import { FONT_FAMILY, LINE_HEIGHT_RATIO, COLOR_PALETTE } from "./types";
import type { Bounds, Camera, DragAreaShape, ImageShape, Layer, Point, SelectionBox, Shape, TextShape } from "./types";
import type { CanvasTheme } from "./themes";
import { canvasToScreen, computePocketLayout, getShapeBounds, POCKET_ZONE_WIDTH, POCKET_TRAY_WIDTH } from "./utils";
import type { PocketEntry } from "./utils";
import { parseText } from "./markdown";
import { drawSelectionHighlight, drawGroupHighlight, drawSelectionBox, drawCropOverlay, drawEdgeDeleteButton, drawEdgeDeleteDot, drawReorderPreview, drawShadowHeaders } from "./renderer-selection";
import { drawBackground, drawBackgroundImage } from "./renderer-background";
import type { BackgroundImageConfig } from "./renderer-background";
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
  /** True while this canvas is acting as a doc gutter. Draws the 2px red
   *  orientation rule (panning with the canvas, full height) and shifts the
   *  shadow headers inboard of it. */
  gutter?: boolean;
  /** Layer list, top-first. Used to iterate shapes in layer order
   *  and skip shapes on hidden layers. Optional: falls back to
   *  single-pass iteration when absent (tests, legacy callers). */
  layers?: Layer[];
  /** Style override for the canvas background. Empty / unset falls
   *  back to `theme.canvasBackground`. */
  canvasBackgroundOverride?: string;
  /** Desktop only: the doc-outline heading row under the pointer, in
   *  the thumbnail's shape-local coords. Drawn as a hover underline. */
  desktopOutlineHover?: { shapeId: string; x: number; y: number; w: number; h: number } | null;
  /** Desktop only: a file's own file-level stickies, drawn as mini notes
   *  along the bottom of its thumbnail. Read per frame (not baked into
   *  the thumbnail image) so edits show without a regenerate. */
  fileStickies?: (kind: string, fileId: string) => { text: string }[];
  /** Desktop "Thumbnail labels" option. Gates the persistent caption a
   *  nested project's thumbnail carries (hover labels are DOM and gate
   *  themselves). Unset counts as on. */
  showFileLabels?: boolean;
  /** Desktop-pinned stickies to paint onto this canvas, in world coords.
   *  The full-window Desktop shows these as live DOM notes in its own
   *  layer, so it leaves this unset; a Desktop *pane* has no such layer
   *  (the notes are singletons bound to the open takeover) and paints
   *  them instead — read-only, matching the pane's reading-half role. */
  desktopStickies?: { text: string; wx: number; wy: number; w: number; h: number }[] | null;
  /** Active Hush style's background-image config, or null. Drawn over the
   *  solid fill and beneath the grid pattern. */
  backgroundImage?: BackgroundImageConfig | null;
  /** Called when a background image finishes loading so the caller can
   *  request another frame (the first draw returns before decode). */
  onBgImageLoad?: () => void;
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
  /** Opacity the flowchart arrows paint at (0–1, default 1). Desktops
   *  render their derived document-order arrows at 40 %. */
  flowArrowAlpha?: number;
  /** Stroke width + arrowhead size for the flowchart arrows, in canvas
   *  units, and the stroke's line cap. Omitted leaves the layer's own
   *  defaults (1.5 / 11 / round); the Desktop's document-order chain
   *  runs far heavier, and butt caps keep the thick translucent stroke
   *  from lapping over the arrowhead it ends against. */
  flowArrowWidth?: number;
  flowArrowHeadSize?: number;
  flowArrowLineCap?: CanvasLineCap;
  /** True when the edges are derived rather than user-drawn (Desktops).
   *  Suppresses the per-edge delete dot / X — those edges mirror the
   *  project's document order and aren't the user's to remove. */
  flowEdgesLocked?: boolean;
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

/** Shape ids whose paint has already thrown and been reported. The
 *  render loop re-runs at frame rate, so without this one bad shape
 *  would bury the console under identical stack traces. */
const reportedPaintFailures = new Set<string>();

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

  // Style background image sits above the solid fill, beneath the grid.
  drawBackgroundImage(ctx, state.backgroundImage, w, h, state.onBgImageLoad || (() => {}));

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
  const pocketLayout = computePocketLayout(effectiveShapes, w, state.fontFamily, state.pocketRightInset);
  const pocketedIds = pocketLayout.pocketedIds;

  ctx.save();
  ctx.translate(camera.x, camera.y);
  if (camera.rotation) ctx.rotate(camera.rotation);
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
    if (state.flowArrowWidth || state.flowArrowHeadSize) {
      state.flowchart.setArrowMetrics(
        state.flowArrowWidth ?? 1.5, state.flowArrowHeadSize ?? 11,
        state.flowArrowLineCap ?? "round");
    }
    // The layer's own save/restore preserves globalAlpha, so setting it
    // here dims the whole chart — that's how the Desktop's derived
    // document-order arrows paint at 40 % without the portable layer
    // needing to know about them.
    ctx.save();
    ctx.globalAlpha = state.flowArrowAlpha ?? 1;
    state.flowchart.draw(ctx, shapes.filter((s) => !pocketedIds.has(s.id)));
    ctx.restore();
  }

  // File thumbnails that temporarily float above their neighbours: the
  // selected ones (so a picked-up thumbnail is never buried mid-drag)
  // and any doc showing its outline column (the column reaches past the
  // page and has to stay legible over whatever it overlaps). Paint-order
  // only — the shape array keeps its real z so undo stays clean.
  const raisedIds = new Set<string>();
  for (const s of shapes) {
    if (s.type !== "image" || !(s as ImageShape).fileRef) continue;
    if (selectedIds.has(s.id) || (s as ImageShape).fileRef!.outline) raisedIds.add(s.id);
  }

  for (const layer of layerOrder) {
    if (layer.hidden) continue;
    const layerShapes = shapesByLayer.get(layer.id);
    if (!layerShapes || !layerShapes.length) continue;
    const paintShape = (shape: Shape) => {
      // A shape that throws mid-paint used to take the whole rest of the
      // frame with it — every later shape, its sticky badges, and the
      // selection chrome — leaving a canvas that looks half-rendered for
      // reasons nothing on screen explains. Contain it to the one shape
      // and say so once, so the failure is visible without being a
      // 60 fps console flood.
      const tf = ctx.getTransform();
      try {
        paintShapeInner(shape);
      } catch (err) {
        // A throw between a drawer's save() and its restore() leaves the
        // camera transform whatever that drawer last set it to, which
        // would scatter every following shape. Put it back.
        ctx.setTransform(tf);
        if (!reportedPaintFailures.has(shape.id)) {
          reportedPaintFailures.add(shape.id);
          console.error("[render] shape paint failed", shape.type, shape.id, err);
        }
      }
    };
    const paintShapeInner = (shape: Shape) => {
      if (shape.type === "drag-area") return;
      if (shape.id === editingShapeId) return;
      if (pocketedIds.has(shape.id)) return;
      if (shape.type === "draw") return; // drawing layer owns strokes
      if (shape.type === "text") drawTextShape(ctx, shape, theme, state.fontFamily, false, state.flagColors);
      // Every file thumbnail casts the same subtle drop shadow, so a
      // Desktop reads as cards laid on a surface (stacked piles get it
      // for free — each member is a thumbnail).
      else if (shape.type === "image") {
        drawImageShape(ctx, shape, imageCache, shape.id === state.croppingImageId, theme, !!(shape as ImageShape).fileRef);
        const fr = (shape as ImageShape).fileRef;
        if (fr && state.fileStickies) {
          drawThumbStickies(ctx, shape as ImageShape, state.fileStickies(fr.kind, fr.fileId || ""), state.fontFamily);
          // A nested project's thumbnail is a composite of its children,
          // so their stickies ride along too — laid out on each child's
          // sub-rect and shrunk by the same factor the composite shrank
          // the child by.
          for (const c of fr.projectChildren || []) {
            const notes = state.fileStickies(c.kind, c.fileId || "");
            if (!notes.length) continue;
            drawThumbStickies(ctx, {
              position: { x: shape.position.x + c.x, y: shape.position.y + c.y },
              width: c.w, height: c.h,
            } as ImageShape, notes, state.fontFamily, fr.projectScale || 1);
          }
        }
        // A nested project's caption stays up without hover — the
        // composite reads as one card, and which project it pictures
        // shouldn't require pointing at it. Members of a pile skip it
        // (the pile's hover title list owns naming there).
        if (fr && fr.kind === "project" && !fr.stackId && state.showFileLabels !== false) {
          drawProjectLabel(ctx, shape as ImageShape, camera.zoom, theme);
        }
      }
    };
    // Two stable passes so raised shapes land on top of their layer
    // while keeping their order relative to each other.
    for (const shape of layerShapes) if (!raisedIds.has(shape.id)) paintShape(shape);
    for (const shape of layerShapes) if (raisedIds.has(shape.id)) paintShape(shape);
  }

  // Above the thumbnails, mirroring the DOM layer's stacking in the
  // full-window Desktop.
  for (const note of state.desktopStickies || []) {
    drawStickyBox(ctx, note.wx, note.wy, note.w, note.h, note.text, state.fontFamily);
  }

  if (state.desktopOutlineHover) drawOutlineHover(ctx, shapes, theme, state.desktopOutlineHover);

  // Drop-target outline: dashed rectangle around the shape that would be
  // connected if the user released the drag right now.
  if (state.flowDropTargetId) {
    const target = shapes.find((s) => s.id === state.flowDropTargetId);
    if (target && !pocketedIds.has(target.id)) {
      // Outline the whole group when the target is grouped (e.g. a cluster
      // of brushstrokes) so the highlight signals the entire node the drop
      // will connect to, not just the one stray member under the cursor.
      const tb = getShapeBounds(target, state.fontFamily);
      if (target.groupId) {
        for (const o of shapes) {
          if (o.id === target.id || o.groupId !== target.groupId) continue;
          if (pocketedIds.has(o.id)) continue;
          const ob = getShapeBounds(o, state.fontFamily);
          if (ob.minX < tb.minX) tb.minX = ob.minX;
          if (ob.minY < tb.minY) tb.minY = ob.minY;
          if (ob.maxX > tb.maxX) tb.maxX = ob.maxX;
          if (ob.maxY > tb.maxY) tb.maxY = ob.maxY;
        }
      }
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
  // Gutter orientation rule: a 2px red vertical line fixed at world-x = 20, so
  // it pans horizontally with the canvas (screenX = 20*zoom + camera.x) but
  // spans the full height regardless of scroll. The gutter "begins" with this
  // line ~20px in from its left edge at the default pan.
  if (state.gutter) {
    const lineX = 20 * camera.zoom + camera.x;
    ctx.save();
    ctx.strokeStyle = "#e44b3a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lineX, 0);
    ctx.lineTo(lineX, h);
    ctx.stroke();
    ctx.restore();
  }
  if (state.shadowHeaders?.length) drawShadowHeaders(ctx, state.shadowHeaders, theme, state.fontFamily, camera.y, w, h);

  // Per-edge delete affordances — all drawn in screen space so they stay
  // a fixed size regardless of zoom. Touch users tap the dot to reveal
  // the X (which they tap again to delete); mouse users get the same X
  // via hover (handlePointerMove sets flowHoveredEdgeId). Click handling
  // lives in DrawingState.handlePointerDown (canvas-space hit-test
  // against getEdgeMidpoint with a 12 px-screen-radius / zoom threshold).
  if (state.flowchart && !state.flowEdgesLocked) {
    const hoveredId = state.flowHoveredEdgeId ?? null;
    const touch = !!state.touchMode;
    for (const e of state.flowchart.edges) {
      const mid = state.flowchart.getEdgeMidpoint(e.id, shapes);
      if (!mid) continue;
      const { x: sx, y: sy } = canvasToScreen(mid, camera);
      // Hovered edges always paint the X (mouse hover or touch tap).
      // The persistent dot is only a touch affordance — mouse users
      // discover the X via hover so the dot just adds visual noise.
      if (e.id === hoveredId) drawEdgeDeleteButton(ctx, sx, sy, theme);
      else if (touch) drawEdgeDeleteDot(ctx, sx, sy, theme);
    }
  }

  // Pocket tray sits flush against the right-most chrome — dock's
  // inboard edge if present, otherwise the shelf.
  const hasPocketed = pocketLayout.entries.length > 0;
  const rightInset = state.pocketRightInset;
  const proximity = state.pocketProximity ?? (state.isDragging ? 1 : 0);
  if (hasPocketed || proximity > 0) {
    drawPocketTray(ctx, w, h, state.isDragging, hasPocketed, rightInset, proximity);
  }
  // Pocket entries are right-anchored already, no translation needed.
  if (pocketLayout.entries.length > 0) {
    drawPocketEntries(ctx, pocketLayout.entries, selectedIds, theme, state.fontFamily, imageCache, state.drawingLayer, state.flagColors);
  }

  if (selectionBox) drawSelectionBox(ctx, selectionBox, camera);
}

// Reorder-preview ghost — paints a clone via main-pass draw fns; strokes fall back to a polyline.
function drawGhostShape(ctx: CanvasRenderingContext2D, s: Shape, state: RenderState, theme: CanvasTheme): void {
  if (s.type === "text") drawTextShape(ctx, s, theme, state.fontFamily, false, state.flagColors);
  else if (s.type === "image") drawImageShape(ctx, s, state.imageCache, false, theme);
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
  const pinned = !!shape.pinned;
  ctx.save();
  // Pinned boxes float over scrolling canvas content, so they get an
  // opaque canvas-coloured backing (the usual translucent tint still
  // paints on top) and a thin solid border instead of the dashed one.
  if (pinned && theme) {
    ctx.fillStyle = theme.canvasBackground;
    ctx.beginPath();
    roundRect(ctx, position.x, position.y, width, height, borderRadius);
    ctx.fill();
  }
  ctx.strokeStyle = reorderActive ? (reorderAccent || strokeColor) : strokeColor;
  ctx.lineWidth = reorderActive ? 3 : pinned ? 1 : 2;
  if (!reorderActive && !pinned) ctx.setLineDash([8, 4]);
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
  // Pinned badge — a small pushpin in the top-right corner so a
  // screen-anchored box is recognizable at a glance.
  if (shape.pinned) {
    const px = position.x + width - 14;
    const py = position.y + 14;
    const c = theme?.accent || strokeColor;
    ctx.save();
    ctx.fillStyle = c;
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py - 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, py + 1);
    ctx.lineTo(px, py + 7);
    ctx.stroke();
    ctx.restore();
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

/** YOUAREHERE tag — fixed red/white matching `.cm-youarehere` in the
 *  doc editor so the marker reads identically on both surfaces. */
const YAH_TAG_BG = "#ff2b2b";
const YAH_TAG_FG = "#ffffff";

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
      if (run.youAreHere) {
        // Bright red rounded tag behind the token — a couple px of
        // overhang instead of real padding so the run's advance width
        // (and therefore wrapping / bounds) stays untouched.
        ctx.save();
        ctx.fillStyle = YAH_TAG_BG;
        ctx.beginPath();
        (ctx as any).roundRect(x - 3, y - 1, ctx.measureText(run.text).width + 6, fontSize + 4, 4);
        ctx.fill();
        ctx.restore();
      } else if (run.highlight) {
        ctx.save();
        ctx.fillStyle = resolveHighlightBg(run.highlightFlag, flagColors);
        ctx.fillRect(x, y, ctx.measureText(run.text).width, fontSize + 2);
        ctx.restore();
      }
      const isLinkish = !!(run.link || run.wikilink);
      ctx.fillStyle = run.youAreHere ? YAH_TAG_FG
        : isLinkish ? (theme.linkColor || theme.foreground) : (isHeading ? headingColor : textColor);
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

export function drawImageShape(ctx: CanvasRenderingContext2D, shape: ImageShape, imageCache: Map<string, HTMLImageElement>, isCropping?: boolean, theme?: CanvasTheme, shadow?: boolean) {
  const img = imageCache.get(shape.id);
  // `complete` alone isn't "ready": a decode that *failed* is complete
  // too, with `naturalWidth === 0`, and `drawImage` on a broken image
  // throws InvalidStateError — which aborts the rest of the paint pass
  // and takes every later shape (and its sticky badges) down with it.
  // A Desktop pane hydrates progressively, so empty-src placeholders
  // are normal there; treat them as not-ready and draw the card.
  if (img && img.complete && img.naturalWidth > 0) {
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
    if (shadow) {
      // A very subtle drop shadow so a thumbnail lifts off the canvas
      // (and off the one below it in a pile). Offsets are in world
      // units — they scale with zoom.
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 5;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 3;
      ctx.drawImage(img, sx, sy, sw, sh, shape.position.x, shape.position.y, shape.width, shape.height);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, shape.position.x, shape.position.y, shape.width, shape.height);
    }
    if (shape.fileRef) drawFileRefChrome(ctx, shape, theme);
  } else if (shape.fileRef) {
    // Thumbnail not hydrated yet — a quiet placeholder card so the
    // Desktop reads as "loading", not broken.
    ctx.save();
    ctx.fillStyle = theme?.uiBackground || "#f3f4f6";
    ctx.globalAlpha = 0.6;
    ctx.fillRect(shape.position.x, shape.position.y, shape.width, shape.height);
    ctx.globalAlpha = 1;
    ctx.restore();
    drawFileRefChrome(ctx, shape, theme);
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

/** Sidebar row highlight colours, mirrored from files-panel-row-menu's
 *  ROW_COLORS so a tinted file reads the same on its Desktop. Kept as a
 *  literal here to keep the renderer free of sidebar imports. */
const FILEREF_TINTS: Record<string, string> = {
  red: "239,83,80", orange: "255,152,0", yellow: "255,235,59",
  green: "76,175,80", teal: "0,188,212", blue: "66,165,245",
  indigo: "92,107,192", purple: "171,71,188", pink: "236,64,122",
};

/** The app's UI font stack (base.css --ui-font-family), for canvas text
 *  that should read as chrome rather than picking up the editor style. */
const UI_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Persistent caption under a nested project's thumbnail. Mirrors the
 *  hover DOM label (12 px UI font, centred 8 px below the card, 0.85
 *  opacity, ellipsised at 340 px) but painted on the canvas each frame,
 *  screen-constant via /zoom, so it shows without the pointer — in the
 *  takeover and in Desktop panes alike. */
function drawProjectLabel(ctx: CanvasRenderingContext2D, shape: ImageShape, zoom: number, theme?: CanvasTheme) {
  const name = shape.fileRef?.name;
  if (!name || !(zoom > 0)) return;
  ctx.save();
  ctx.font = `${12 / zoom}px ${UI_FONT_STACK}`;
  ctx.fillStyle = theme?.foreground || "#333333";
  ctx.globalAlpha = 0.85;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxW = Math.max(shape.width, 340 / zoom);
  let text = name;
  if (ctx.measureText(text).width > maxW) {
    while (text.length > 1 && ctx.measureText(text + "…").width > maxW) text = text.slice(0, -1);
    text += "…";
  }
  ctx.fillText(text, shape.position.x + shape.width / 2, shape.position.y + shape.height + 8 / zoom);
  ctx.restore();
}

/** Desktop file-thumbnail chrome: a hairline border so the preview
 *  reads as a card against the canvas. Filenames are no longer painted
 *  on the canvas at all — desktop-hover shows them as a DOM label under
 *  the hovered thumbnail (and lists a pile's names below the stack).
 *  Frameless thumbnails (the doc page-pile) bake their own borders, so
 *  they skip the hairline — but a tinted file still gets its wash and
 *  coloured frame, which is the whole point of the tint. */
function drawFileRefChrome(ctx: CanvasRenderingContext2D, shape: ImageShape, theme?: CanvasTheme) {
  const rgb = shape.fileRef?.tint ? FILEREF_TINTS[shape.fileRef.tint] : null;
  if (shape.fileRef?.frameless && !rgb) return;
  const { x, y } = shape.position;
  ctx.save();
  if (rgb) {
    ctx.fillStyle = `rgba(${rgb},0.16)`;
    ctx.fillRect(x, y, shape.width, shape.height);
    ctx.strokeStyle = `rgba(${rgb},0.85)`;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, shape.width - 2, shape.height - 2);
  } else {
    ctx.strokeStyle = theme?.uiBorder || "rgba(128,128,128,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, shape.width - 1, shape.height - 1);
  }
  ctx.restore();
}

// Thumbnail sticky badges — a file's own file-level stickies, shown as
// mini notes along the bottom of its Desktop thumbnail. Drawn live each
// frame from the note list rather than baked into the cached thumbnail,
// so editing a note updates its badge without a thumbnail regenerate.
const BADGE_SIZE = 130;          // note edge, in thumbnail (world) px
const BADGE_GAP = 8;             // between notes in the row
const BADGE_BOTTOM = 10;         // note's bottom edge above the thumbnail's
const BADGE_LEFT = -12;          // first note hangs off the left edge
const BADGE_PAD = 10;
const BADGE_FILL = "#ffe4ec";    // .sticky-file's pink

/** Wrap `text` to `maxW`, capped at `maxLines` (last line ellipsised). */
function wrapBadgeText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = (text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (ctx.measureText(next).width <= maxW || !line) { line = next; continue; }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.length) {
    let last = lines[maxLines - 1];
    const joined = lines.join(" ");
    if (joined.length < text.replace(/\s+/g, " ").trim().length) {
      while (last.length > 1 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = last + "…";
    }
  }
  return lines;
}

/** Lay a thumbnail's file stickies out along its bottom edge. `scale`
 *  shrinks the whole badge row — 1 for a thumbnail on the canvas, the
 *  composite's own zoom for a child inside a nested project's
 *  thumbnail, so the notes shrink with the file they belong to. */
function drawThumbStickies(
  ctx: CanvasRenderingContext2D, shape: ImageShape,
  stickies: { text: string }[], fontFamily: string, scale = 1,
) {
  if (!stickies.length) return;
  const size = BADGE_SIZE * scale;
  const left = BADGE_LEFT * scale;
  const y = shape.position.y + shape.height - BADGE_BOTTOM * scale - size;
  const x0 = shape.position.x + left;
  // Room the rest of the row has to land in. More notes than fit side by
  // side compress into an overlapping fan rather than running off the edge.
  const span = shape.width - left - size;
  const step = stickies.length > 1
    ? Math.min(size + BADGE_GAP * scale, Math.max(size * 0.28, span / (stickies.length - 1)))
    : 0;

  for (let i = 0; i < stickies.length; i++) {
    drawStickyBox(ctx, x0 + i * step, y, size, size, stickies[i].text, fontFamily);
  }
}

/** One sticky rectangle: pink paper, hairline edge, wrapped black text.
 *  Shared by the thumbnail badge row here and by desktop-thumbs, which
 *  bakes a project Desktop's pinned notes into its composite. Below a
 *  ~4 px font the body is noise rather than content, so a heavily-shrunk
 *  note keeps the pink square as a "there's a note here" marker and
 *  drops the text. */
export function drawStickyBox(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  text: string, fontFamily: string,
) {
  const pad = Math.round(Math.min(w, h) * (BADGE_PAD / BADGE_SIZE));
  const fontPx = Math.round(Math.min(w, h) * 0.078);
  const lineH = Math.round(fontPx * 1.35);
  const maxLines = Math.max(1, Math.floor((h - pad * 2) / Math.max(1, lineH)));
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.20)";
  ctx.shadowBlur = Math.max(1, w * (4 / BADGE_SIZE));
  ctx.shadowOffsetX = w / BADGE_SIZE;
  ctx.shadowOffsetY = 2 * (w / BADGE_SIZE);
  ctx.fillStyle = BADGE_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (fontPx >= 4) {
    // Stickies are always black-on-pink, independent of the canvas theme.
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.font = `${fontPx}px ${fontFamily}, sans-serif`;
    ctx.fillStyle = "#1a1a1a";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lines = wrapBadgeText(ctx, text, w - pad * 2, maxLines);
    for (let l = 0; l < lines.length; l++) {
      ctx.fillText(lines[l], x + pad, y + pad + l * lineH);
    }
  }
  ctx.restore();
}

/** Underline the outline heading row the pointer is over (Desktop doc
 *  thumbnails). Geometry arrives shape-local, so it survives the shape
 *  moving without the hover state going stale. */
function drawOutlineHover(
  ctx: CanvasRenderingContext2D, shapes: Shape[], theme: CanvasTheme,
  hover: { shapeId: string; x: number; y: number; w: number; h: number },
) {
  const shape = shapes.find((s) => s.id === hover.shapeId);
  if (!shape) return;
  const x = shape.position.x + hover.x, y = shape.position.y + hover.y + hover.h - 2;
  ctx.save();
  ctx.strokeStyle = theme.foreground;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + hover.w, y + 0.5);
  ctx.stroke();
  ctx.restore();
}

const POCKET_BLUE = "rgba(66, 153, 225, 0.18)";
const POCKET_BLUE_HIGHLIGHT = "rgba(66, 153, 225, 0.30)";

// Bounded tray flush against the shelf's left edge — corners face the
// canvas interior, the active-drop highlight bar sits on the inward side.
function drawPocketTray(
  ctx: CanvasRenderingContext2D, canvasW: number, h: number,
  isDragging: boolean, _hasPocketed: boolean, rightInset = 0, proximity = 0,
) {
  ctx.save();
  const cs = getComputedStyle(document.documentElement);
  const trayBg = (cs.getPropertyValue("--theme-bg") || cs.getPropertyValue("--bg") || "#f4f4f5").trim() || "#f4f4f5";
  const borderColor = (cs.getPropertyValue("--panel-border") || "rgba(128,128,128,0.3)").trim() || "rgba(128,128,128,0.3)";
  const w = POCKET_TRAY_WIDTH;
  const x = canvasW - rightInset - w;
  const y = 20, hh = Math.max(0, h - 40), r = 12;
  ctx.globalAlpha = isDragging ? Math.min(1, 0.85 * proximity + 0.15) : 1;
  // Rounded corners on the inward (left) side, square on the shelf side.
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + hh);
  ctx.lineTo(x + r, y + hh);
  ctx.quadraticCurveTo(x, y + hh, x, y + hh - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = trayBg; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = borderColor; ctx.stroke();
  if (isDragging) {
    ctx.globalAlpha = 0.5 * proximity;
    ctx.fillStyle = POCKET_BLUE_HIGHLIGHT;
    ctx.fillRect(x, y + 1, 4, hh - 2);
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

