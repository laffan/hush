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
import { FlowchartLayer } from "./flowchart";
import { isEmojiOnly, emojiToDataUrl } from "./emoji-sticker";
import {
  encodeSelection, remapForPaste,
  type ClipboardEnvelope,
} from "./clipboard-format";

// Pixel size (canvas units) for emoji-only text shapes that get rasterized
// into ImageShape stickers on commit.
const STICKER_SIZE = 100;
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
  | "layers" | "activeLayerId" | "isPanning" | "lassoHoldMs"
  | "drawingToolbarMinimized";

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

  /** When true, the top drawing pill is hidden and a one-item pencil
   *  pill appears beside the bottom toolbar. Session-only state. */
  drawingToolbarMinimized = true;

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

  /** Flowchart edges between text shapes. Drop a text shape onto another
   *  text shape to connect them; arrows render in the canvas. Ported
   *  from Steiner — see src/notebook/flowchart.ts for the portable API. */
  flowchart = new FlowchartLayer<Shape>({
    getBounds: (s) => getShapeBounds(s, this.fontFamily),
    getLayoutBounds: (s) => this.unionGroupBounds(s),
    isFlowable: (s) => s.type === "text",
  });
  /** While dragging a single text shape, the id of the shape under the
   *  cursor that would be the drop-connection target (or null). */
  flowDropTargetId: string | null = null;
  /** id of an edge whose curve the cursor is hovering over (or null). */
  flowHoveredEdgeId: string | null = null;
  /** Set by startEditingFlowchartChild before a new shape exists; consumed
   *  by commitText to wire the edge once the shape is created. */
  private _pendingFlowParent: string | null = null;
  /** History of recently-edited text-shape ids, oldest first. Used by
   *  ⌘↑ in the inline editor to jump back to the last node touched. */
  private _recentEditIds: string[] = [];

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

  setDrawingToolbarMinimized(b: boolean) {
    if (this.drawingToolbarMinimized === b) return;
    this.drawingToolbarMinimized = b;
    this.notify("drawingToolbarMinimized");
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

  /** Pre-drag bounds of every drag-area whose subtree is being moved by
   *  the active drag. Used by the Cmd-modifier "expand-to-fit" gesture
   *  (`applyCmdHeldResize`) so the area can grow live to wrap the dragged
   *  item + its connected shapes, and contract back — but never below
   *  the captured original — when Cmd is released. */
  private _dragAreaResizeOriginals: Map<string, {
    position: Point;
    width: number;
    height: number;
  }> = new Map();
  /** Latest known cmd / ctrl state for the active drag. Tracked separately
   *  from pointer events because a user can press / release Cmd while the
   *  cursor is stationary; `applyCmdHeldResize` is invoked from a
   *  window-level keydown / keyup hook in input-handler so the drag-area
   *  reacts in real time. */
  private _dragCmdHeld = false;

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
  commitText(editing: EditingText): string | null {
    const trimmed = editing.text.trim();
    if (!trimmed) {
      this._pendingFlowParent = null;
      return null;
    }
    // Emoji-only text becomes an image "sticker": rasterize at STICKER_SIZE
    // and swap the shape type so it scales/crops/exports like any image.
    const sticker = isEmojiOnly(trimmed)
      ? { dataUrl: emojiToDataUrl(trimmed, STICKER_SIZE), name: trimmed }
      : null;

    let shapeId: string;
    if (editing.shapeId) {
      shapeId = editing.shapeId;
      this.shapes = this.shapes.map((s) => {
        if (s.id !== editing.shapeId || s.type !== "text") return s;
        if (sticker) {
          const img: ImageShape = {
            id: s.id,
            type: "image",
            position: s.position,
            width: STICKER_SIZE,
            height: STICKER_SIZE,
            dataUrl: sticker.dataUrl,
            name: sticker.name,
            color: s.color,
            parentId: s.parentId,
            groupId: s.groupId,
            pocketed: s.pocketed,
            layerId: s.layerId,
          };
          return img;
        }
        const updated = { ...s, text: trimmed };
        // Auto-shrink width to content if not manually resized
        if (!s.manualWidth) {
          updated.width = autoFitWidth(trimmed, s.fontSize, editing.width, this.fontFamily);
        }
        return updated;
      });
      // Editing-an-existing-shape that became a sticker drops its flow
      // edges — image shapes aren't flowable.
      if (sticker) this.flowchart.removeNode(shapeId);
    } else {
      shapeId = generateId();
      if (sticker) {
        this.shapes = [
          ...this.shapes,
          {
            id: shapeId,
            type: "image",
            position: editing.position,
            width: STICKER_SIZE,
            height: STICKER_SIZE,
            dataUrl: sticker.dataUrl,
            name: sticker.name,
            color: editing.color,
            layerId: this.activeLayerId,
          } as ImageShape,
        ];
        // Pending flow parent is meaningless for an image — discard it.
        this._pendingFlowParent = null;
      } else {
        const fitWidth = autoFitWidth(trimmed, editing.fontSize, editing.width, this.fontFamily);
        this.shapes = [...this.shapes, {
          id: shapeId, type: "text", position: editing.position,
          text: trimmed, fontSize: editing.fontSize, color: editing.color,
          width: fitWidth,
          layerId: this.activeLayerId,
        } as TextShape];
        // Pending flowchart parent (set by startEditingFlowchartChild before
        // user typed) — wire the edge once the new shape exists.
        if (this._pendingFlowParent) {
          this.flowchart.addEdge(this._pendingFlowParent, shapeId);
          this._pendingFlowParent = null;
        }
      }
    }
    this.recordRecentEdit(shapeId);
    this.selectedIds = new Set([shapeId]);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
    return shapeId;
  }

  startEditingExistingText(shape: TextShape) {
    this.editingText = {
      shapeId: shape.id, position: shape.position,
      text: shape.text, fontSize: shape.fontSize, color: shape.color,
      // Widen to at least the configured max for comfortable editing,
      // unless the user has manually resized this shape past it.
      width: shape.manualWidth ? shape.width : Math.max(this.maxTextWidth, shape.width || 0),
    };
    this.recordRecentEdit(shape.id);
    this.notify("editingText");
  }

  /** Track a text-shape id in the recent-edit history (most-recent last,
   *  capped at 16 entries). Used by ⌘↑ inside the inline editor to jump
   *  back to the previous node, and by the flowchart layer for sibling
   *  navigation. */
  recordRecentEdit(id: string) {
    const idx = this._recentEditIds.indexOf(id);
    if (idx >= 0) this._recentEditIds.splice(idx, 1);
    this._recentEditIds.push(id);
    if (this._recentEditIds.length > 16) this._recentEditIds.shift();
  }

  /** Bounds of `s` unioned with its group-mates. Used as the layout footprint
   * for tidy so siblings don't overlap items grouped with a flowchart node. */
  private unionGroupBounds(s: Shape): { minX: number; minY: number; maxX: number; maxY: number } {
    const b = getShapeBounds(s, this.fontFamily);
    if (!s.groupId) return b;
    let { minX, minY, maxX, maxY } = b;
    for (const o of this.shapes) {
      if (o.id === s.id || o.groupId !== s.groupId) continue;
      const ob = getShapeBounds(o, this.fontFamily);
      if (ob.minX < minX) minX = ob.minX;
      if (ob.minY < minY) minY = ob.minY;
      if (ob.maxX > maxX) maxX = ob.maxX;
      if (ob.maxY > maxY) maxY = ob.maxY;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Re-layout the flowchart subtree rooted at `rootId` via FlowchartLayer.tidy.
   * Root stays anchored; descendants move so siblings don't overlap. */
  tidySubtree(rootId: string): void {
    const layout = this.flowchart.tidy(rootId, this.shapes);
    if (layout.size === 0) return;
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, tl] of layout) {
      const s = this.shapes.find((x) => x.id === id);
      if (!s) continue;
      const old = getShapeBounds(s, this.fontFamily);
      const dx = tl.minX - old.minX;
      const dy = tl.minY - old.minY;
      if (dx !== 0 || dy !== 0) deltas.set(id, { dx, dy });
    }
    if (deltas.size === 0) return;
    // Group-mates of moved flowchart nodes follow along, mirroring the drag
    // behavior — otherwise tidy tears groups apart by leaving non-flowchart
    // members behind.
    const groupDeltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, d] of deltas) {
      const sh = this.shapes.find((x) => x.id === id);
      if (sh?.groupId) groupDeltas.set(sh.groupId, d);
    }
    if (groupDeltas.size > 0) {
      for (const sh of this.shapes) {
        if (sh.groupId && !deltas.has(sh.id)) {
          const d = groupDeltas.get(sh.groupId);
          if (d) deltas.set(sh.id, d);
        }
      }
    }
    this.shapes = this.shapes.map((s) => {
      const d = deltas.get(s.id);
      return d ? moveShape(s, d.dx, d.dy) : s;
    });
    this.recordHistory();
    this.notify("shapes");
  }

  // === Flowchart-aware editing shortcuts ===
  //   ⌘→  startEditingFlowchartChild   — open a new node as the child of `parentId`
  //   ⌘↓  startEditingFlowchartSibling — sibling of currentId (or new node below it)
  //   ⌘←  startEditingFlowchartParent  — re-enter the parent of currentId
  //   ⌘↑  startEditingMostRecent       — jump back to the previously edited node

  /** Open an editor for a brand-new node positioned as a flowchart child of
   *  `parentId`. The edge is added by commitText once the user types. */
  startEditingFlowchartChild(parentId: string) {
    const parent = this.shapes.find((s) => s.id === parentId);
    if (!parent || parent.type !== "text") return;
    const pBounds = getShapeBounds(parent, this.fontFamily);
    let baseY = pBounds.minY;
    for (const cid of this.flowchart.childrenOf(parentId)) {
      const c = this.shapes.find((s) => s.id === cid);
      if (!c) continue;
      const cb = getShapeBounds(c, this.fontFamily);
      if (cb.maxY + 16 > baseY) baseY = cb.maxY + 16;
    }
    this._pendingFlowParent = parentId;
    this.editingText = {
      shapeId: null,
      position: { x: pBounds.maxX + 60, y: baseY },
      text: "",
      fontSize: parent.fontSize,
      color: parent.color,
      width: this.maxTextWidth,
    };
    this.notify("editingText");
  }

  /** Open an editor for a sibling of `currentId` — child of the same parent
   *  if one exists; otherwise just a new node directly below current. */
  startEditingFlowchartSibling(currentId: string) {
    const parentId = this.flowchart.parentOf(currentId);
    if (parentId) { this.startEditingFlowchartChild(parentId); return; }
    const cur = this.shapes.find((s) => s.id === currentId);
    if (!cur || cur.type !== "text") return;
    const cb = getShapeBounds(cur, this.fontFamily);
    this.editingText = {
      shapeId: null,
      position: { x: cur.position.x, y: cb.maxY + 16 },
      text: "",
      fontSize: cur.fontSize,
      color: cur.color,
      width: cur.width ?? this.maxTextWidth,
    };
    this.notify("editingText");
  }

  /** Enter edit mode on the flowchart parent of `currentId`, if any. */
  startEditingFlowchartParent(currentId: string): boolean {
    const parentId = this.flowchart.parentOf(currentId);
    if (!parentId) return false;
    const parent = this.shapes.find((s) => s.id === parentId);
    if (!parent || parent.type !== "text") return false;
    this.startEditingExistingText(parent);
    return true;
  }

  /** Enter edit mode on the most-recently-edited text shape (excluding
   *  `excludeId` and the just-edited shape if same). */
  startEditingMostRecent(excludeId?: string): boolean {
    for (let i = this._recentEditIds.length - 1; i >= 0; i--) {
      const id = this._recentEditIds[i];
      if (id === excludeId) continue;
      const shape = this.shapes.find((s) => s.id === id);
      if (shape && shape.type === "text") {
        this.startEditingExistingText(shape);
        return true;
      }
    }
    return false;
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

    // Click on the X delete-button of a hovered flowchart edge. Hit-test
    // in canvas space (12 px screen radius / current zoom) so the target
    // matches the on-screen circle drawn by the renderer.
    if (this.flowHoveredEdgeId) {
      const mid = this.flowchart.getEdgeMidpoint(this.flowHoveredEdgeId, this.shapes);
      const r = 12 / this.camera.zoom;
      if (mid && Math.hypot(canvasPt.x - mid.x, canvasPt.y - mid.y) < r) {
        this.flowchart.removeEdge(this.flowHoveredEdgeId);
        this.flowHoveredEdgeId = null;
        this.recordHistory();
        this.notify("shapes");
        return;
      }
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
    } else if (this.tool === "select" || this.brainstormMode) {
      // Brainstorm mode runs alongside the floating input widget — its
      // position is handled by the input's own drag handle, so canvas
      // clicks fall through to normal selection / drag-to-move so the
      // user can still rearrange shapes without leaving brainstorm.
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
      const cmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
      if (hitShape && hitShape.type === "text" && cmdHeld) {
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
          this._setupDragAreaResize();
          this._dragCmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;

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
    if (!this.canvasEl) return;
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
        this._setupDragAreaResize();
        this._dragCmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
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

    if (this._isDragging && (this.tool === "select" || this.brainstormMode)) {
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
        // Flowchart descendants of any selected node move with the
        // selection so the downstream spatial layout stays intact.
        const flowDescendants = new Set<string>();
        for (const id of this.selectedIds) {
          for (const d of this.flowchart.descendantsOf(id)) flowDescendants.add(d);
        }
        // If a flowchart descendant is part of a group, the rest of that group
        // tags along — otherwise dragging the parent would tear the group
        // apart by leaving the non-descendant siblings behind.
        const followingGroups = new Set<string>();
        for (const id of flowDescendants) {
          const sh = this.shapes.find((s) => s.id === id);
          if (sh?.groupId) followingGroups.add(sh.groupId);
        }
        if (followingGroups.size > 0) {
          for (const sh of this.shapes) {
            if (sh.groupId && followingGroups.has(sh.groupId)) flowDescendants.add(sh.id);
          }
        }
        this.shapes = this.shapes.map((s) => {
          if (this.selectedIds.has(s.id)) return moveShape(s, dx, dy);
          if (s.parentId && selectedDragAreaIds.has(s.parentId)) return moveShape(s, dx, dy);
          if (flowDescendants.has(s.id)) return moveShape(s, dx, dy);
          return s;
        });
        // Track Cmd state from this move event so a hold-modifier-while-dragging
        // gesture grows the parent drag-area to wrap the moving cluster.
        // Falls back to the global flag set by the on-screen Cmd button (Touch
        // mode). Re-applied below; if Cmd is released the area contracts back
        // toward its original bounds (but never shrinks below them).
        this._dragCmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
        this.applyCmdHeldResize();
        // While dragging text shape(s), keep the drop-target hover up to
        // date so the renderer can outline the prospective parent. Uses
        // the live cursor for multi-drag so it still reads naturally when
        // many shapes are being moved at once.
        const draggingTextIds: string[] = [];
        for (const s of this.shapes) {
          if (this.selectedIds.has(s.id) && s.type === "text") draggingTextIds.push(s.id);
        }
        if (draggingTextIds.length > 0) {
          let probe: Point;
          let exclude: string;
          if (draggingTextIds.length === 1) {
            const id = draggingTextIds[0];
            const sh = this.shapes.find((s) => s.id === id)!;
            const b = getShapeBounds(sh, this.fontFamily);
            probe = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
            exclude = id;
          } else {
            probe = canvasPt;
            exclude = "";
          }
          const draggingSet = new Set(draggingTextIds);
          let target: Shape | null = null;
          for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if (s.type !== "text") continue;
            if (draggingSet.has(s.id)) continue;
            if (s.id === exclude) continue;
            const bb = getShapeBounds(s, this.fontFamily);
            if (probe.x >= bb.minX && probe.x <= bb.maxX && probe.y >= bb.minY && probe.y <= bb.maxY) {
              target = s;
              break;
            }
          }
          const newId = target ? target.id : null;
          if (newId !== this.flowDropTargetId) {
            this.flowDropTargetId = newId;
          }
        }
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

    if ((this.tool === "select" || this.brainstormMode) && this._selectStart) {
      this.selectionBox = { start: this._selectStart, end: canvasPt };
      this.notify("selectionBox");
    } else if (this.tool === "drag-area" && this.creatingDragArea) {
      this.creatingDragArea = { ...this.creatingDragArea, end: canvasPt };
      this.notify("creatingDragArea");
    } else {
      // Idle hover: track the flowchart edge under the cursor so the
      // renderer can render the delete-X badge, and pointer-down knows
      // which edge to remove if the user clicks the badge.
      const threshold = 10 / this.camera.zoom;
      const edge = this.flowchart.findEdgeNear(canvasPt, this.shapes, threshold);
      const newId = edge ? edge.id : null;
      if (newId !== this.flowHoveredEdgeId) {
        this.flowHoveredEdgeId = newId;
        this.notify("shapes"); // triggers re-render of the badge
      }
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
      this._dragAreaResizeOriginals.clear();
      this._dragCmdHeld = false;
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

      // Flowchart drop: any number of dragged text shapes dropped on top of
      // another text shape. Behavior depends on the modifier:
      //   - default            → each dropped shape becomes a child of the
      //                          target (parent → child arrow, stacked below
      //                          existing siblings)
      //   - cmd / ctrl held    → each dropped shape's text is APPENDED to
      //                          the target's text and the dropped shape is
      //                          deleted (no arrow drawn)
      // The target is found via the live cursor position at drop time, not
      // the centroid — works the same for one or many dragged shapes.
      const droppedTextIds: string[] = [];
      for (const s of this.shapes) {
        if (this.selectedIds.has(s.id) && s.type === "text") {
          droppedTextIds.push(s.id);
        }
      }
      if (droppedTextIds.length > 0) {
        const droppedSet = new Set(droppedTextIds);
        let dropPt: Point | null = null;
        if (this.canvasEl) {
          const r = this.canvasEl.getBoundingClientRect();
          dropPt = screenToCanvas({ x: e.clientX - r.left, y: e.clientY - r.top }, this.camera);
        }

        let target: Shape | null = null;
        if (dropPt) {
          for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if (droppedSet.has(s.id)) continue;
            if (s.type !== "text") continue;
            const b = getShapeBounds(s, this.fontFamily);
            if (
              dropPt.x >= b.minX &&
              dropPt.x <= b.maxX &&
              dropPt.y >= b.minY &&
              dropPt.y <= b.maxY
            ) {
              target = s;
              break;
            }
          }
        }

        if (target) {
          const appendMode = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
          if (appendMode) {
            // Concatenate dropped texts in stack order and merge into target.
            const targetId = target.id;
            const appended: string[] = [];
            for (const id of droppedTextIds) {
              const s = this.shapes.find((sh) => sh.id === id);
              if (s && s.type === "text") appended.push(s.text);
            }
            const merged = appended.join("\n\n");
            this.shapes = this.shapes
              .filter((s) => !droppedSet.has(s.id))
              .map((s) => {
                if (s.id !== targetId || s.type !== "text") return s;
                const nextText = s.text ? `${s.text}\n\n${merged}` : merged;
                const updated = { ...s, text: nextText };
                if (!s.manualWidth) {
                  updated.width = autoFitWidth(nextText, s.fontSize, s.width, this.fontFamily);
                }
                return updated;
              });
            for (const id of droppedTextIds) this.flowchart.removeNode(id);
            this.selectedIds = new Set([targetId]);
            this.notify("selectedIds");
          } else {
            for (const droppedId of droppedTextIds) {
              const dropped = this.shapes.find((s) => s.id === droppedId);
              if (!dropped || dropped.type !== "text") continue;
              const oldBounds = getShapeBounds(dropped, this.fontFamily);
              const newTL = this.flowchart.tryConnect(droppedId, target.id, this.shapes);
              if (!newTL) continue;
              const dx = newTL.minX - oldBounds.minX;
              const dy = newTL.minY - oldBounds.minY;
              this.shapes = this.shapes.map((s) =>
                s.id === droppedId && s.type === "text"
                  ? { ...s, position: { x: s.position.x + dx, y: s.position.y + dy } }
                  : s,
              );
              // Snapping the parent also pulls its descendants — replay their
              // existing offset so the chain stays intact. Grouped descendants
              // bring the rest of their group along so the group doesn't get
              // torn apart by the snap.
              const desc = new Set(this.flowchart.descendantsOf(droppedId));
              if (desc.size > 0) {
                const groups = new Set<string>();
                for (const id of desc) {
                  const sh = this.shapes.find((s) => s.id === id);
                  if (sh?.groupId) groups.add(sh.groupId);
                }
                if (groups.size > 0) {
                  for (const sh of this.shapes) {
                    if (sh.groupId && groups.has(sh.groupId)) desc.add(sh.id);
                  }
                }
                this.shapes = this.shapes.map((s) =>
                  desc.has(s.id) ? moveShape(s, dx, dy) : s,
                );
              }
            }
          }
        }
      }
      this.flowDropTargetId = null;

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

    if ((this.tool === "select" || this.brainstormMode) && this.selectionBox) {
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
          backgroundColor: "rgba(107, 114, 128, 0.04)", borderRadius: 12,
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
      this._dragAreaResizeOriginals.clear();
      this._dragCmdHeld = false;
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

  // === Cmd-held drag-area resize ===
  // While a drag is in progress AND Cmd / Ctrl is held, every parent
  // drag-area of a moving shape grows live to wrap the cluster (the
  // dragged item plus anything moving with it via group / flowchart /
  // nested-drag-area). Releasing Cmd contracts the area back, but never
  // below the bounds it had at drag-start.

  /** Snapshot the bounds of every drag-area whose subtree intersects the
   *  active drag. Called from `handlePointerDown` / pocket-flip in
   *  `handlePointerMove` once `_isDragging` flips on. */
  private _setupDragAreaResize() {
    this._dragAreaResizeOriginals.clear();
    const moving = this._collectMovingShapeIds();
    if (moving.size === 0) return;
    // Don't track an area that's itself moving — its bounds shift with
    // the drag, so resizing relative to a frozen "original" wouldn't
    // mean anything.
    const movingDragAreas = new Set<string>();
    for (const s of this.shapes) {
      if (moving.has(s.id) && s.type === "drag-area") movingDragAreas.add(s.id);
    }
    const tracked = new Set<string>();
    for (const id of moving) {
      const s = this.shapes.find((x) => x.id === id);
      if (!s || !s.parentId) continue;
      if (movingDragAreas.has(s.parentId)) continue;
      tracked.add(s.parentId);
    }
    for (const areaId of tracked) {
      const a = this.shapes.find((x) => x.id === areaId);
      if (a && a.type === "drag-area") {
        this._dragAreaResizeOriginals.set(areaId, {
          position: { ...a.position },
          width: a.width,
          height: a.height,
        });
      }
    }
  }

  /** IDs of every shape that the active drag is moving — selection +
   *  children of selected drag-areas + flow descendants + group followers
   *  of those descendants. Mirrors the move set built each frame in
   *  `handlePointerMove`. */
  private _collectMovingShapeIds(): Set<string> {
    const ids = new Set<string>();
    for (const id of this.selectedIds) ids.add(id);
    const selectedDragAreaIds = new Set<string>();
    for (const s of this.shapes) {
      if (this.selectedIds.has(s.id) && s.type === "drag-area") selectedDragAreaIds.add(s.id);
    }
    for (const s of this.shapes) {
      if (s.parentId && selectedDragAreaIds.has(s.parentId)) ids.add(s.id);
    }
    for (const id of this.selectedIds) {
      for (const d of this.flowchart.descendantsOf(id)) ids.add(d);
    }
    const followingGroups = new Set<string>();
    for (const id of ids) {
      const sh = this.shapes.find((x) => x.id === id);
      if (sh?.groupId) followingGroups.add(sh.groupId);
    }
    if (followingGroups.size > 0) {
      for (const sh of this.shapes) {
        if (sh.groupId && followingGroups.has(sh.groupId)) ids.add(sh.id);
      }
    }
    return ids;
  }

  /** Update the cmd-held flag for the active drag and re-apply the
   *  resize. Called by the window-level keydown / keyup hook in
   *  `input-handler.ts` so toggling Cmd while the cursor is stationary
   *  still updates the area in real time. */
  setDragCmdHeld(held: boolean) {
    if (!this._isDragging) return;
    if (this._dragCmdHeld === held) return;
    this._dragCmdHeld = held;
    this.applyCmdHeldResize();
  }

  /** Re-apply the parent-drag-area resize using the current `_dragCmdHeld`
   *  flag. Cmd held = expand to wrap the moving cluster. Cmd released =
   *  restore each tracked area to its captured pre-drag bounds. */
  applyCmdHeldResize() {
    if (this._dragAreaResizeOriginals.size === 0) return;

    if (!this._dragCmdHeld) {
      let mutated = false;
      this.shapes = this.shapes.map((s) => {
        if (s.type !== "drag-area") return s;
        const orig = this._dragAreaResizeOriginals.get(s.id);
        if (!orig) return s;
        if (s.position.x === orig.position.x && s.position.y === orig.position.y &&
            s.width === orig.width && s.height === orig.height) return s;
        mutated = true;
        return { ...s, position: { ...orig.position }, width: orig.width, height: orig.height };
      });
      if (mutated) this.notify("shapes");
      return;
    }

    const moving = this._collectMovingShapeIds();
    let unionB: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const id of moving) {
      const s = this.shapes.find((x) => x.id === id);
      if (!s) continue;
      const b = getShapeBounds(s, this.fontFamily);
      if (!unionB) unionB = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      else {
        if (b.minX < unionB.minX) unionB.minX = b.minX;
        if (b.minY < unionB.minY) unionB.minY = b.minY;
        if (b.maxX > unionB.maxX) unionB.maxX = b.maxX;
        if (b.maxY > unionB.maxY) unionB.maxY = b.maxY;
      }
    }
    if (!unionB) return;

    // Same padding as `wrapSelectionInDragArea` so the visual breathing
    // room is consistent with the manual wrap shortcut.
    const PAD = 16;
    let mutated = false;
    this.shapes = this.shapes.map((s) => {
      if (s.type !== "drag-area") return s;
      const orig = this._dragAreaResizeOriginals.get(s.id);
      if (!orig) return s;
      const minX = Math.min(orig.position.x, unionB!.minX - PAD);
      const minY = Math.min(orig.position.y, unionB!.minY - PAD);
      const maxX = Math.max(orig.position.x + orig.width, unionB!.maxX + PAD);
      const maxY = Math.max(orig.position.y + orig.height, unionB!.maxY + PAD);
      const newW = maxX - minX;
      const newH = maxY - minY;
      if (s.position.x === minX && s.position.y === minY && s.width === newW && s.height === newH) return s;
      mutated = true;
      return { ...s, position: { x: minX, y: minY }, width: newW, height: newH };
    });
    if (mutated) this.notify("shapes");
  }

  // === Shape operations ===
  deleteSelected() {
    if (this.selectedIds.size === 0) return;
    const deletingIds = new Set(this.selectedIds);
    this.shapes = this.shapes
      .filter((s) => !deletingIds.has(s.id))
      .map((s) => s.parentId && deletingIds.has(s.parentId) ? { ...s, parentId: undefined } : s);
    // Drop any flowchart edges that referenced the deleted nodes.
    for (const id of deletingIds) this.flowchart.removeNode(id);
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
      backgroundColor: "rgba(107, 114, 128, 0.04)",
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
        if (colorName === "reset") return { ...s, strokeColor: "#6b7280", backgroundColor: "rgba(107, 114, 128, 0.04)" };
        const hex = COLOR_PALETTE[colorName] || "#6b7280";
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return { ...s, strokeColor: hex, backgroundColor: `rgba(${r}, ${g}, ${b}, 0.04)` };
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

  /**
   * Apply a saved text-style preset (color + backgroundColor + fontSize) to
   * every selected text shape in one shot. `color` is a hex string (the
   * preset captures the resolved hex, bypassing the named-palette lookup);
   * `backgroundColor` is either a palette key, a CSS string, or undefined
   * to clear the background.
   */
  applyTextStyle(opts: { color: string; backgroundColor: string | undefined; fontSize: number }) {
    this.shapes = this.shapes.map((s) => {
      if (!this.selectedIds.has(s.id)) return s;
      if (s.type !== "text") return s;
      return {
        ...s,
        color: opts.color,
        backgroundColor: opts.backgroundColor,
        fontSize: opts.fontSize,
      };
    });
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
    this.addTextShapeAtPosition(text, screenToCanvas(this._visibleScreenCenter(), this.camera));
  }

  /** Centre of the visible canvas region in viewport (screen) coords.
   *  The canvas DOM element spans the entire content column, but Hush's
   *  sidebar/panel chrome (`leftInset`) overlays its left edge. Sub the
   *  inset so paste / addTextShapeAtCenter land at the *visible* centre,
   *  not the geometric centre of the canvas element. Falls back to
   *  window centre when the canvas isn't yet laid out (rect 0×0). */
  private _visibleScreenCenter(): Point {
    const inset = this.leftInset || 0;
    if (this.canvasEl) {
      const r = this.canvasEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return {
          x: r.left + (inset + r.width) / 2,
          y: r.top + r.height / 2,
        };
      }
    }
    return {
      x: (inset + window.innerWidth) / 2,
      y: window.innerHeight / 2,
    };
  }

  /** Serialise the current selection (and any flowchart edges fully
   *  contained in it) into the portable `canvas-clipboard@1` envelope
   *  shared with Steiner. Returns the JSON string ready to write to the
   *  system clipboard, or null if nothing is selected. */
  serializeSelection(): string | null {
    if (this.selectedIds.size === 0) return null;
    const selected = this.shapes.filter((s) => this.selectedIds.has(s.id));
    if (selected.length === 0) return null;
    return encodeSelection(selected, this.flowchart.serialize());
  }

  /** Paste a decoded `canvas-clipboard@1` envelope. Generates fresh ids
   *  for every shape, remaps parent / edge references onto the new ids,
   *  positions the cluster at `dropPos` (defaulting to the centre of the
   *  canvas's bounding rect — which respects the sidebar / shelf — falling
   *  back to the window centre if the canvas isn't mounted yet), and
   *  selects the newly-created shapes. */
  pasteEnvelope(env: ClipboardEnvelope, dropPos?: Point) {
    const center = dropPos || screenToCanvas(this._visibleScreenCenter(), this.camera);
    const { shapes: pasted, edges, newIds } = remapForPaste(env, center, {
      activeLayerId: this.activeLayerId,
      fontFamily: this.fontFamily,
    });
    if (pasted.length === 0) return;

    this.shapes = [...this.shapes, ...pasted];
    for (const e of edges) {
      this.flowchart.addEdge(e.from, e.to);
    }

    this.selectedIds = new Set(newIds);
    this.tool = "select";
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
    this.notify("tool");
  }

  addTextShapeAtPosition(text: string, position: Point, opts?: { fontSize?: number }) {
    this.shapes = [...this.shapes, { id: generateId(), type: "text", position, text, fontSize: opts?.fontSize ?? 18, color: "#000000", width: this.maxTextWidth, layerId: this.activeLayerId } as TextShape];
    this.recordHistory();
    this.notify("shapes");
  }

  /** Pan so `shapeId` is centered in the visible viewport.
   *  `offsetLeft` / `offsetRight` reserve screen space for inset chrome
   *  (sidebar / shelf). Defaults pick up the state's current leftInset.
   *  When the chrome would consume most of the canvas (a narrow pane
   *  with the shelf open), the offsets are dropped so the shape lands
   *  somewhere visible instead of being squeezed under the shelf. */
  focusShape(shapeId: string, offsetLeft?: number, offsetRight = 0) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const bounds = getShapeBounds(shape, this.fontFamily);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const requestedLeft = offsetLeft ?? this.leftInset;
    // Prefer getBoundingClientRect — clientWidth misses sub-pixel layout
    // and stays at zero longer when the canvas is freshly mounted in a
    // pane that hasn't taken its first paint yet.
    let w = 0, h = 0;
    if (this.canvasEl) {
      const r = this.canvasEl.getBoundingClientRect();
      w = Math.round(r.width);
      h = Math.round(r.height);
    }
    if (w <= 0) w = window.innerWidth;
    if (h <= 0) h = window.innerHeight;

    // If the requested chrome eats more than two-thirds of the canvas,
    // fall back to centering inside the bare canvas — better to put the
    // shape behind a sliver of shelf than to pan it off-screen entirely
    // (the failure mode users hit when the shelf is open inside a
    // narrow notebook pane).
    let left = requestedLeft;
    let right = offsetRight;
    if (left + right > w * 0.66) {
      left = 0;
      right = 0;
    }

    const zoom = this.camera.zoom;
    this.camera = {
      x: (left + w - right) / 2 - cx * zoom,
      y: h / 2 - cy * zoom,
      zoom,
    };
    this.selectedIds = new Set([shapeId]);
    this.notify("camera");
    this.notify("selectedIds");
  }

}
