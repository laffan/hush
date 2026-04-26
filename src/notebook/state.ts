import type {
  Camera, CameraBookmark, DragAreaShape, DrawingSlot, DrawingSubTool,
  ImageShape, Layer, Point, SelectionBox, Shape, TextShape, Tool,
} from "./types";
import { COLOR_PALETTE } from "./types";
import {
  alignShapes, boundsOverlap, distributeShapes, generateId,
  getShapeBounds, hitTestShape,
  pointInBounds, screenToCanvas,
} from "./utils";
import { UndoManager } from "./undo-manager";
import type { AppearanceMode, CanvasTheme } from "./themes";
import { THEMES, getEffectiveVariant } from "./themes";
import {
  autoFitWidth, findShapeAtPoint, findPocketedShapeAtScreen,
  hitTestLink, normalizeBox, moveShape,
  applyResize, applyCropResize, openExternalUrl,
} from "./state-helpers";
import { computePocketLayout, POCKET_ZONE_WIDTH } from "./utils";

export interface EditingText {
  shapeId: string | null;
  position: Point;
  text: string;
  fontSize: number;
  color: string;
  width?: number; // constraint width from existing shape
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLE_SIZE = 8;

export type BackgroundPattern = "grid" | "dot-grid" | "blank";

type StateKey = "shapes" | "selectedIds" | "tool" | "color"
  | "fontSize" | "camera" | "selectionBox" | "editingText"
  | "bookmarks" | "brainstormMode" | "creatingDragArea" | "theme"
  | "drawingMode" | "drawingSubTool" | "activeBrushSlot" | "brushSlots"
  | "layers" | "activeLayerId" | "isPanning" | "lassoHoldMs";

/** Default brush-slot preset. Slots 1–3 default to "auto" color so
 *  they track the active theme's foreground; slot 4 (highlighter) is
 *  yellow because theme-fg highlighters vanish on dark themes. */
const DEFAULT_BRUSH_SLOTS: DrawingSlot[] = [
  { brushId: "brush-1", color: "auto",    size: 4,  streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-2", color: "auto",    size: 8,  streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-3", color: "auto",    size: 6,  streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-highlighter", color: "#fde047", size: 20, streamline: 0.35, spacing: 0.10, mode: "highlighter" },
];

export class DrawingState extends EventTarget {
  shapes: Shape[] = [];
  selectedIds: Set<string> = new Set();
  tool: Tool = "select";
  color = "#000000";
  fontSize = 18;
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  selectionBox: SelectionBox | null = null;
  editingText: EditingText | null = null;
  bookmarks: CameraBookmark[] = [];
  brainstormMode = false;
  creatingDragArea: { start: Point; end: Point } | null = null;

  // Drawing mode. `tool === "pen"` is the outer toggle; the fields
  // below describe the state of pen mode itself. They persist across
  // pen-mode entry/exit so users don't lose their active slot
  // selection when they toggle out and back in.
  drawingSubTool: DrawingSubTool = "draw";
  brushSlots: DrawingSlot[] = DEFAULT_BRUSH_SLOTS.map((s) => ({ ...s }));
  activeBrushSlot = 0;
  /** Hold duration (ms) that promotes an in-flight stroke into a
   *  lasso. Exposed via the lasso flyout's slider (500–2000 ms).
   *  Default matches the engine's built-in constant. */
  lassoHoldMs = 1500;

  // Layers are notebook-level; they host every shape type, not just
  // drawings. Shapes carry `layerId` via ShapeBase; the renderer
  // iterates by layer order and skips hidden layers. The drawing
  // engine's internal layer list is a mirror kept in sync by the
  // sync shim. Seeded with a single "Layer 1" at construction — a
  // freshly created notebook never has zero layers.
  layers: Layer[] = [{ id: generateId(), name: "Layer 1", locked: false, hidden: false }];
  activeLayerId: string = this.layers[0].id;

  canvasEl: HTMLCanvasElement | null = null;
  /** When true, left-click pans (set by space bar hold). */
  isPanning = false;
  /** Shape ID currently being cropped, or null */
  croppingImageId: string | null = null;

  /** Pixel offset from the left edge for the sidebar/panel. The pocket
   *  tray and toolbar center themselves relative to this value. */
  leftInset = 0;

  // Hooks driven by notes-canvas to route DrawShape drags through
  // the drawing engine's preview pipeline. See drawing-layer.ts
  // beginSelectionDrag — without this routing, dragging many
  // selected strokes spams per-frame setStrokePoints calls on the
  // engine, which is quadratic in selection size.
  onShapeDragStart: ((selectedIds: Set<string>) => void) | null = null;
  onShapeDragMove: ((totalDx: number, totalDy: number) => void) | null = null;
  onShapeDragEnd: (() => void) | null = null;

  // Appearance
  appearanceMode: AppearanceMode = "light";
  themeId = "default";
  backgroundPattern: BackgroundPattern = "dot-grid";
  gridSpacing = 25;
  gridOpacity = 0.15;
  fontFamily = "Inter";
  /** When the active Hush style has a `bg` override, this carries that
   *  hex into the canvas so the notebook paints with the user-chosen
   *  background instead of the resolved theme's stock canvasBackground.
   *  Empty string = no override (use the theme's own background). */
  canvasBackgroundOverride = "";
  /** Wrap-width cap (px) for new text shapes and brainstorm cards. The
   *  user adjusts this from Settings > Editor; existing manually-sized
   *  shapes are unaffected. Falls back to 350 — the historical default
   *  baked into every text-shape creation site. */
  maxTextWidth = 350;

  get canvasWidth(): number { return this.canvasEl?.clientWidth || window.innerWidth; }
  get isActiveDrag(): boolean { return this._showPocketTray || this.pocketProximity > 0; }

  get theme(): CanvasTheme {
    const variant = getEffectiveVariant(this.appearanceMode);
    const t = THEMES[this.themeId];
    if (t && t.variant === variant) return t;
    // Fallback: pick first theme that matches the requested variant
    const fallback = Object.values(THEMES).find((th) => th.variant === variant);
    return fallback || THEMES["default"];
  }

  setTheme(id: string) { this.themeId = id; this.notify("theme"); }
  setAppearance(mode: AppearanceMode) { this.appearanceMode = mode; this.notify("theme"); }

  // === Drawing mode ===
  get drawingMode(): boolean { return this.tool === "pen"; }

  /** Enter drawing mode. Saved slot state persists — re-entering
   *  restores the last active slot and sub-tool. */
  enterDrawingMode() {
    if (this.tool === "pen") return;
    // Clearing selection keeps Hush's selection from peeking through
    // under the drawing overlay while the user is drawing.
    if (this.selectedIds.size > 0) {
      this.selectedIds = new Set();
      this.notify("selectedIds");
    }
    this.brainstormMode = false;
    this.tool = "pen";
    this.notify("tool");
    this.notify("drawingMode");
    this.notify("brainstormMode");
  }

  /** Leave drawing mode, returning to Select tool by default. */
  exitDrawingMode() {
    if (this.tool !== "pen") return;
    this.tool = "select";
    this.notify("tool");
    this.notify("drawingMode");
  }

  setDrawingSubTool(sub: DrawingSubTool) {
    if (this.drawingSubTool === sub) return;
    this.drawingSubTool = sub;
    this.notify("drawingSubTool");
  }

  setLassoHoldMs(ms: number) {
    const n = Math.max(500, Math.min(2000, Math.round(ms)));
    if (this.lassoHoldMs === n) return;
    this.lassoHoldMs = n;
    this.notify("lassoHoldMs");
  }

  setActiveBrushSlot(i: number) {
    if (i < 0 || i >= this.brushSlots.length) return;
    if (this.activeBrushSlot === i) return;
    this.activeBrushSlot = i;
    this.notify("activeBrushSlot");
  }

  updateBrushSlot(i: number, patch: Partial<DrawingSlot>) {
    if (i < 0 || i >= this.brushSlots.length) return;
    this.brushSlots = this.brushSlots.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    this.notify("brushSlots");
  }

  // === Layers ===
  //
  // Layers are notebook-level and host every shape type. `layers` is
  // stored top-first (index 0 = top). Every mutation bumps a single
  // notify("layers"); shape repositioning onto a different layer is
  // a shape mutation and bumps "shapes".
  //
  // Known limitation: strokes render on a dedicated CSS-transformed
  // canvas stacked above the main notebook canvas, so a text shape
  // on a layer above a stroke won't visually sit above it. Layers
  // work as expected WITHIN same-type contents; cross-type z-order
  // is fixed (drawings-always-on-top). Revisit with per-layer canvas
  // if the limitation bites.

  addLayer(name?: string): string {
    const id = generateId();
    const layerName = name ?? `Layer ${this.layers.length + 1}`;
    this.layers = [{ id, name: layerName, locked: false, hidden: false }, ...this.layers];
    this.activeLayerId = id;
    this.notify("layers");
    this.notify("activeLayerId");
    return id;
  }

  deleteLayer(id: string): boolean {
    if (this.layers.length <= 1) return false; // always keep at least one layer
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return false;
    // Drop any shapes on this layer. (Matches the engine's
    // deleteLayer semantics; we're authoritative now.)
    this.shapes = this.shapes.filter((s) => s.layerId !== id);
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[0].id;
    this.notify("shapes");
    this.notify("layers");
    this.notify("activeLayerId");
    return true;
  }

  renameLayer(id: string, name: string) {
    if (!name.trim()) return;
    this.layers = this.layers.map((l) => l.id === id ? { ...l, name: name.trim() } : l);
    this.notify("layers");
  }

  setLayerHidden(id: string, hidden: boolean) {
    this.layers = this.layers.map((l) => l.id === id ? { ...l, hidden } : l);
    this.notify("layers");
    this.notify("shapes"); // renderer respects layer visibility per shape
  }

  setLayerLocked(id: string, locked: boolean) {
    this.layers = this.layers.map((l) => l.id === id ? { ...l, locked } : l);
    this.notify("layers");
  }

  moveLayerUp(id: string): boolean {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx <= 0) return false;
    const next = this.layers.slice();
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    this.layers = next;
    this.notify("layers");
    this.notify("shapes"); // z-order changed
    return true;
  }

  moveLayerDown(id: string): boolean {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0 || idx >= this.layers.length - 1) return false;
    const next = this.layers.slice();
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    this.layers = next;
    this.notify("layers");
    this.notify("shapes"); // z-order changed
    return true;
  }

  setActiveLayer(id: string) {
    if (!this.layers.some((l) => l.id === id)) return;
    if (this.activeLayerId === id) return;
    this.activeLayerId = id;
    this.notify("activeLayerId");
  }

  /** True when the active layer is locked or hidden. Shape creators
   *  should bail early when this returns true — new shapes added to
   *  an invisible layer would be confusing. */
  isActiveLayerProtected(): boolean {
    const L = this.layers.find((l) => l.id === this.activeLayerId);
    return !L || L.locked || L.hidden;
  }

  /** Set of layer ids whose contents shouldn't be interactable. Used
   *  by the selection paths to skip hidden-layer shapes without
   *  iterating layers on every hit test. */
  _hiddenLayerIds(): Set<string> {
    const s = new Set<string>();
    for (const l of this.layers) if (l.hidden) s.add(l.id);
    return s;
  }

  // Undo/redo
  private _undo = new UndoManager();

  /** Record current shapes as an undo checkpoint. Call after completed actions. */
  recordHistory() { this._undo.record(this.shapes); }

  /** Initialize undo history (call after loading shapes). */
  initHistory() { this._undo.init(this.shapes); }

  undo() {
    const snapshot = this._undo.undo();
    if (!snapshot) return;
    this.shapes = snapshot;
    this.selectedIds = new Set();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  redo() {
    const snapshot = this._undo.redo();
    if (!snapshot) return;
    this.shapes = snapshot;
    this.selectedIds = new Set();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  get canUndo() { return this._undo.canUndo; }
  get canRedo() { return this._undo.canRedo; }

  // Private interaction state (replaces useRef)
  private _isPanningActive = false;
  private _panStart: Point = { x: 0, y: 0 };
  private _cameraStart: Camera = { x: 0, y: 0, zoom: 1 };
  private _selectStart: Point | null = null;
  private _isDragging = false;
  private _dragStart: Point = { x: 0, y: 0 };
  /** Pointer position at drag-start (distinct from `_dragStart` which
   *  is updated each pointermove to compute incremental dx/dy).
   *  Needed by the drawing-engine drag-preview hook so it can apply
   *  an absolute transform each frame. */
  private _dragOrigin: Point = { x: 0, y: 0 };
  /** When true, `onShapeDragStart` has already fired for the active
   *  drag. Normal drags set this in handlePointerDown. Unpocket
   *  drags defer the call until the next pointermove so the
   *  pocket-flag flip gets bridged to the engine FIRST, before the
   *  shim pauses — otherwise the engine keeps its strokes hidden
   *  for the duration of the drag. */
  private _dragStartFired = false;
  private _isResizing = false;
  private _resizeHandle: ResizeHandle | null = null;
  private _resizeStart: Point = { x: 0, y: 0 };
  private _resizeOrigShape: Shape | null = null;
  private _resizeOrigBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  // Pocket drag state
  private _pocketDragPending = false;
  private _pocketDragScreenStart: Point = { x: 0, y: 0 };
  private _showPocketTray = false;
  private _dragHoldTimer: ReturnType<typeof setTimeout> | null = null;

  /** Snapshot of `selectedIds` taken at the start of every touch-driven
   *  pointerdown, BEFORE any selection mutation. If the gesture turns
   *  out to be a multi-touch pan/pinch (cancelActiveInteraction fires),
   *  we restore this so a finger that briefly grazed a shape on the
   *  way to a two-finger pan doesn't leave that shape selected. */
  private _preTouchSelectedIds: Set<string> | null = null;

  // Proximity-based pocket reveal. Updated on every pointer-move during a drag.
  // 0 = far away (tray hidden), 1 = cursor inside the pocket zone (full glow).
  pocketProximity = 0;
  // True when the cursor is currently inside the pocket drop zone — dragged
  // shapes should render in "pocket card" style while this is true.
  pocketInZone = false;

  // Batched notification
  private _pendingKeys = new Set<string>();
  private _notifyScheduled = false;

  notify(key: StateKey) {
    this._pendingKeys.add(key);
    if (!this._notifyScheduled) {
      this._notifyScheduled = true;
      queueMicrotask(() => {
        this._notifyScheduled = false;
        const keys = Array.from(this._pendingKeys);
        this._pendingKeys.clear();
        this.dispatchEvent(new CustomEvent("change", { detail: { keys } }));
      });
    }
  }

  // === Text ===
  commitText(editing: EditingText) {
    const trimmed = editing.text.trim();
    if (!trimmed) return;
    let shapeId: string;
    if (editing.shapeId) {
      shapeId = editing.shapeId;
      this.shapes = this.shapes.map((s) => {
        if (s.id !== editing.shapeId || s.type !== "text") return s;
        const updated = { ...s, text: trimmed };
        // Auto-shrink width to content if not manually resized
        if (!s.manualWidth) {
          updated.width = autoFitWidth(trimmed, s.fontSize, editing.width, this.fontFamily);
        }
        return updated;
      });
    } else {
      shapeId = generateId();
      const fitWidth = autoFitWidth(trimmed, editing.fontSize, editing.width, this.fontFamily);
      this.shapes = [...this.shapes, {
        id: shapeId, type: "text", position: editing.position,
        text: trimmed, fontSize: editing.fontSize, color: editing.color,
        width: fitWidth,
        layerId: this.activeLayerId,
      } as TextShape];
    }
    this.selectedIds = new Set([shapeId]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
  }

  startEditingExistingText(shape: TextShape) {
    this.editingText = {
      shapeId: shape.id, position: shape.position,
      text: shape.text, fontSize: shape.fontSize, color: shape.color,
      // Widen to at least the configured max for comfortable editing,
      // unless the user has manually resized this shape past it.
      width: shape.manualWidth ? shape.width : Math.max(this.maxTextWidth, shape.width || 0),
    };
    this.notify("editingText");
  }

  /** End an in-progress text edit from any source (blur, escape, click-outside).
   *  Commits non-empty text, clears the editor, and switches back to the
   *  select tool so the user leaves text-entry mode. Brainstorm mode keeps
   *  its current tool — its own widget drives tool state. */
  endEditingText() {
    if (!this.editingText) return;
    this.commitText(this.editingText);
    this.editingText = null;
    if (!this.brainstormMode && this.tool !== "select") {
      this.tool = "select";
      this.notify("tool");
    }
    this.notify("editingText");
  }

  /** Per-keystroke update from the inline text editor. Mirrors the typed
   *  text onto the underlying shape (when editing an existing one) so
   *  `getShapeBounds` returns the live height — selection highlights and
   *  any other bounds-based chrome grow with the textarea instead of
   *  clipping the overflow. No history snapshot is taken; `commitText`
   *  still owns that boundary. */
  updateEditingText(text: string) {
    if (!this.editingText) return;
    this.editingText = { ...this.editingText, text };
    const id = this.editingText.shapeId;
    if (id) {
      this.shapes = this.shapes.map((s) =>
        s.id === id && s.type === "text" ? { ...s, text } : s,
      );
      this.notify("shapes");
    }
    this.notify("editingText");
  }

  // === Resize handle hit test ===
  hitTestResizeHandles(canvasPt: Point): { shapeId: string; handle: ResizeHandle } | null {
    const handleRadius = (HANDLE_SIZE / 2) / this.camera.zoom + 2;
    for (const shape of this.shapes) {
      if (!this.selectedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue;
      const b = getShapeBounds(shape, this.fontFamily);
      const pad = 6;
      const x1 = b.minX - pad, y1 = b.minY - pad;
      const x2 = b.maxX + pad, y2 = b.maxY + pad;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const corners: [number, number, ResizeHandle][] = [
        [x1, y1, "nw"], [x2, y1, "ne"], [x1, y2, "sw"], [x2, y2, "se"],
        [mx, y1, "n"], [mx, y2, "s"], [x1, my, "w"], [x2, my, "e"],
      ];
      for (const [hx, hy, handle] of corners) {
        const dx = canvasPt.x - hx, dy = canvasPt.y - hy;
        if (Math.sqrt(dx * dx + dy * dy) < handleRadius) return { shapeId: shape.id, handle };
      }
    }
    return null;
  }

  // === Pointer handlers ===
  handlePointerDown(e: PointerEvent) {
    const canvas = this.canvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);

    // Snapshot selection BEFORE any mutation so a multi-touch gesture
    // (two-finger pan, pinch) can rewind any selection change the
    // first finger caused on its way down. Pen / mouse paths skip the
    // snapshot — they don't have a multi-finger phase to recover from.
    if (e.pointerType === "touch" && !this._preTouchSelectedIds) {
      this._preTouchSelectedIds = new Set(this.selectedIds);
    }

    if (e.button === 1) {
      this._isPanningActive = true;
      this._panStart = { x: e.clientX, y: e.clientY };
      this._cameraStart = { ...this.camera };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (this.editingText) {
      this.endEditingText();
      return; // commit ends the interaction; next click starts fresh
    }

    const willEditText = this.tool === "text" && !this.brainstormMode;
    if (!willEditText) canvas.setPointerCapture(e.pointerId);

    // Exit crop mode when clicking outside the cropping image (unless clicking its handles)
    if (this.croppingImageId) {
      const cropShape = this.shapes.find((s) => s.id === this.croppingImageId);
      const handleHit = this.hitTestResizeHandles(canvasPt);
      if (!handleHit || handleHit.shapeId !== this.croppingImageId) {
        if (!cropShape || !hitTestShape(canvasPt, cropShape, this.fontFamily)) {
          this.stopCropping();
        }
      }
    }

    if (this.isPanning) {
      this._isPanningActive = true;
      this._panStart = { x: e.clientX, y: e.clientY };
      this._cameraStart = { ...this.camera };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (this.tool === "text" && !this.brainstormMode) {
      // Text tool (not brainstorm — brainstorm has its own input widget)
      const hit = findShapeAtPoint(canvasPt, this.shapes, this.fontFamily);
      if (hit && hit.type === "text") {
        this.startEditingExistingText(hit);
      } else {
        this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, color: this.color, width: this.maxTextWidth };
        this.notify("editingText");
      }
    } else if (this.brainstormMode) {
      // Brainstorm mode — handled by brainstorm-input.ts widget, just skip
    } else if (this.tool === "select") {
      const handleHit = this.hitTestResizeHandles(canvasPt);
      if (handleHit) {
        this._isResizing = true;
        this._resizeHandle = handleHit.handle;
        this._resizeStart = canvasPt;
        const shape = this.shapes.find((s) => s.id === handleHit.shapeId);
        if (shape) {
          this._resizeOrigShape = structuredClone(shape);
          this._resizeOrigBounds = { ...getShapeBounds(shape, this.fontFamily) };
        }
        return;
      }

      // Check pocketed shapes first (screen-space hit test, offset by sidebar inset)
      const pocketPt = { x: screenPt.x - this.leftInset, y: screenPt.y };
      const pocketHit = findPocketedShapeAtScreen(pocketPt, this.shapes, canvas.clientWidth, this.fontFamily);
      if (pocketHit) {
        const next = e.shiftKey ? new Set(this.selectedIds) : new Set<string>();
        const allSel = e.shiftKey && pocketHit.every((id) => next.has(id));
        pocketHit.forEach((id) => allSel ? next.delete(id) : next.add(id));
        this.selectedIds = next;
        this.notify("selectedIds");
        // Prepare for drag-from-pocket
        this._pocketDragPending = true;
        this._pocketDragScreenStart = screenPt;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const { pocketedIds } = computePocketLayout(this.shapes, canvas.clientWidth, this.fontFamily);
      // Exclude pocketed shapes (rendered elsewhere) and shapes on
      // hidden layers (invisible → unclickable).
      const hiddenLayerIds = this._hiddenLayerIds();
      const hitShape = findShapeAtPoint(
        canvasPt,
        this.shapes.filter((s) => !pocketedIds.has(s.id) && !(s.layerId && hiddenLayerIds.has(s.layerId))),
        this.fontFamily,
      );

      // Cmd+click on a link: open in browser/app
      if (hitShape && hitShape.type === "text" && (e.metaKey || e.ctrlKey)) {
        const link = hitTestLink(canvasPt, hitShape);
        if (link) { openExternalUrl(link); return; }
      }

      if (hitShape) {
        const groupMembers = hitShape.groupId
          ? this.shapes.filter((s) => s.groupId === hitShape.groupId).map((s) => s.id)
          : [hitShape.id];

        if (e.shiftKey) {
          const next = new Set(this.selectedIds);
          const allSelected = groupMembers.every((id) => next.has(id));
          groupMembers.forEach((id) => allSelected ? next.delete(id) : next.add(id));
          this.selectedIds = next;
          this.notify("selectedIds");
        } else {
          if (!this.selectedIds.has(hitShape.id)) {
            this.selectedIds = new Set(groupMembers);
            this.notify("selectedIds");
          }
          this._isDragging = true;
          this._dragStart = canvasPt;
          this._dragOrigin = canvasPt;
          // Normal drag (not from pocket): fire the hook right away.
          if (this.onShapeDragStart) this.onShapeDragStart(this.selectedIds);
          this._dragStartFired = true;

          if (e.altKey) {
            const currentSelected = this.selectedIds.has(hitShape.id) ? this.selectedIds : new Set(groupMembers);
            const clones: Shape[] = [];
            const groupIdMap = new Map<string, string>();
            for (const s of this.shapes) {
              if (!currentSelected.has(s.id)) continue;
              const clone = { ...structuredClone(s), id: generateId() };
              if (clone.groupId) {
                if (!groupIdMap.has(clone.groupId)) groupIdMap.set(clone.groupId, generateId());
                clone.groupId = groupIdMap.get(clone.groupId);
              }
              clones.push(clone);
            }
            this.shapes = [...this.shapes, ...clones];
            this.selectedIds = new Set(clones.map((c) => c.id));
            this.notify("shapes");
            this.notify("selectedIds");
          }
        }
      } else {
        if (!e.shiftKey) { this.selectedIds = new Set(); this.notify("selectedIds"); }
        this._selectStart = canvasPt;
        this.selectionBox = { start: canvasPt, end: canvasPt };
        this.notify("selectionBox");
      }
    } else if (this.tool === "drag-area") {
      this.creatingDragArea = { start: canvasPt, end: canvasPt };
      this.notify("creatingDragArea");
    }
  }

  handleDoubleClick(e: MouseEvent) {
    if (!this.canvasEl || this.brainstormMode) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);
    const hit = findShapeAtPoint(canvasPt, this.shapes, this.fontFamily);
    if (hit && hit.type === "draw") {
      // Double-click on a stroke drops straight into drawing mode —
      // the user's asking to keep working on this drawing, not make
      // a new text block on top of it. If the stroke is grouped,
      // also select the whole group so a follow-up edit sees it.
      if (hit.groupId) {
        const groupIds = this.shapes
          .filter((s) => s.groupId === hit.groupId)
          .map((s) => s.id);
        this.selectedIds = new Set(groupIds);
        this.notify("selectedIds");
      } else {
        this.selectedIds = new Set([hit.id]);
        this.notify("selectedIds");
      }
      if (!this.drawingMode) this.enterDrawingMode();
      return;
    }
    if (hit && hit.type === "text") {
      this.startEditingExistingText(hit);
    } else {
      this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, color: this.color, width: this.maxTextWidth };
      this.notify("editingText");
    }
  }

  handlePointerMove(e: PointerEvent) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);

    if (this._isPanningActive) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      this.camera = { x: this._cameraStart.x + dx, y: this._cameraStart.y + dy, zoom: this._cameraStart.zoom };
      this.notify("camera");
      return;
    }

    // Drag from pocket: on first movement, unpocket shapes and place at cursor
    if (this._pocketDragPending && this.selectedIds.size > 0) {
      const dx = screenPt.x - this._pocketDragScreenStart.x;
      const dy = screenPt.y - this._pocketDragScreenStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        // Compute bounding box of selected shapes to center them on cursor
        let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
        for (const s of this.shapes) {
          if (!this.selectedIds.has(s.id)) continue;
          const b = getShapeBounds(s, this.fontFamily);
          gMinX = Math.min(gMinX, b.minX); gMinY = Math.min(gMinY, b.minY);
          gMaxX = Math.max(gMaxX, b.maxX); gMaxY = Math.max(gMaxY, b.maxY);
        }
        const offsetX = canvasPt.x - (gMinX + gMaxX) / 2;
        const offsetY = canvasPt.y - (gMinY + gMaxY) / 2;
        this.shapes = this.shapes.map((s) => {
          if (!this.selectedIds.has(s.id)) return s;
          return moveShape({ ...s, pocketed: undefined }, offsetX, offsetY);
        });
        this._pocketDragPending = false;
        this._isDragging = true;
        this._dragStart = canvasPt;
        this._dragOrigin = canvasPt;
        // Defer onShapeDragStart until the next pointermove so the
        // shim bridges the pocket-flag flip (pocketed: undefined +
        // fullRebake to show strokes in world again) BEFORE it
        // pauses for the drag. Without the defer, engine strokes
        // stay hidden for the whole drag.
        this._dragStartFired = false;
        this.notify("shapes");
      }
      return;
    }

    // Pocket proximity: fade the tray in as the drag cursor approaches the
    // left edge. Fully hidden at > 300px, fully visible once the cursor is
    // over the pocket itself.
    if (this._isDragging && this.selectedIds.size > 0) {
      const POCKET_PROXIMITY_RANGE = 300;
      const cursorFromPocket = screenPt.x - this.leftInset;
      const inZone = cursorFromPocket < POCKET_ZONE_WIDTH;
      let intensity = 0;
      if (inZone) {
        intensity = 1;
      } else if (cursorFromPocket < POCKET_ZONE_WIDTH + POCKET_PROXIMITY_RANGE) {
        const t = (cursorFromPocket - POCKET_ZONE_WIDTH) / POCKET_PROXIMITY_RANGE;
        intensity = Math.max(0, 1 - t);
      }
      if (intensity !== this.pocketProximity || inZone !== this.pocketInZone) {
        this.pocketProximity = intensity;
        this.pocketInZone = inZone;
        this.notify("shapes");
      }
    }

    if (this._isDragging && this.tool === "select") {
      const dx = canvasPt.x - this._dragStart.x;
      const dy = canvasPt.y - this._dragStart.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        this._dragStart = canvasPt;
        // Fire the deferred onShapeDragStart (unpocket drags defer
        // it so the shim bridges the pocket-exit before pausing).
        if (!this._dragStartFired && this.onShapeDragStart) {
          this.onShapeDragStart(this.selectedIds);
          this._dragStartFired = true;
        }
        if (this.onShapeDragMove) {
          this.onShapeDragMove(
            canvasPt.x - this._dragOrigin.x,
            canvasPt.y - this._dragOrigin.y,
          );
        }

        // In crop mode: drag shifts the crop window within the image
        if (this.croppingImageId && this.selectedIds.has(this.croppingImageId)) {
          this.shapes = this.shapes.map((s) => {
            if (s.id !== this.croppingImageId || s.type !== "image") return s;
            const crop = s.crop || { x: 0, y: 0, w: 1, h: 1 };
            // Convert canvas-space dx/dy to crop-fraction deltas
            const fracDx = -(dx / s.width) * crop.w;
            const fracDy = -(dy / s.height) * crop.h;
            let nx = crop.x + fracDx, ny = crop.y + fracDy;
            // Clamp so crop stays within 0..1-w and 0..1-h
            nx = Math.max(0, Math.min(1 - crop.w, nx));
            ny = Math.max(0, Math.min(1 - crop.h, ny));
            return { ...s, crop: { ...crop, x: nx, y: ny } };
          });
          this.notify("shapes");
          return;
        }

        const selectedDragAreaIds = new Set<string>();
        for (const s of this.shapes) {
          if (this.selectedIds.has(s.id) && s.type === "drag-area") selectedDragAreaIds.add(s.id);
        }
        this.shapes = this.shapes.map((s) => {
          if (this.selectedIds.has(s.id)) return moveShape(s, dx, dy);
          if (s.parentId && selectedDragAreaIds.has(s.parentId)) return moveShape(s, dx, dy);
          return s;
        });
        this.notify("shapes");
      }
      return;
    }

    if (this._isResizing && this._resizeOrigShape && this._resizeOrigBounds) {
      const dx = canvasPt.x - this._resizeStart.x;
      const dy = canvasPt.y - this._resizeStart.y;
      const handle = this._resizeHandle!;
      const origShape = this._resizeOrigShape;
      const orig = this._resizeOrigBounds;
      if (this.croppingImageId === origShape.id && origShape.type === "image") {
        this.shapes = this.shapes.map((s) => s.id !== origShape.id ? s : applyCropResize(origShape, handle, orig, dx, dy));
      } else {
        this.shapes = this.shapes.map((s) => s.id !== origShape.id ? s : applyResize(origShape, handle, orig, dx, dy));
      }
      this.notify("shapes");
      return;
    }

    if (this.tool === "select" && this._selectStart) {
      this.selectionBox = { start: this._selectStart, end: canvasPt };
      this.notify("selectionBox");
    } else if (this.tool === "drag-area" && this.creatingDragArea) {
      this.creatingDragArea = { ...this.creatingDragArea, end: canvasPt };
      this.notify("creatingDragArea");
    }
  }

  handlePointerUp(e: PointerEvent) {
    // Gesture finished cleanly — drop the touch selection snapshot so
    // the next interaction starts fresh. (A multi-touch promotion
    // would have called cancelActiveInteraction first, which already
    // consumed and cleared the snapshot.)
    this._preTouchSelectedIds = null;

    if (this._isPanningActive) { this._isPanningActive = false; return; }

    // Pocket drag pending: click without movement — just select, no move
    if (this._pocketDragPending) {
      this._pocketDragPending = false;
      return;
    }

    if (this._isDragging) {
      this._isDragging = false;
      // Only call onShapeDragEnd if a start actually fired — a
      // pocket-exit that never reached a real drag move shouldn't
      // emit an end with no start.
      if (this._dragStartFired && this.onShapeDragEnd) this.onShapeDragEnd();
      this._dragStartFired = false;
      const droppedInPocket = this.pocketInZone;
      // Reset proximity state — render will hide tray on next frame
      this.pocketProximity = 0;
      this.pocketInZone = false;
      this._clearDragHoldTimer();

      // Check if items should be pocketed (dropped in pocket zone on left edge)
      // — proximity-based: we pocket whenever the cursor is in the zone on release.
      if (droppedInPocket) {
        this.shapes = this.shapes.map((s) =>
          this.selectedIds.has(s.id) ? { ...s, pocketed: true } : s,
        );
        this.selectedIds = new Set();
        this.recordHistory();
        this.notify("shapes");
        this.notify("selectedIds");
        return;
      }

      const dragAreas = this.shapes.filter((s) => s.type === "drag-area");
      this.shapes = this.shapes.map((s) => {
        if (!this.selectedIds.has(s.id)) return s;
        if (s.type === "drag-area") return s;
        const bounds = getShapeBounds(s, this.fontFamily);
        const center: Point = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
        let newParent: string | undefined;
        for (const da of dragAreas) {
          if (this.selectedIds.has(da.id)) continue;
          if (pointInBounds(center, getShapeBounds(da, this.fontFamily), 0)) { newParent = da.id; break; }
        }
        if (newParent !== s.parentId) return { ...s, parentId: newParent };
        return s;
      });
      this.recordHistory();
      this.notify("shapes");
      return;
    }

    if (this._isResizing) {
      this._isResizing = false;
      this._resizeHandle = null;
      this._resizeOrigShape = null;
      this._resizeOrigBounds = null;
      this.recordHistory();
      return;
    }

    if (this.tool === "select" && this.selectionBox) {
      const box = normalizeBox(this.selectionBox);
      const hiddenLayerIds = this._hiddenLayerIds();
      const hits = this.shapes.filter((s) =>
        !(s.layerId && hiddenLayerIds.has(s.layerId)) &&
        boundsOverlap(getShapeBounds(s, this.fontFamily), box),
      );
      // Group-aware expansion: a grouped shape's members move / style
      // together, so the marquee should always pick them up as a unit.
      // Without this, partial overlap inside a group leaves the other
      // members unselected and the next drag splits the group apart.
      const hitIds = new Set<string>();
      const touchedGroups = new Set<string>();
      for (const s of hits) {
        hitIds.add(s.id);
        if (s.groupId) touchedGroups.add(s.groupId);
      }
      if (touchedGroups.size > 0) {
        for (const s of this.shapes) {
          if (s.groupId && touchedGroups.has(s.groupId) &&
              !(s.layerId && hiddenLayerIds.has(s.layerId))) {
            hitIds.add(s.id);
          }
        }
      }
      if (e.shiftKey) {
        const next = new Set(this.selectedIds);
        hitIds.forEach((id) => next.add(id));
        this.selectedIds = next;
      } else if (hitIds.size > 0) {
        this.selectedIds = new Set(hitIds);
      }
      this.selectionBox = null;
      this._selectStart = null;
      this.notify("selectedIds");
      this.notify("selectionBox");
    } else if (this.tool === "drag-area" && this.creatingDragArea) {
      const { start, end } = this.creatingDragArea;
      const minX = Math.min(start.x, end.x), minY = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      if (w > 20 && h > 20) {
        const newArea: DragAreaShape = {
          id: generateId(), type: "drag-area", position: { x: minX, y: minY },
          width: w, height: h, color: "#6b7280", strokeColor: "#6b7280",
          backgroundColor: "rgba(107, 114, 128, 0.16)", borderRadius: 12,
          layerId: this.activeLayerId,
        };
        const areaBounds = getShapeBounds(newArea, this.fontFamily);
        this.shapes = [...this.shapes.map((s) => {
          if (s.type === "drag-area" || s.parentId) return s;
          if (boundsOverlap(getShapeBounds(s, this.fontFamily), areaBounds)) return { ...s, parentId: newArea.id };
          return s;
        }), newArea];
        this.tool = "select";
        this.recordHistory();
        this.notify("tool");
      }
      this.creatingDragArea = null;
      this.notify("shapes");
      this.notify("creatingDragArea");
    }
  }

  /** Drop any in-flight pointer interaction without committing it.
   *  Called when a multi-touch gesture (pan/pinch) takes over so the
   *  marquee selection / drag-area / drag / resize state started by
   *  the first finger doesn't render between the user's fingers. */
  cancelActiveInteraction() {
    let changed = false;
    // Restore the selection that existed before the gesture began —
    // a finger that brushed a shape on its way to a two-finger pan
    // shouldn't leave that shape selected once we promote to pan.
    if (this._preTouchSelectedIds) {
      const prev = this._preTouchSelectedIds;
      this._preTouchSelectedIds = null;
      const sameSize = prev.size === this.selectedIds.size;
      let same = sameSize;
      if (sameSize) {
        for (const id of prev) { if (!this.selectedIds.has(id)) { same = false; break; } }
      }
      if (!same) {
        this.selectedIds = prev;
        this.notify("selectedIds");
        changed = true;
      }
    }
    if (this.selectionBox || this._selectStart) {
      this.selectionBox = null;
      this._selectStart = null;
      this.notify("selectionBox");
      changed = true;
    }
    if (this.creatingDragArea) {
      this.creatingDragArea = null;
      this.notify("creatingDragArea");
      changed = true;
    }
    if (this._isDragging) {
      this._isDragging = false;
      if (this._dragStartFired && this.onShapeDragEnd) this.onShapeDragEnd();
      this._dragStartFired = false;
      this.pocketProximity = 0;
      this.pocketInZone = false;
      this._clearDragHoldTimer();
      changed = true;
    }
    if (this._isResizing) {
      this._isResizing = false;
      this._resizeHandle = null;
      this._resizeOrigShape = null;
      this._resizeOrigBounds = null;
      changed = true;
    }
    if (this._pocketDragPending) {
      this._pocketDragPending = false;
      changed = true;
    }
    if (this._isPanningActive) {
      this._isPanningActive = false;
      changed = true;
    }
    if (changed) this.notify("shapes");
  }

  handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left, mouseY = e.clientY - rect.top;
    const zoomFactor = e.ctrlKey ? 0.01 : 0.001;
    const delta = -e.deltaY * zoomFactor;
    // Zoom range is clamped to [25%, 100%]: zooming past 1:1 tends to
    // blur ink and serves no real content purpose on a canvas where
    // everything is already world-space. 25% is the practical
    // lower-bound for a still-legible overview.
    const newZoom = Math.min(1, Math.max(0.25, this.camera.zoom * (1 + delta)));
    const scale = newZoom / this.camera.zoom;
    this.camera = {
      x: mouseX - scale * (mouseX - this.camera.x),
      y: mouseY - scale * (mouseY - this.camera.y),
      zoom: newZoom,
    };
    this.notify("camera");
  }

  // === Pocket hold timer ===
  private _startDragHoldTimer() {
    this._clearDragHoldTimer();
    this._dragHoldTimer = setTimeout(() => {
      this._showPocketTray = true;
      this.notify("shapes"); // triggers render to show tray
    }, 1000);
  }

  private _clearDragHoldTimer() {
    if (this._dragHoldTimer !== null) {
      clearTimeout(this._dragHoldTimer);
      this._dragHoldTimer = null;
    }
    this._showPocketTray = false;
  }

  // === Shape operations ===
  deleteSelected() {
    if (this.selectedIds.size === 0) return;
    const deletingIds = new Set(this.selectedIds);
    this.shapes = this.shapes
      .filter((s) => !deletingIds.has(s.id))
      .map((s) => s.parentId && deletingIds.has(s.parentId) ? { ...s, parentId: undefined } : s);
    this.selectedIds = new Set();
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  groupSelected() {
    if (this.selectedIds.size < 2) return;
    const gid = generateId();
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, groupId: gid } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  ungroupSelected() {
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, groupId: undefined } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  /** Wrap the current multi-selection in a new DragArea sized to its
   *  union bbox (with a small padding). Used by the toolbar so clicking
   *  the Drag Area tool with 2+ shapes selected acts as a wrap shortcut
   *  rather than entering draw-an-area mode.
   *
   *  Returns true when a wrap happened (caller can suppress the tool
   *  switch in that case), false otherwise. */
  wrapSelectionInDragArea(): boolean {
    if (this.selectedIds.size < 2) return false;
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    // Refuse if the selection is *only* drag-areas — wrapping containers
    // in another container is rarely what the user means.
    if (selected.every((s) => s.type === "drag-area")) return false;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of selected) {
      const b = getShapeBounds(s, this.fontFamily);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    const PAD = 16; // breathing room around the wrapped shapes
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;

    const newArea: DragAreaShape = {
      id: generateId(),
      type: "drag-area",
      position: { x: minX, y: minY },
      width: maxX - minX,
      height: maxY - minY,
      color: "#6b7280",
      strokeColor: "#6b7280",
      backgroundColor: "rgba(107, 114, 128, 0.16)",
      borderRadius: 12,
      layerId: this.activeLayerId,
    };
    const wrappedIds = new Set(selected.filter((s) => s.type !== "drag-area").map((s) => s.id));
    this.shapes = [
      ...this.shapes.map((s) => wrappedIds.has(s.id) ? { ...s, parentId: newArea.id } : s),
      newArea,
    ];
    this.selectedIds = new Set([newArea.id]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
    return true;
  }

  changeSelectedColor(colorName: string) {
    const hex = COLOR_PALETTE[colorName] || colorName;
    this.shapes = this.shapes.map((s) => this.selectedIds.has(s.id) ? { ...s, color: hex } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  changeSelectedBackground(colorName: string) {
    this.shapes = this.shapes.map((s) => {
      if (!this.selectedIds.has(s.id)) return s;
      if (s.type === "text") return { ...s, backgroundColor: colorName === "reset" ? undefined : colorName };
      if (s.type === "drag-area") {
        if (colorName === "reset") return { ...s, strokeColor: "#6b7280", backgroundColor: "rgba(107, 114, 128, 0.16)" };
        const hex = COLOR_PALETTE[colorName] || "#6b7280";
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return { ...s, strokeColor: hex, backgroundColor: `rgba(${r}, ${g}, ${b}, 0.16)` };
      }
      return s;
    });
    this.recordHistory();
    this.notify("shapes");
  }

  startCropping(shapeId: string) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape || shape.type !== "image") return;
    if (!shape.crop) {
      this.shapes = this.shapes.map((s) => s.id === shapeId ? { ...s, crop: { x: 0, y: 0, w: 1, h: 1 } } : s);
      this.notify("shapes");
    }
    this.croppingImageId = shapeId;
    this.notify("selectedIds");
  }

  stopCropping() {
    if (!this.croppingImageId) return;
    this.croppingImageId = null;
    this.recordHistory();
    this.notify("selectedIds");
  }

  applyCrop(shapeId: string, crop: { x: number; y: number; w: number; h: number }) {
    this.shapes = this.shapes.map((s) => s.id === shapeId && s.type === "image" ? { ...s, crop } : s);
    this.notify("shapes");
  }

  changeSelectedFontSize(newSize: number) {
    this.shapes = this.shapes.map((s) =>
      this.selectedIds.has(s.id) && s.type === "text" ? { ...s, fontSize: newSize } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  unpocketSelected() {
    const ids = new Set<string>();
    for (const s of this.shapes) {
      if (!this.selectedIds.has(s.id)) continue;
      ids.add(s.id);
      if (s.groupId) this.shapes.forEach((gs) => { if (gs.groupId === s.groupId) ids.add(gs.id); });
    }
    this.shapes = this.shapes.map((s) => ids.has(s.id) ? { ...s, pocketed: undefined } : s);
    this.recordHistory();
    this.notify("shapes");
  }

  alignSelected(direction: "left" | "center" | "right" | "top" | "middle" | "bottom") {
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    if (selected.length < 2) return;
    const aligned = alignShapes(selected, direction);
    const map = new Map(aligned.map((s) => [s.id, s]));
    this.shapes = this.shapes.map((s) => map.get(s.id) || s);
    this.recordHistory();
    this.notify("shapes");
  }

  distributeSelected(axis: "horizontal" | "vertical") {
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    if (selected.length < 3) return;
    const distributed = distributeShapes(selected, axis);
    const map = new Map(distributed.map((s) => [s.id, s]));
    this.shapes = this.shapes.map((s) => map.get(s.id) || s);
    this.recordHistory();
    this.notify("shapes");
  }

  // === Bookmarks ===
  addBookmark(name: string) { this.bookmarks = [...this.bookmarks, { id: generateId(), name, camera: { ...this.camera } }]; this.notify("bookmarks"); }
  goToBookmark(bm: CameraBookmark) { this.camera = { ...bm.camera }; this.notify("camera"); }
  updateBookmark(id: string) { this.bookmarks = this.bookmarks.map((b) => b.id === id ? { ...b, camera: { ...this.camera } } : b); this.notify("bookmarks"); }
  deleteBookmark(id: string) { this.bookmarks = this.bookmarks.filter((b) => b.id !== id); this.notify("bookmarks"); }

  renameImage(id: string, name: string) {
    this.shapes = this.shapes.map((s) => s.id === id && s.type === "image" ? { ...s, name } : s);
    this.notify("shapes");
  }

  // === External content ===
  addImageShape(dataUrl: string, name: string, w: number, h: number, position?: Point) {
    const maxSize = 400, aspect = w / Math.max(h, 1);
    let dw: number, dh: number;
    if (w >= h) { dw = Math.min(maxSize, w); dh = dw / aspect; }
    else { dh = Math.min(maxSize, h); dw = dh * aspect; }
    const pos = position || screenToCanvas({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, this.camera);
    const id = generateId();
    this.shapes = [...this.shapes, {
      id, type: "image", position: { x: pos.x - dw / 2, y: pos.y - dh / 2 },
      width: dw, height: dh, dataUrl, name, color: "#000000",
      layerId: this.activeLayerId,
    } as ImageShape];
    this.selectedIds = new Set([id]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
  }

  addTextShapeAtCenter(text: string) {
    this.addTextShapeAtPosition(text, screenToCanvas({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, this.camera));
  }

  addTextShapeAtPosition(text: string, position: Point) {
    this.shapes = [...this.shapes, { id: generateId(), type: "text", position, text, fontSize: 18, color: "#000000", width: this.maxTextWidth, layerId: this.activeLayerId } as TextShape];
    this.recordHistory();
    this.notify("shapes");
  }

  /** Pan so `shapeId` is centered in the visible viewport.
   *  `offsetLeft` / `offsetRight` reserve screen space for inset chrome
   *  (sidebar / shelf). Defaults pick up the state's current leftInset. */
  focusShape(shapeId: string, offsetLeft?: number, offsetRight = 0) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const bounds = getShapeBounds(shape, this.fontFamily);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const left = offsetLeft ?? this.leftInset;
    const w = this.canvasEl?.clientWidth || window.innerWidth;
    const h = this.canvasEl?.clientHeight || window.innerHeight;
    const zoom = this.camera.zoom;
    this.camera = {
      x: (left + w - offsetRight) / 2 - cx * zoom,
      y: h / 2 - cy * zoom,
      zoom,
    };
    this.selectedIds = new Set([shapeId]);
    this.notify("camera");
    this.notify("selectedIds");
  }

  moveSelectedToShelf(): string[] {
    const texts = this.shapes.filter((s) => this.selectedIds.has(s.id) && s.type === "text").map((s) => s.type === "text" ? s.text : "");
    this.shapes = this.shapes.filter((s) => !(this.selectedIds.has(s.id) && s.type === "text"));
    this.selectedIds = new Set();
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    return texts;
  }
}
