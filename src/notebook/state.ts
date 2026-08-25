import type {
  Bounds, Camera, CameraBookmark, DragAreaShape, DrawingSlot, DrawingSubTool,
  GrabSession, ImageShape, Layer, Point, ProofMeta, SelectionBox, Shape, Split,
  SplitLine, TextShape, Tool,
} from "./types";
import { COLOR_PALETTE } from "./types";
import {
  alignShapes, arrangeShapesAsGrid, boundsOverlap, distributeShapes,
  generateId, getShapeBounds, hitTestShape,
  pointInBounds, screenToCanvas,
} from "./utils";
import { UndoManager, type NotebookCheckpoint } from "./undo-manager";
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
  hitTestLink, hitTestLinkRun, soleLinkRun, hitTestTaskCheckbox, toggleTaskLine,
  normalizeBox, moveShape,
  applyResize, applyCropResize, openLinkRun,
} from "./state-helpers";
import { computePocketLayout, POCKET_ZONE_WIDTH } from "./utils";
import { collectShapesInPolygon, rectPolygon } from "./selection-region";
import {
  type SplitDragState, type SplitHoverState, type SplitPreviewState, type SplitTapPending,
  dismissSplitInteraction, splitPointerDown, splitPointerMove, splitPointerUp,
} from "./state-splits";
// PERF-HUD (temporary): tracer singleton — see perf-hud.ts.
import { perf } from "./perf-hud";

export interface EditingText {
  shapeId: string | null;
  position: Point;
  text: string;
  fontSize: number;
  color: string;
  width?: number; // constraint width from existing shape
  /** Per-shape text style, carried through the inline editor so the
   *  textarea renders in the face the committed shape will use. */
  fontFamily?: string;
  bold?: boolean;
}

/** What text on a proofread notebook starts as. A proof is a printed
 *  page with the reader's marks on it, and a correction that renders in
 *  the document's own face at the document's own colour reads as more
 *  document. Red, bold and monospaced is the pen you pick up for the
 *  margin — and per *shape*, not per canvas, so an existing note keeps
 *  whatever it was written in and the user can still change any of it. */
const PROOF_TEXT_STYLE = { color: "#d62828", fontFamily: "Courier", bold: true };

export type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLE_SIZE = 8;
/** Client-px drift (squared) a finger must cross before a selection drag
 *  started on empty canvas actually moves anything. Mirrors MOVE_SLOP_2
 *  in the drawing engine's selection.js so the two surfaces agree on
 *  what separates a tap from a drag. */
const TOUCH_SELECT_SLOP_2 = 25; // (5 CSS px)^2

export type BackgroundPattern = "grid" | "dot-grid" | "lined" | "isometric" | "blank";

type StateKey = "shapes" | "selectedIds" | "tool" | "color"
  | "fontSize" | "camera" | "selectionBox" | "editingText"
  | "bookmarks" | "brainstormMode" | "creatingDragArea" | "theme"
  | "drawingMode" | "drawingSubTool" | "activeBrushSlot" | "brushSlots"
  | "layers" | "activeLayerId" | "isPanning" | "lassoHoldMs"
  | "drawingToolbarMinimized" | "drawingToolbarOffset" | "drawingToolbarPosition"
  | "drawingToolbarVertical" | "drawingToolbarCollapsed"
  | "strokeEngineDragging" | "reorderDragAreaId" | "reorderMode"
  | "reorderHoverTargetId" | "reorderPreview" | "canvasRotationEnabled"
  // "splits" is a CONTENT key like "shapes" — split lines persist in the
  // envelope, so moving one has to mark the notebook dirty. "grab" is
  // session-only (the popup + place bar read it) and repaint-only.
  | "splits" | "grab"
  // Repaint-only keys. Every notify key schedules a render (the render
  // loop subscribes to all change events), but "shapes" additionally
  // means "content changed" downstream: notes-canvas forwards it as a
  // `notebook-change` event, which marks the notebook dirty for
  // autosave (a multi-MB serialize on stroke-heavy notebooks), emits
  // pane syncs, and runs the drawing engine's diff. Transient UI state
  // — a hover highlight, a gesture promotion to two-finger pan — must
  // repaint through these keys instead so pan-only sessions never
  // trigger content saves.
  | "flowHoveredEdgeId" | "desktopOutlineHover" | "interaction";

export type ReorderMode = "swap" | "ripple";

/** Default brush-slot presets. Slot 1 stays on "auto" so it tracks
 *  the active theme's foreground; slot 2 is the round stamp
 *  (`brush-5`) in the palette's red, the everyday marking-up pen.
 *  Slot 3 carries an explicit blue so a fresh notebook offers a
 *  useful palette out of the box, and slot 4 is a yellow highlighter
 *  (chisel-tip atlas + the multiply/alpha highlighter mode). */
const DEFAULT_BRUSH_SLOTS: DrawingSlot[] = [
  { brushId: "brush-1", color: "auto",    size: 3,  streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-5", color: "#e11d48", size: 6,  streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-3", color: "#3b82f6", size: 25, streamline: 0.35, spacing: 0.12, mode: "normal" },
  { brushId: "brush-highlighter", color: "#fde047", size: 20, streamline: 0.35, spacing: 0.12, mode: "highlighter" },
];

export class DrawingState extends EventTarget {
  shapes: Shape[] = [];
  selectedIds: Set<string> = new Set();
  tool: Tool = "select";
  color = "#000000";
  // Default text-shape size; overridden by `applySettings` from
  // `notebookFontSize`. Matches the default in state-defaults.js so a
  // notebook opened before settings load still uses 16 px text.
  fontSize = 16;
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  /** Opt-in: two-finger pan / zoom gestures may also rotate the canvas
   *  (camera.rotation). Toggled from the canvas settings menu and
   *  persisted per-notebook alongside the background overrides.
   *  Turning it off snaps any live rotation back to 0. */
  canvasRotationEnabled = false;
  selectionBox: SelectionBox | null = null;
  editingText: EditingText | null = null;
  bookmarks: CameraBookmark[] = [];
  /** Per-shape text style a *new* text shape starts from, or null to
   *  follow the canvas. Set when a proofread notebook mounts (see
   *  `PROOF_TEXT_STYLE`); untouched everywhere else. */
  newTextStyleOverride: { fontFamily?: string; bold?: boolean; color?: string } | null = null;

  // === Splits / Grabs (see splits.ts + state-splits.ts) ===
  /** Notebook-level cut lines. Not shapes: no bounds, no layer, never
   *  selected — hence their own list, persisted beside `bookmarks`. */
  splits: Split[] = [];
  /** The in-flight grab, or null. Rides the undo checkpoint so ⌘Z after
   *  a place returns to the place stage. */
  grab: GrabSession | null = null;
  /** Live split-line drag. Transient; never persisted. */
  splitDrag: SplitDragState | null = null;
  /** Live grab band sweep / edge-handle drag. */
  grabBandDrag: { anchor: number; edge: SplitLine | null } | null = null;
  /** A touch contact that would cut a split or place a grab, held until
   *  pointer-up proves it was a tap and not the first finger of a pan. */
  splitTapPending: SplitTapPending | null = null;
  /** Hovered split line + its action cluster (screen px). */
  splitHover: SplitHoverState | null = null;
  /** Where the split / grab / place line would land, under the cursor. */
  splitPreview: SplitPreviewState | null = null;
  /** ⌘ held: the split / grab tools offer a vertical line instead of a
   *  horizontal one. Mirrored from the modifier by the input handler so
   *  the preview flips without the pointer having to move. */
  splitVertical = false;
  /** Axis a shift-held wheel gesture is pinned to, or null. Latched from
   *  `_lastScrollAxis` on the first shift-held event and held until
   *  shift comes back up — re-deciding per event let a wobbling trackpad
   *  swipe flip axes mid-gesture, which is exactly the drift the
   *  modifier is meant to suppress. Cleared by the input handler on
   *  Shift keyup. */
  private _wheelAxisLock: "x" | "y" | null = null;
  /** Axis the user's un-modified scrolling is currently travelling on.
   *  Shift pins to THIS rather than to whichever delta component happens
   *  to be larger, because the delta components are not a reliable read
   *  of intent while shift is down: every platform remaps a shift-held
   *  wheel from deltaY to deltaX, so "pick the dominant axis" turns a
   *  vertical swipe into a horizontal one — the modifier ends up
   *  *switching* axes, which is the opposite of pinning. Seeded to "y":
   *  a fresh canvas reads like a document. */
  private _lastScrollAxis: "x" | "y" = "y";
  /** Proofread metadata when this notebook was built from a PDF. Drives
   *  the page thumbnail rail; null on an ordinary notebook. */
  proof: ProofMeta | null = null;
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
   *  lasso. Exposed via the lasso flyout's slider (500–2000 ms). */
  lassoHoldMs = 500;

  /** Legacy field kept only for type compatibility — the drawing
   *  toolbar is always visible now (attached to the bottom toolbar
   *  with a hamburger drag-tab at the end). Always false. */
  drawingToolbarMinimized = false;

  /** Toolbar snap position. One of three preset slots reached by drag-
   *  drop into the matching highlighted zone, or "custom" when the user
   *  drops outside a snap zone. The pane mounts persist this so the
   *  toolbar lands in the same place next session. */
  drawingToolbarPosition: "top" | "bottom" | "left" | "custom" = "top";

  /** Offset (CSS px) for the custom-position drop. Ignored when
   *  drawingToolbarPosition !== "custom". Session-only by default; the
   *  bridge syncs it to AppSettings.notebookToolbarOffset for round-trip. */
  drawingToolbarOffset: { x: number; y: number } = { x: 0, y: 0 };

  /** Derived: true when position === "left". Kept as a separate getter
   *  so existing callsites that read this flag (e.g. tool-panel layout
   *  math, bg-popup placement) keep working without churn. */
  get drawingToolbarVertical(): boolean { return this.drawingToolbarPosition === "left"; }

  /** Legacy collapse flag — collapse UI was removed in the toolbar
   *  redesign. Kept as a no-op getter so any leftover read returns
   *  false; setter is gone. */
  get drawingToolbarCollapsed(): boolean { return false; }

  /** True while the drawing engine is mid-transform (move / resize /
   *  rotate) on its own bbox. Hush's group highlight + selection
   *  toolbar hide for the duration so the engine's chrome is the
   *  only bbox in flight; everything reappears on release at the
   *  committed position. Avoids the awkward "two boxes lagging in
   *  different directions" mid-drag. */
  strokeEngineDragging = false;

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

  /** Flowchart edges between text, image, and drawing shapes. Drag-areas
   *  are deliberately excluded — dropping a shape inside a drag-area
   *  re-parents into the container and we don't want that gesture to
   *  also fire a flow connect. See src/notebook/flowchart.ts for the
   *  portable API. */
  flowchart = new FlowchartLayer<Shape>({
    // For grouped shapes (stroke clusters in particular) anchor the
    // arrow against the union of the whole group's bounds, not just
    // the lead member — otherwise the arrowhead lands inside the
    // group, pointing at one stray stroke instead of the cluster.
    getBounds: (s) => this.unionGroupBounds(s),
    getLayoutBounds: (s) => this.unionGroupBounds(s),
    // Shapes on a hidden or locked layer are not flowable: the lock
    // exists so the pointer can't reach them, and a chart connection is
    // reached entirely by pointer. This is what keeps `findDropTarget`
    // and `tryConnect` — the connect-by-drop path, in the layer and in
    // the drop handler below — off locked material.
    isFlowable: (s) => this.flowchartEnabled
      && s.type !== "drag-area"
      && !this._isLayerInert(s.layerId),
  });
  /** Per-canvas flowchart switch. The Desktop view turns it off: no
   *  drop-to-connect targets, no edge creation, no ⌘→ child editors —
   *  file thumbnails aren't chart nodes. Existing edges (there are
   *  none on a Desktop) would still render; only creation is gated. */
  flowchartEnabled = true;
  /** Per-canvas option/alt-drag-to-clone switch. Desktops turn it off —
   *  duplicated file thumbnails would dedupe away on the next open and
   *  read as phantom copies in the meantime. */
  altDuplicateEnabled = true;
  /** Per-canvas Desktop marker. Gates notebook affordances that don't
   *  fit a Desktop of file thumbnails (e.g. the selection toolbar's
   *  Rasterize, which would bake live previews into dead pixels). */
  desktopMode = false;
  /** True for a canvas hosted inside a floating / docked pane or a stack
   *  column rather than owning the main editor area. Those hosts already
   *  carve around the window chrome, so the canvas must NOT mirror the
   *  global pane-dock footprints (a bottom-docked notebook pane would
   *  absorb its *own* height and push its toolbar to the ceiling) and
   *  must not apply window safe-area insets — its edges are interior. */
  paneHosted = false;
  /** Height of the host's own chrome overlapping the top of the canvas
   *  box, in px. Non-zero only for a docked pane on iPad, whose title
   *  bar floats as a pill *over* the content rather than sitting above
   *  it in flow — canvas chrome pinned to the top edge (toolbar, shelf,
   *  page rail, scroll wheel) adds this so it lands beneath the pill
   *  instead of under it. Measured from geometry by the pane
   *  (`pane-dock.js#syncPaneChromeInset`), so it follows the pill
   *  wherever the CSS puts it. */
  hostTopInset = 0;
  /** Desktop "Thumbnail labels" option, mirrored per-canvas. Gates the
   *  persistent caption nested-project thumbnails paint (renderer.ts). */
  showFileLabels = true;
  /** Project node id whose Desktop-pinned stickies this canvas should
   *  paint, or null to paint none. Set by a Desktop *pane*: the notes
   *  themselves are live DOM singletons owned by the full-window
   *  Desktop, so a pane renders them onto its canvas instead. */
  desktopStickyTarget: string | null = null;
  /** Opacity the flowchart arrows paint at. The Desktop's derived
   *  document-order connections sit at 0.4 so they read as annotation
   *  over the thumbnails rather than as content. */
  flowArrowAlpha = 1;
  /** Stroke width + arrowhead size for the arrows, in canvas units.
   *  Null keeps the layer's own defaults; the Desktop runs far heavier
   *  so the chain reads at a fit-everything zoom. */
  flowArrowWidth: number | null = null;
  flowArrowHeadSize: number | null = null;
  flowArrowLineCap: CanvasLineCap | null = null;
  /** Whether dragging a node pulls its flowchart descendants along.
   *  True everywhere a user *drew* the chart (the subtree is a spatial
   *  unit they arranged); false on Desktops, where the chain is derived
   *  from file order and each thumbnail is its own object. */
  flowDragDescendants = true;
  /** Per-canvas switch marking the flowchart edges as derived, not
   *  user-drawn: the hover / tap delete affordances are suppressed and
   *  pointer input never removes an edge. Set by the Desktop, whose
   *  edges mirror the project's document order. */
  flowEdgesLocked = false;
  /** Optional extra section appended to the background-settings popup —
   *  the Desktop view injects its per-Desktop options (doc text size,
   *  thumbnail long edge, labels, gutters) here. Rebuilt per popup
   *  render, so the builder should return a fresh element. */
  extraBgSettingsSection: (() => HTMLElement) | null = null;
  /** While dragging a single text shape, the id of the shape under the
   *  cursor that would be the drop-connection target (or null). */
  flowDropTargetId: string | null = null;
  /** id of an edge whose curve the cursor is hovering over (or null). */
  flowHoveredEdgeId: string | null = null;
  /** Desktop only: the doc-outline heading row under the cursor, in the
   *  thumbnail's shape-local coords. Repaint-only — drives the hover
   *  underline in renderer.ts (desktop-outline.js owns the hit test). */
  desktopOutlineHover: { shapeId: string; x: number; y: number; w: number; h: number } | null = null;
  /** Set by startEditingFlowchartChild before a new shape exists; consumed
   *  by commitText to wire the edge once the shape is created. */
  private _pendingFlowParent: string | null = null;
  /** History of recently-edited text-shape ids, oldest first. Used by
   *  ⌘↑ in the inline editor to jump back to the last node touched. */
  private _recentEditIds: string[] = [];

  /** Pixel offset from the left edge for the sidebar/panel. The pocket
   *  tray and toolbar center themselves relative to this value. */
  leftInset = 0;
  /** Pixel offset from the right edge for the notebook shelf. The pocket
   *  tray now lives on the shelf's left edge rather than the sidebar
   *  edge, so the renderer + drop hit-test offset by this value to keep
   *  pocket interactions flush against the shelf. Updated whenever the
   *  shelf is opened, closed, or resized. */
  rightInset = 0;
  /** Width of any pane docked at the canvas's left edge. Used by the
   *  toolbar layout to keep its horizontal centre inside the visible
   *  editor area when a left-dock pushes the canvas inward. */
  dockedLeftWidth = 0;
  /** Width of any pane docked at the canvas's right edge. The pocket
   *  tray anchors to the dock's inboard edge (the dock takes priority
   *  over the shelf because it represents a harder visual boundary). */
  dockedRightWidth = 0;
  /** Height of any pane docked at the canvas's top edge. Toolbar
   *  centring and visible-centre math subtract this so paste / picker
   *  drops land in the visible viewport rather than under the dock. */
  dockedTopHeight = 0;
  /** Height of any pane docked at the canvas's bottom edge. */
  dockedBottomHeight = 0;

  /** Right-edge inset that the pocket tray honours — prefers the dock
   *  when present (so the tray jumps to the dock's left edge), falls
   *  back to the shelf inset otherwise. */
  get pocketRightInset(): number {
    return this.dockedRightWidth > 0 ? this.dockedRightWidth : (this.rightInset || 0);
  }
  /** When set, this canvas is acting as a doc gutter: vertical pan and
   *  wheel input scroll the host doc instead of the camera, camera.y is
   *  driven by the doc scrollTop, zoom is locked at 1, and focusShape
   *  resolves to a doc scroll. Camera.x still pans freely. */
  gutterScrollDOM: HTMLElement | null = null;
  /** Constant added to `-scrollTop` when writing `camera.y` while in
   *  gutter mode — accounts for the fact that the pane no longer sits
   *  flush against the doc content top, so world-y == doc-content-y
   *  still holds. Owned by `project/gutter.js#syncCameraFromScroll`. */
  gutterCameraOffset = 0;
  /** Faded doc headings rendered into the gutter canvas. World-y maps
   *  1:1 to doc-content-y under the gutter geometry, so `y` here is
   *  consumed directly by the renderer after the camera transform.
   *  Owned by project/gutter.js — overwritten on every doc-change. */
  shadowHeaders: { y: number; level: number; text: string }[] = [];

  // Hooks driven by notes-canvas to route DrawShape drags through
  // the drawing engine's preview pipeline. See drawing-layer.ts
  // beginSelectionDrag — without this routing, dragging many
  // selected strokes spams per-frame setStrokePoints calls on the
  // engine, which is quadratic in selection size.
  /** Returns the ids the drawing engine adopted into its preview, if
   *  any — those hold still in `shapes` for the duration (see
   *  `_engineDragIds`). */
  onShapeDragStart: ((selectedIds: Set<string>) => Set<string> | null | void) | null = null;
  onShapeDragMove: ((totalDx: number, totalDy: number) => void) | null = null;
  onShapeDragEnd: (() => void) | null = null;

  // Appearance
  appearanceMode: AppearanceMode = "light";
  themeId = "default";
  backgroundPattern: BackgroundPattern = "dot-grid";
  gridSpacing = 25;
  gridOpacity = 0.40;
  fontFamily = "Inter";
  /** When the active Hush style has a `bg` override, this carries that
   *  hex into the canvas so the notebook paints with the user-chosen
   *  background instead of the resolved theme's stock canvasBackground.
   *  Empty string = no override (use the theme's own background). */
  canvasBackgroundOverride = "";
  /** Active Hush style's background-image config ({ enabled, src, fit,
   *  repeat, blend, opacity }) or null. Drawn beneath the dot/line grid
   *  pattern on the canvas (see renderer.ts / renderer-background.ts). */
  backgroundImage: any = null;
  /** When the active Hush style has an `fg` override, this carries that
   *  hex into the canvas so default/auto-coloured text shapes and the
   *  toolbar icons track the style's text colour instead of the resolved
   *  theme's stock foreground. Empty string = no override. Applied in the
   *  `theme` getter so every consumer (renderer, toolbar) sees it. */
  foregroundOverride = "";
  /** When the active Hush style has a `header` colour override, this
   *  carries that hex into the canvas so markdown headings inside text
   *  shapes track the style's header colour instead of the resolved
   *  theme's headingColor. Empty string = no override. */
  headingColorOverride = "";
  /** When the active Hush style has a `links` colour override, this
   *  carries that hex so text-shape links track it. Empty = no override
   *  (the renderer falls back to the foreground / text colour). */
  linkColorOverride = "";
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
    let base: CanvasTheme;
    if (t && t.variant === variant) {
      base = t;
    } else {
      // Fallback: pick first theme that matches the requested variant
      base = Object.values(THEMES).find((th) => th.variant === variant) || THEMES["default"];
    }
    // Layer the active style's fg / header / link overrides on top so
    // canvas text, headings, links, and toolbar icons match the editor.
    // Only allocate a copy when an override is present (the getter runs
    // every frame).
    if (this.foregroundOverride || this.headingColorOverride || this.linkColorOverride || this.canvasBackgroundOverride) {
      const bg = this.canvasBackgroundOverride;
      return {
        ...base,
        foreground: this.foregroundOverride || base.foreground,
        headingColor: this.headingColorOverride || base.headingColor,
        linkColor: this.linkColorOverride || base.linkColor,
        // The shelf, toolbar, and floating popups read `uiBackground`; let
        // a style's background override paint them too (they otherwise
        // stay stock white/dark over a recoloured canvas).
        ...(bg ? { uiBackground: bg, background: bg, canvasBackground: bg } : {}),
      };
    }
    return base;
  }

  setTheme(id: string) { this.themeId = id; this.notify("theme"); }
  setAppearance(mode: AppearanceMode) { this.appearanceMode = mode; this.notify("theme"); }

  /** Resolve the theme this notebook would use under an explicit
   *  light/dark variant. Mirrors the `theme` getter's fallback (the
   *  active themeId when its variant matches, else the first theme of
   *  the requested variant); the active style's colour overrides are
   *  layered on only for the variant currently in effect, since
   *  overrides belong to the current style + appearance pair. Used by
   *  the dual-appearance rasterizer. */
  themeForVariant(variant: "light" | "dark"): CanvasTheme {
    if (variant === getEffectiveVariant(this.appearanceMode)) return this.theme;
    const t = THEMES[this.themeId];
    if (t && t.variant === variant) return t;
    return Object.values(THEMES).find((th) => th.variant === variant) || THEMES["default"];
  }

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

  setDrawingToolbarOffset(x: number, y: number) {
    if (this.drawingToolbarOffset.x === x && this.drawingToolbarOffset.y === y) return;
    this.drawingToolbarOffset = { x, y };
    this.notify("drawingToolbarOffset");
  }

  setDrawingToolbarVertical(b: boolean) {
    // Legacy shim: phone mount path still calls this to force vertical.
    // Route into the position state machine — "left" is the new vertical.
    this.setDrawingToolbarPosition(b ? "left" : "top");
  }

  setDrawingToolbarPosition(p: "top" | "bottom" | "left" | "custom") {
    if (this.drawingToolbarPosition === p) return;
    this.drawingToolbarPosition = p;
    if (p !== "custom") this.drawingToolbarOffset = { x: 0, y: 0 };
    this.notify("drawingToolbarPosition");
    this.notify("drawingToolbarVertical");
    this.notify("drawingToolbarOffset");
  }

  setDrawingToolbarMinimized(b: boolean) {
    if (this.drawingToolbarMinimized === b) return;
    this.drawingToolbarMinimized = b;
    if (b && this.tool === "pen") {
      // When the user hides the drawing toolbar, fall back to Select
      // so they aren't trapped with an active draw / erase / slice
      // tool they can no longer see or change.
      this.tool = "select";
      this.notify("tool");
      this.notify("drawingMode");
    } else if (!b) {
      // Restoring the toolbar drops the user back into drawing with
      // the first brush slot active — opening the pencil pill should
      // mean "I want to draw again" without a separate brush click.
      if (this.activeBrushSlot !== 0) {
        this.activeBrushSlot = 0;
        this.notify("activeBrushSlot");
      }
      if (this.drawingSubTool !== "draw") {
        this.drawingSubTool = "draw";
        this.notify("drawingSubTool");
      }
      if (this.tool !== "pen") {
        this.tool = "pen";
        this.notify("tool");
        this.notify("drawingMode");
      }
    }
    this.notify("drawingToolbarMinimized");
  }

  setLassoHoldMs(ms: number) {
    const n = Math.max(500, Math.min(2000, Math.round(ms)));
    if (this.lassoHoldMs === n) return;
    this.lassoHoldMs = n;
    this.notify("lassoHoldMs");
  }

  setCanvasRotationEnabled(on: boolean) {
    const v = !!on;
    if (this.canvasRotationEnabled === v) return;
    this.canvasRotationEnabled = v;
    // Turning the option off snaps the view back to axis-aligned so the
    // user can't be stranded in a rotation they can no longer undo by
    // gesture.
    if (!v && (this.camera.rotation || 0) !== 0) {
      this.camera = { ...this.camera, rotation: 0 };
      this.notify("camera");
    }
    this.notify("canvasRotationEnabled");
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

  /** Point `newTextStyleOverride` at the proof pen when this canvas is
   *  a proofread notebook, and clear it when it isn't. Called wherever
   *  `proof` is assigned, so a canvas reused for a different file (a
   *  pane swapping content) can't keep the previous one's defaults. */
  applyProofTextDefaults() {
    this.newTextStyleOverride = this.proof ? { ...PROOF_TEXT_STYLE } : null;
  }

  /** The style a newly created text shape starts from: the canvas
   *  defaults, overlaid with this canvas's override if it has one.
   *  Every `editingText` for a *new* shape spreads this in, so the
   *  inline editor and the committed shape agree. */
  newTextStyle(): { color: string; fontFamily?: string; bold?: boolean } {
    const o = this.newTextStyleOverride;
    return {
      color: o?.color ?? this.color,
      ...(o?.fontFamily ? { fontFamily: o.fontFamily } : {}),
      ...(o?.bold ? { bold: true } : {}),
    };
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

  /** Set of layer ids whose contents can't be picked up by the pointer
   *  at all: hidden (invisible → unclickable) plus locked (visible, but
   *  the lock exists precisely so a click lands on whatever is above).
   *  This is the set every selection / drag / resize / text-edit hit
   *  test filters against.
   *
   *  Splits deliberately do NOT consult this — a split is a cut across
   *  the whole canvas and has to divide the locked page images that a
   *  proofread notebook is built on. See `splittableSkipIds` in
   *  state-splits.ts, which skips only pocketed and hidden shapes. */
  _inertLayerIds(): Set<string> {
    const s = new Set<string>();
    for (const l of this.layers) if (l.hidden || l.locked) s.add(l.id);
    return s;
  }

  /** True when `layerId` names a hidden or locked layer. A direct scan
   *  rather than a `_inertLayerIds()` membership test, for the callers
   *  that ask per shape on a hot path (the flowchart's `isFlowable` runs
   *  over every shape on every frame of a drag) — building a Set per
   *  call would allocate one per shape per frame. Layer counts are small
   *  enough that the scan is cheaper than the Set. */
  _isLayerInert(layerId?: string): boolean {
    if (!layerId) return false;
    const L = this.layers.find((l) => l.id === layerId);
    return !!L && (L.hidden || L.locked);
  }

  /** True when `shape` sits on a hidden or locked layer. Pass `inert`
   *  when looping over many shapes at once; without it the lookup falls
   *  through to `_isLayerInert` rather than building a throwaway Set. */
  _isShapeInert(shape: { layerId?: string }, inert?: Set<string>): boolean {
    if (!shape.layerId) return false;
    return inert ? inert.has(shape.layerId) : this._isLayerInert(shape.layerId);
  }

  /** `this.shapes` minus anything on a hidden or locked layer. Returns
   *  the live array untouched in the common case (no locked or hidden
   *  layers) so the hot hit-test paths don't allocate. */
  _interactableShapes(): Shape[] {
    const inert = this._inertLayerIds();
    if (!inert.size) return this.shapes;
    return this.shapes.filter((s) => !this._isShapeInert(s, inert));
  }

  // === Splits / Grabs ===
  // Thin delegations; the state machine lives in state-splits.ts.

  /** ⌘ / Ctrl flips the split + grab tools between a horizontal and a
   *  vertical line. Driven from the modifier keydown/keyup rather than
   *  from pointer state so the preview turns under a stationary cursor. */
  setSplitVertical(on: boolean) {
    if (this.splitVertical === on) return;
    this.splitVertical = on;
    if (this.splitPreview) this.splitPreview = { ...this.splitPreview, orientation: on ? "vertical" : "horizontal" };
    this.notify("interaction");
  }

  /** Shift came up — the next shift-held wheel gesture picks its own
   *  axis afresh. */
  clearWheelAxisLock() { this._wheelAxisLock = null; }

  /** Escape hatch for Esc and tool switches: cancels a grab, ends a line
   *  drag, or drops the hover cluster. Returns true if it did anything. */
  dismissSplits(): boolean {
    const handled = dismissSplitInteraction(this);
    if (this.splitPreview) { this.splitPreview = null; this.notify("interaction"); }
    return handled;
  }

  // Undo/redo
  private _undo = new UndoManager();

  /** Assemble the full undoable state — shapes plus the flowchart edges
   *  and layers that must restore alongside them (an edge delete or a
   *  layer change recorded a checkpoint that previously couldn't bring
   *  them back). Locked edges are derived, not authored, so they stay
   *  out of the history entirely — undo would otherwise resurrect a
   *  stale chain the host is about to re-derive anyway. */
  private _checkpoint(): NotebookCheckpoint {
    return {
      shapes: this.shapes,
      flowEdges: this.flowEdgesLocked ? [] : this.flowchart.serialize(),
      layers: this.layers,
      splits: this.splits,
      grab: this.grab,
    };
  }

  private _applyCheckpoint(cp: NotebookCheckpoint) {
    this.shapes = cp.shapes;
    // Splits and the grab session restore together with the shapes:
    // undoing a line drag has to put the lines back too, and undoing a
    // completed place has to hand the buffer back to the place stage.
    this.splits = cp.splits || [];
    this.grab = cp.grab || null;
    this.splitDrag = null;
    this.grabBandDrag = null;
    this.splitHover = null;
    this.notify("splits");
    this.notify("grab");
    if (cp.flowEdges && !this.flowEdgesLocked) this.flowchart.deserialize(cp.flowEdges);
    if (cp.layers && cp.layers.length) {
      this.layers = cp.layers;
      if (!cp.layers.some((l) => l.id === this.activeLayerId)) {
        this.activeLayerId = cp.layers[0]?.id ?? this.activeLayerId;
        this.notify("activeLayerId");
      }
      this.notify("layers");
    }
    this.selectedIds = new Set();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  /** Record the current state as an undo checkpoint. Call after completed actions. */
  recordHistory() { this._undo.record(this._checkpoint()); }

  /** Initialize undo history (call after loading shapes). */
  initHistory() { this._undo.init(this._checkpoint()); }

  undo() {
    const snapshot = this._undo.undo();
    if (!snapshot) return;
    this._applyCheckpoint(snapshot);
  }

  redo() {
    const snapshot = this._undo.redo();
    if (!snapshot) return;
    this._applyCheckpoint(snapshot);
  }

  get canUndo() { return this._undo.canUndo; }
  get canRedo() { return this._undo.canRedo; }

  // Private interaction state (replaces useRef)
  private _isPanningActive = false;
  private _panStart: Point = { x: 0, y: 0 };
  private _cameraStart: Camera = { x: 0, y: 0, zoom: 1 };
  /** scrollTop on the host doc at the moment the pan started — gutter
   *  mode reads this so the doc scroll tracks the drag 1:1. */
  private _panStartScrollTop = 0;
  /** PointerId captured on the pointerdown that started the pan. Subsequent
   *  pointermoves are filtered against this id so a second contact (a palm
   *  contact, the user's other thumb, etc.) firing its own pointermove on
   *  the captured canvas can't yank the camera back to that finger's
   *  position. iPad WKWebView occasionally delivers pointermoves from the
   *  non-captured pointer to the same target, which made spacebar-drag
   *  jumpy on iPad even though it was smooth on Mac (where the cursor is
   *  the only pointer in flight). */
  private _panPointerId: number | null = null;
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
  /** Selected DrawShapes the stroke engine is previewing for this drag.
   *  Their points are deliberately NOT rewritten per frame: the engine
   *  renders them at the live offset on its preview overlay and bakes
   *  the total into the points on release, so a per-frame rewrite would
   *  allocate a fresh point array per stroke per frame for a result
   *  nothing reads. That allocation is what made a marquee-selected
   *  stroke drag chop while the identical lasso-selected drag — which
   *  never enters this handler — stayed smooth. */
  private _engineDragIds: Set<string> | null = null;
  /** Shape bounds captured once per drag for the flowchart drop-target
   *  probe. Non-moving geometry can't change mid-drag, and recomputing
   *  it every frame is a full pass over every point in the notebook. */
  private _dragProbeBounds: Map<string, Bounds> | null = null;
  /** A selection drag a finger began on empty canvas (Select tool). Held
   *  until the contact clears TOUCH_SELECT_SLOP_2 so a tap's wobble
   *  can't nudge the selection; `moved` staying false on release is how
   *  the gesture reads as a tap, which deselects. */
  private _touchSelectDrag: { client: Point; moved: boolean } | null = null;
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

  /** Drag-area whose children are being interactively reordered. While
   *  set, dragging one child onto another either swaps the two units
   *  (`reorderMode === "swap"`) or removes the dragged unit and
   *  re-inserts it at the target's reading-order slot, rippling the
   *  units in between (`reorderMode === "ripple"`). Null means reorder
   *  mode is off. Toggled from the selection toolbar (see
   *  `toggleReorderMode`). */
  reorderDragAreaId: string | null = null;
  /** Active reorder behaviour while `reorderDragAreaId` is set. Two
   *  separate toolbar buttons (swap, ripple) activate the matching
   *  mode; ignored when reorder mode is off. */
  reorderMode: ReorderMode = "swap";
  /** Full pre-drag bounds of every dragged child captured at pointerDown
   *  for the duration of an active reorder gesture. Empty otherwise.
   *  Bounds (not just TL) so the renderer can paint a same-shape ghost
   *  preview at the target's position without re-deriving dimensions. */
  private _reorderOrigBounds = new Map<string, Bounds>();
  /** id of the sibling-child currently under the cursor while a reorder
   *  drag is in flight. Drives the ghost-preview overlay and the
   *  swap-on-drop hit-test. Null when the cursor isn't over a valid
   *  target. Members of a group resolve to the group's lead member id —
   *  the renderer follows the same group expansion. */
  reorderHoverTargetId: string | null = null;
  /** Ghost preview drawn while reorder mode has a live hover target.
   *  `ghostA` / `ghostB` are the boundary rectangles for each side of
   *  the swap; `draggedShapes` / `targetShapes` are positioned clones
   *  used by the renderer to paint the shape *contents* (text glyphs,
   *  images, strokes) at the swap destination so the user can see what
   *  will move, not just where. Null when no preview should paint. */
  reorderPreview: {
    ghostA: Bounds;
    ghostB: Bounds;
    draggedShapes: Shape[];
    targetShapes: Shape[];
  } | null = null;

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

  constructor() {
    super();
    // Screen-pinned drag boxes ride camera notifications: registered
    // first (before any UI listener) so the compensation lands before
    // same-batch subscribers read shapes.
    this.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = e.detail?.keys || [];
      if (keys.includes("camera")) {
        perf.begin("state:pinComp"); // PERF-HUD (temporary)
        this._compensatePinnedForCamera();
        perf.end("state:pinComp"); // PERF-HUD (temporary)
      }
    }) as EventListener);
  }

  // === Pinned drag boxes ===
  // A pinned drag-area holds its on-screen position while the camera
  // pans — the canvas scrolls beneath it. Implemented as a world-space
  // compensation: on every camera pan, the pinned box (and its
  // transitive contents) is translated by the pan's world delta, so
  // hit-testing, selection, rendering, and persistence all keep
  // working on plain world coordinates.
  private _pinCamera: Camera = { x: 0, y: 0, zoom: 1 };

  /** Re-anchor pin compensation to the current camera without moving
   *  any shapes. Called after programmatic camera jumps that restore a
   *  saved viewport (mount restore), where the saved world positions
   *  are already consistent with the incoming camera. */
  rebasePinAnchor() {
    this._pinCamera = { ...this.camera };
  }

  private _compensatePinnedForCamera() {
    const prev = this._pinCamera;
    const cam = this.camera;
    this._pinCamera = { x: cam.x, y: cam.y, zoom: cam.zoom, rotation: cam.rotation };
    // Zoom changes rebase instead of compensating — pinning is a
    // scroll anchor, not a screen-space HUD, so pinch-zoom treats the
    // box like ordinary content. Rotation changes rebase for the same
    // reason: the twist pivots the world around the fingers, and a
    // pinned box should turn with the content rather than fight it.
    if (prev.zoom !== cam.zoom) return;
    const rot = cam.rotation || 0;
    if ((prev.rotation || 0) !== rot) return;
    // Screen-space pan delta → world delta is the inverse rotation of
    // the screen vector (identity when unrotated).
    const sx = prev.x - cam.x;
    const sy = prev.y - cam.y;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const dx = rot === 0 ? sx / cam.zoom : (sx * cos + sy * sin) / cam.zoom;
    const dy = rot === 0 ? sy / cam.zoom : (-sx * sin + sy * cos) / cam.zoom;
    if (dx === 0 && dy === 0) return;
    const pinnedAreaIds = new Set<string>();
    for (const s of this.shapes) {
      if (s.type === "drag-area" && s.pinned && !s.pocketed) pinnedAreaIds.add(s.id);
    }
    if (pinnedAreaIds.size === 0) return;
    // Transitive contents follow the box (nested drag-areas included).
    const moving = new Set<string>(pinnedAreaIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of this.shapes) {
        if (s.parentId && moving.has(s.parentId) && !moving.has(s.id)) {
          moving.add(s.id);
          grew = true;
        }
      }
    }
    this.shapes = this.shapes.map((s) => {
      if (!moving.has(s.id) || s.pocketed) return s;
      if (s.type === "draw") {
        return { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
      }
      return { ...s, position: { x: s.position.x + dx, y: s.position.y + dy } };
    });
    this.notify("shapes");
  }

  /** Flip a drag-area's pinned flag. One undo entry per toggle. */
  togglePinDragArea(dragAreaId: string) {
    let found = false;
    this.shapes = this.shapes.map((s) => {
      if (s.id !== dragAreaId || s.type !== "drag-area") return s;
      found = true;
      return { ...s, pinned: !s.pinned };
    });
    if (!found) return;
    this._pinCamera = { ...this.camera };
    this.recordHistory();
    this.notify("shapes");
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
            createdAt: s.createdAt,
          };
          return img;
        }
        const updated = { ...s, text: trimmed };
        // Auto-shrink width to content if not manually resized
        if (!s.manualWidth) {
          updated.width = autoFitWidth(trimmed, s.fontSize, editing.width, s.fontFamily || this.fontFamily);
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
            createdAt: Date.now(),
          } as ImageShape,
        ];
        // Pending flow parent is meaningless for an image — discard it.
        this._pendingFlowParent = null;
      } else {
        const fitWidth = autoFitWidth(trimmed, editing.fontSize, editing.width, editing.fontFamily || this.fontFamily);
        this.shapes = [...this.shapes, {
          id: shapeId, type: "text", position: editing.position,
          text: trimmed, fontSize: editing.fontSize, color: editing.color,
          width: fitWidth,
          ...(editing.fontFamily ? { fontFamily: editing.fontFamily } : {}),
          ...(editing.bold ? { bold: true } : {}),
          layerId: this.activeLayerId,
          createdAt: Date.now(),
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

  /** Open the inline editor on an existing text shape. Returns false
   *  when the shape is on a hidden or locked layer and no editor was
   *  opened — the pointer routes in (double-click, the Text tool's hit
   *  test) filter inert layers before they get here, but the
   *  flowchart's keyboard navigation (⌘← parent, ⌘↑ most-recent) walks
   *  edges, and an edge can point at a node whose layer was locked
   *  afterwards. Guarding here covers every caller. */
  startEditingExistingText(shape: TextShape): boolean {
    if (this._isShapeInert(shape)) return false;
    this.editingText = {
      shapeId: shape.id, position: shape.position,
      text: shape.text, fontSize: shape.fontSize, color: shape.color,
      fontFamily: shape.fontFamily, bold: shape.bold,
      // Widen to at least the configured max for comfortable editing,
      // unless the user has manually resized this shape past it.
      width: shape.manualWidth ? shape.width : Math.max(this.maxTextWidth, shape.width || 0),
    };
    this.recordRecentEdit(shape.id);
    this.notify("editingText");
    return true;
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

  /** Bounds of `s` unioned with its group-mates. Used by the flowchart
   *  layer for both arrow anchoring (so arrows land on the group's edge,
   *  not the lead member's) and tidy layout (so siblings don't overlap
   *  any group member). Falls back to the shape's own bounds when it
   *  isn't part of a group, so non-grouped shapes are unaffected. */
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
    const inert = this._inertLayerIds();
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, tl] of layout) {
      const s = this.shapes.find((x) => x.id === id);
      if (!s) continue;
      // A tidy is still a move, and a locked layer doesn't move.
      if (this._isShapeInert(s, inert)) continue;
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
        if (this._isShapeInert(sh, inert)) continue;
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
    if (!this.flowchartEnabled) return;
    const parent = this.shapes.find((s) => s.id === parentId);
    if (!parent || parent.type !== "text") return;
    // No new edge onto a hidden or locked node. ⌘→ can't reach one (its
    // editor won't open), but ⌘↓ resolves the sibling's parent from the
    // edge list and can land here with a locked parent.
    if (this._isShapeInert(parent)) return;
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
    return this.startEditingExistingText(parent);
  }

  /** Enter edit mode on the most-recently-edited text shape (excluding
   *  `excludeId` and the just-edited shape if same). */
  startEditingMostRecent(excludeId?: string): boolean {
    for (let i = this._recentEditIds.length - 1; i >= 0; i--) {
      const id = this._recentEditIds[i];
      if (id === excludeId) continue;
      const shape = this.shapes.find((s) => s.id === id);
      if (shape && shape.type === "text") {
        if (this.startEditingExistingText(shape)) return true;
        // Locked since it was last edited — keep walking back.
        continue;
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
    const inert = this._inertLayerIds();
    for (const shape of this.shapes) {
      if (!this.selectedIds.has(shape.id)) continue;
      if (shape.type === "draw") continue;
      // A locked layer's shapes are never resizable, even if they
      // somehow made it into the selection (loaded from disk, or the
      // layer was locked while they were selected).
      if (this._isShapeInert(shape, inert)) continue;
      // Desktop file thumbnails aren't resizable — their size is the
      // thumbnail's natural size (drag / group still work as normal).
      if ((shape as ImageShape).fileRef) continue;
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
      this._panStartScrollTop = this.gutterScrollDOM?.scrollTop || 0;
      this._panPointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (this.editingText) {
      this.endEditingText();
      return; // commit ends the interaction; next click starts fresh
    }

    // Hit-test the per-edge midpoint affordance (the small touch dot, or
    // the revealed X when an edge is already hovered). 12 px screen
    // radius / current zoom matches the on-screen targets the renderer
    // paints. The tap-on-dot path lets touch users summon the X without
    // hover; the second tap on the X removes the edge.
    if (!this.flowEdgesLocked) {
      const r = 12 / this.camera.zoom;
      let hitId: string | null = null;
      for (const e of this.flowchart.edges) {
        const mid = this.flowchart.getEdgeMidpoint(e.id, this.shapes);
        if (mid && Math.hypot(canvasPt.x - mid.x, canvasPt.y - mid.y) < r) {
          hitId = e.id;
          break;
        }
      }
      if (hitId) {
        if (this.flowHoveredEdgeId === hitId) {
          this.flowchart.removeEdge(hitId);
          this.flowHoveredEdgeId = null;
          this.recordHistory();
          // Real content change — an edge was deleted.
          this.notify("shapes");
        } else {
          this.flowHoveredEdgeId = hitId;
          // Hover reveal only — repaint without marking content dirty.
          this.notify("flowHoveredEdgeId");
        }
        return;
      }
      if (this.flowHoveredEdgeId) {
        // Tap landed elsewhere — collapse the revealed X back to a dot.
        this.flowHoveredEdgeId = null;
        this.notify("flowHoveredEdgeId");
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
      this._panStartScrollTop = this.gutterScrollDOM?.scrollTop || 0;
      this._panPointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Splits and grabs run ahead of the regular tool logic: a split
    // line, a hovered action button, or a waiting place bar is chrome
    // laid over the canvas, and a click on one must never fall through
    // to selection. Deliberately BELOW the pan branch — space-to-pan and
    // the middle-button pan have to keep working while a split or grab
    // is in flight, which is how the user navigates a long proof
    // mid-gesture. Returns false when nothing split-related was under
    // the pointer, in which case the tool paths below take over.
    if (splitPointerDown(this, screenPt, canvasPt, e)) {
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (this.tool === "text" && !this.brainstormMode) {
      // Text tool (not brainstorm — brainstorm has its own input widget)
      const hit = findShapeAtPoint(canvasPt, this._interactableShapes(), this.fontFamily);
      if (hit && hit.type === "text") {
        this.startEditingExistingText(hit);
      } else {
        this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, width: this.maxTextWidth, ...this.newTextStyle() };
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

      // Check pocketed shapes first (screen-space hit test). Pocket layout
      // anchors to the shelf edge (`rightInset`), so the entries' screen
      // bounds are already in viewport coords — no further offset.
      const pocketPt = { x: screenPt.x, y: screenPt.y };
      const pocketHit = findPocketedShapeAtScreen(pocketPt, this.shapes, canvas.clientWidth, this.fontFamily, this.pocketRightInset);
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
      const { pocketedIds } = computePocketLayout(this.shapes, canvas.clientWidth, this.fontFamily, this.pocketRightInset);
      // Exclude pocketed shapes (rendered elsewhere) and shapes on
      // hidden or locked layers.
      const inert = this._inertLayerIds();
      const hitShape = findShapeAtPoint(
        canvasPt,
        this.shapes.filter((s) => !pocketedIds.has(s.id) && !this._isShapeInert(s, inert)),
        this.fontFamily,
      );

      // Cmd+click on a link: open in browser/app. Wikilinks (`[[Title]]`)
      // hand off to the Hush bridge so the referenced note opens inside
      // the app instead of via the system URL handler. Cmd+Shift+click on
      // a wikilink opens the target as a floating pane instead. We only
      // intercept when a link is actually under the cursor — otherwise
      // cmd / cmd+shift drag-and-clone paths still run normally.
      const cmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
      if (hitShape && hitShape.type === "text" && cmdHeld) {
        // Precise hit-test first; if it misses (canvas link geometry drifts
        // on wrapped / blockquote / styled text — e.g. a dragged-in Zotero
        // highlight is a blockquote plus one citation), fall back to the
        // shape's sole link so a Cmd+click anywhere on it still opens it.
        const linkRun = hitTestLinkRun(canvasPt, hitShape) || soleLinkRun(hitShape);
        if (linkRun) {
          // Prevent the click from falling through to select / drag once
          // we've identified a link target — otherwise the shape selects
          // alongside the open, which surfaces the selection toolbar over
          // the just-opened note.
          e.preventDefault();
          openLinkRun(linkRun, e.clientX, e.clientY, e.shiftKey);
          return;
        }
      }

      // Markdown checkbox toggle — a plain click directly on the
      // `[ ]` / `[x]` glyph flips the task state. Sits ahead of the
      // regular select/edit branch so the click doesn't drag-select
      // or start text editing.
      if (hitShape && hitShape.type === "text" && !e.shiftKey && !e.altKey) {
        const taskIdx = hitTestTaskCheckbox(canvasPt, hitShape, this.fontFamily);
        if (taskIdx != null) {
          const nextText = toggleTaskLine(hitShape.text, taskIdx);
          if (nextText != null) {
            const id = hitShape.id;
            this.shapes = this.shapes.map((s) =>
              s.id === id && s.type === "text" ? { ...s, text: nextText } : s,
            );
            this.recordHistory();
            this.notify("shapes");
            return;
          }
        }
      }

      if (hitShape) {
        // ⌘-dragging a member of a Desktop thumbnail stack pulls just
        // that one thumbnail out — skip the usual whole-group promotion
        // so the drag moves the single shape (desktop-stacks.js releases
        // it from the stack on pointer-up).
        const soloStackPull = cmdHeld
          && hitShape.type === "image" && !!(hitShape as ImageShape).fileRef?.stackId;
        const groupMembers = !soloStackPull && hitShape.groupId
          ? this.shapes.filter((s) => s.groupId === hitShape.groupId).map((s) => s.id)
          : [hitShape.id];
        if (soloStackPull && (this.selectedIds.size !== 1 || !this.selectedIds.has(hitShape.id))) {
          this.selectedIds = new Set([hitShape.id]);
          this.notify("selectedIds");
        }

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

          // Option-drag clone runs BEFORE the drag-start hook, not
          // after. The sync-shim's `pauseForDrag` (wired into
          // onShapeDragStart) freezes the state→engine diff for the
          // duration of the drag — so any DrawShapes pushed into
          // `state.shapes` after that pause are invisible to the
          // bake engine until the drag ends. The result the user
          // saw was a single moving selection bbox (rendered from
          // shape points by the regular renderer) with no actual
          // strokes underneath. Clone first, swap the selection,
          // then let the drag begin with the new shape ids.
          if (e.altKey && this.altDuplicateEnabled) {
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

          this._isDragging = true;
          this._dragStart = canvasPt;
          this._dragOrigin = canvasPt;
          // Normal drag (not from pocket): fire the hook right away.
          this._beginShapeDrag();
          this._setupDragAreaResize();
          this._captureReorderOrigins();
          this._dragCmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
        }
      } else if (e.pointerType === "touch" && !e.shiftKey && this.selectedIds.size > 0) {
        // A finger landing on empty canvas with something selected drags
        // the selection rather than sweeping a new marquee — the same
        // rule pen mode follows, where pinning a fingertip on a small
        // bbox is the hard part. Tap-then-sweep is how you select
        // something else; the tap fires from pointer-up (below) once we
        // know the contact didn't travel. A drag that lands ON a shape
        // still grabs that shape, and mouse / pen keep the marquee, so
        // desktop is unchanged.
        this._isDragging = true;
        this._dragStart = canvasPt;
        this._dragOrigin = canvasPt;
        this._touchSelectDrag = { client: { x: e.clientX, y: e.clientY }, moved: false };
        // Leave _dragStartFired false: the drag-start hook fires from
        // the first real movement, so a tap never opens (and closes) an
        // engine preview transform for nothing.
        this._setupDragAreaResize();
        this._captureReorderOrigins();
        this._dragCmdHeld = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
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
    const hit = findShapeAtPoint(canvasPt, this._interactableShapes(), this.fontFamily);
    if (hit && hit.type === "draw") {
      // Double-click on a stroke selects only that stroke. For a
      // grouped stroke this lets the user reposition the individual
      // member without disturbing the rest of the group; the stroke's
      // `groupId` is untouched so on deselect it returns to being a
      // normal group member. (Single-click promotes to whole-group
      // selection — the double-click path is the only way to pick a
      // single member out of a group.)
      this.selectedIds = new Set([hit.id]);
      this.notify("selectedIds");
      return;
    }
    if (hit && hit.type === "text") {
      this.startEditingExistingText(hit);
    } else {
      this.editingText = { shapeId: null, position: canvasPt, text: "", fontSize: this.fontSize, width: this.maxTextWidth, ...this.newTextStyle() };
      this.notify("editingText");
    }
  }

  handlePointerMove(e: PointerEvent) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const canvasPt = screenToCanvas(screenPt, this.camera);

    if (this._isPanningActive) {
      // Filter to the pointer that started the pan. iPad occasionally
      // delivers pointermoves from a second contact (palm, other thumb,
      // gesture-recogniser stragglers) to the captured canvas, and
      // computing the pan delta against the original `_panStart` from
      // a different pointer's clientX yanks the camera back toward that
      // finger's position — the "jumpy / undoes the last drag" report
      // on iPad. Mac mouse drags only ever fire one pointer so the
      // bug was invisible there.
      if (this._panPointerId !== null && e.pointerId !== this._panPointerId) return;
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      // Gutter mode: vertical drag scrolls the host doc 1:1; horizontal
      // still pans camera.x. Camera.y tracks the live scrollTop so the
      // engine's viewport math sees the correct world rect.
      if (this.gutterScrollDOM) {
        this.gutterScrollDOM.scrollTop = (this._panStartScrollTop || 0) - dy;
        this.camera = { x: this._cameraStart.x + dx, y: this.gutterCameraOffset - this.gutterScrollDOM.scrollTop, zoom: 1 };
        this.notify("camera");
        return;
      }
      this.camera = { x: this._cameraStart.x + dx, y: this._cameraStart.y + dy, zoom: this._cameraStart.zoom, rotation: this._cameraStart.rotation };
      this.notify("camera");
      return;
    }

    // A live split-line drag, grab-band sweep, or pending touch tap owns
    // the pointer.
    if (this.splitDrag || this.grabBandDrag || this.splitTapPending) {
      splitPointerMove(this, screenPt, canvasPt, { x: e.clientX, y: e.clientY });
      return;
    }
    // Otherwise the same call just maintains the tool preview line and
    // the split-line hover, both of which are meaningless while another
    // gesture is mid-flight — so it's skipped rather than fighting for
    // the frame.
    if (!this._isDragging && !this._isResizing && !this._pocketDragPending
      && !this.selectionBox && !this.creatingDragArea) {
      splitPointerMove(this, screenPt, canvasPt, { x: e.clientX, y: e.clientY });
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
    // shelf edge. Fully hidden at > 300px, fully visible once the cursor is
    // inside the drop zone right of the shelf strip.
    if (this._isDragging && this.selectedIds.size > 0) {
      const POCKET_PROXIMITY_RANGE = 300;
      const shelfEdge = (this.canvasEl?.clientWidth || window.innerWidth) - this.pocketRightInset;
      const cursorFromPocket = shelfEdge - screenPt.x;
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
      // Finger drag started on empty canvas: nothing moves until the
      // contact has really travelled. Measured in client px because the
      // canvas-space threshold below is world units — at low zoom a
      // pixel of finger wobble is several world px.
      const tsd = this._touchSelectDrag;
      if (tsd && !tsd.moved) {
        const cdx = e.clientX - tsd.client.x;
        const cdy = e.clientY - tsd.client.y;
        if (cdx * cdx + cdy * cdy < TOUCH_SELECT_SLOP_2) return;
        tsd.moved = true;
      }
      const dx = canvasPt.x - this._dragStart.x;
      const dy = canvasPt.y - this._dragStart.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        this._dragStart = canvasPt;
        // Fire the deferred onShapeDragStart (unpocket drags defer
        // it so the shim bridges the pocket-exit before pausing).
        if (!this._dragStartFired) this._beginShapeDrag();
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
        // Hoisted for the whole move: the drop-target probe below wants
        // it too, and this runs on every pointer sample of a drag.
        const inert = this._inertLayerIds();
        // Flowchart descendants of any selected node move with the
        // selection so the downstream spatial layout stays intact —
        // unless the host opted out (derived chains, see the switch).
        const flowDescendants = new Set<string>();
        if (this.flowDragDescendants) {
          for (const id of this.selectedIds) {
            for (const d of this.flowchart.descendantsOf(id)) flowDescendants.add(d);
          }
          // A descendant on a hidden or locked layer is dropped from the
          // set: the edge may predate the lock, but the lock means "this
          // doesn't move", and a chart drag is no more entitled to move
          // it than a direct one is. Its own descendants still follow —
          // the lock is on the shape, not on the subtree below it. One
          // pass over the shapes rather than a lookup per descendant,
          // and skipped outright when nothing is locked or hidden.
          if (inert.size > 0 && flowDescendants.size > 0) {
            for (const sh of this.shapes) {
              if (flowDescendants.has(sh.id) && this._isShapeInert(sh, inert)) {
                flowDescendants.delete(sh.id);
              }
            }
          }
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
            if (this._isShapeInert(sh, inert)) continue;
            if (sh.groupId && followingGroups.has(sh.groupId)) flowDescendants.add(sh.id);
          }
        }
        const previewed = this._engineDragIds;
        this.shapes = this.shapes.map((s) => {
          // Strokes riding the engine's preview transform hold still in
          // the data model — the engine is drawing them at the offset
          // and bakes the total on release. Rewriting every point every
          // frame produced nothing anyone reads (stroke selections draw
          // no Hush-side chrome) and is the whole cost difference
          // against the engine-driven drag.
          if (previewed && previewed.has(s.id)) return s;
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
        // While dragging shape(s), keep the flowchart drop-target hover
        // up to date so the renderer can outline the prospective parent.
        // Uses the live cursor for multi-drag so it still reads naturally
        // when many shapes are being moved at once. All shape types are
        // flowable now (drag-areas, images, drawings, text), so the
        // probe scans every shape — not just text.
        // Reorder mode pre-empts the flowchart drop path entirely, so
        // skip the hover probe to avoid showing a misleading
        // "prospective parent" outline during a swap drag.
        const draggingIds: string[] = [];
        if (!this.reorderDragAreaId) {
          for (const s of this.shapes) {
            if (this.selectedIds.has(s.id)) draggingIds.push(s.id);
          }
        }
        if (draggingIds.length > 0) {
          let probe: Point;
          let exclude: string;
          if (draggingIds.length === 1) {
            const id = draggingIds[0];
            const sh = this.shapes.find((s) => s.id === id)!;
            const b = getShapeBounds(sh, this.fontFamily);
            probe = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
            exclude = id;
          } else {
            probe = canvasPt;
            exclude = "";
          }
          const draggingSet = new Set(draggingIds);
          // Group siblings of any dragged shape are not valid flow
          // targets — see the matching exclusion in the drop handler.
          const draggingGroupIds = new Set<string>();
          for (const id of draggingIds) {
            const sh = this.shapes.find((s) => s.id === id);
            if (sh?.groupId) draggingGroupIds.add(sh.groupId);
          }
          let target: Shape | null = null;
          for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if (draggingSet.has(s.id)) continue;
            if (s.id === exclude) continue;
            if (s.pocketed) continue;
            // Nothing on a hidden or locked layer is a drop target, so
            // don't outline one as a prospective parent either — the
            // drop handler would refuse it (`isFlowable`) and the
            // outline would be a promise the release can't keep.
            if (this._isShapeInert(s, inert)) continue;
            if (s.groupId && draggingGroupIds.has(s.groupId)) continue;
            const bb = this._probeBounds(s, flowDescendants, selectedDragAreaIds);
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
        // Reorder mode runs its own hover probe so the ghost preview
        // updates every frame the cursor moves over a sibling-child.
        // Lives outside the flowchart-only `draggingIds` branch since
        // reorder mode intentionally empties that list — the probe
        // still needs to fire on every move.
        if (this.reorderDragAreaId && this._reorderOrigBounds.size > 0) {
          this._handleReorderHover(canvasPt);
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
      const edge = this.flowEdgesLocked
        ? null
        : this.flowchart.findEdgeNear(canvasPt, this.shapes, threshold);
      const newId = edge ? edge.id : null;
      if (newId !== this.flowHoveredEdgeId) {
        this.flowHoveredEdgeId = newId;
        // Repaint-only: the badge is hover chrome, not content. Keying
        // this "shapes" marked the notebook dirty (and triggered a full
        // autosave serialize) every time the cursor crossed an edge.
        this.notify("flowHoveredEdgeId");
      }
    }
  }

  handlePointerUp(e: PointerEvent) {
    // Gesture finished cleanly — drop the touch selection snapshot so
    // the next interaction starts fresh. (A multi-touch promotion
    // would have called cancelActiveInteraction first, which already
    // consumed and cleared the snapshot.)
    this._preTouchSelectedIds = null;

    if (this.splitDrag || this.grabBandDrag || this.splitTapPending) {
      const rect = this.canvasEl?.getBoundingClientRect();
      const screenPt = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
      const worldPt = screenPt ? screenToCanvas(screenPt, this.camera) : undefined;
      if (splitPointerUp(this, screenPt, worldPt, e.pointerType)) return;
    }

    if (this._isPanningActive) {
      // Only the pointer that started the pan can end it. A stray
      // pointerup from a non-tracked contact otherwise drops the pan
      // mid-drag.
      if (this._panPointerId !== null && e.pointerId !== this._panPointerId) return;
      this._isPanningActive = false;
      this._panPointerId = null;
      return;
    }

    // Pocket drag pending: click without movement — just select, no move
    if (this._pocketDragPending) {
      this._pocketDragPending = false;
      return;
    }

    if (this._isDragging) {
      this._isDragging = false;
      // A finger that grabbed the selection from empty canvas and let go
      // without travelling is a tap — the deselect gesture. Resolved
      // after the drag teardown below so the two can't half-apply.
      const touchTap = !!this._touchSelectDrag && !this._touchSelectDrag.moved;
      this._touchSelectDrag = null;
      // Only calls onShapeDragEnd if a start actually fired — a
      // pocket-exit that never reached a real drag move shouldn't
      // emit an end with no start.
      this._endShapeDrag();
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

      // Reorder mode: a drag of one or more children of the active
      // reorder drag-area resolves either as a positional swap (dropped
      // on another child) or a snap-back to the pre-drag location
      // (dropped anywhere else). Either way we pre-empt re-parenting
      // and the flowchart drop path so dragging in reorder mode stays
      // a pure reordering gesture.
      if (this.reorderDragAreaId && this._reorderOrigBounds.size > 0) {
        this._handleReorderDrop(e);
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
      // Collect every dropped flowable shape (all types qualify now, not
      // just text). When the dragged selection is a single group, treat
      // the group as one node — connect via a single lead member and
      // translate every group sibling by the same delta so the group
      // stays intact.
      const droppedIds: string[] = [];
      for (const s of this.shapes) {
        if (this.selectedIds.has(s.id) && this.flowchart.isFlowable(s)) {
          droppedIds.push(s.id);
        }
      }
      if (droppedIds.length > 0) {
        const droppedSet = new Set(droppedIds);
        // Group siblings of any dropped shape are not valid flow
        // targets — double-clicking a stroke out of a group lets the
        // user reposition it inside its own group, and dropping it on
        // a sibling shouldn't promote that sibling to a parent.
        const droppedGroupIds = new Set<string>();
        for (const id of droppedIds) {
          const sh = this.shapes.find((s) => s.id === id);
          if (sh?.groupId) droppedGroupIds.add(sh.groupId);
        }
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
            if (s.pocketed) continue;
            if (!this.flowchart.isFlowable(s)) continue;
            if (s.groupId && droppedGroupIds.has(s.groupId)) continue;
            // Grouped shapes (stroke clusters in particular) test
            // against the group's union, not the individual member's
            // own bounds. Without this, a drop inside a sparse stroke
            // group's bounding box could miss every stroke and find
            // no target. Non-grouped shapes use their own bounds.
            const b = s.groupId
              ? this.unionGroupBounds(s)
              : getShapeBounds(s, this.fontFamily);
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
          // For stroke groups (and any other grouped shape), the
          // flowchart's logical "node" is the *group*, not the
          // individual stroke under the cursor. Promote the target
          // to the group's lead member so the resulting edge is
          // stable: future renders anchor against the union via
          // unionGroupBounds, and removing any one stroke from the
          // cluster won't orphan the arrow because the lead is the
          // last (topmost) stroke in the group's draw order.
          if (target && target.groupId) {
            const groupId = target.groupId;
            let lead: Shape | null = null;
            for (let i = this.shapes.length - 1; i >= 0; i--) {
              if (this.shapes[i].groupId === groupId) { lead = this.shapes[i]; break; }
            }
            if (lead) target = lead;
          }
        }

        // Detect "single group" — every dropped id shares one groupId.
        // We connect via the topmost member and translate the whole
        // group as a unit so a group is functionally one flow node.
        let connectIds = droppedIds;
        let groupSiblingsByDropped = new Map<string, Set<string>>();
        if (droppedIds.length > 1) {
          const sample = this.shapes.find((s) => s.id === droppedIds[0]);
          const gid = sample?.groupId;
          if (gid && droppedIds.every((id) => {
            const sh = this.shapes.find((s) => s.id === id);
            return !!sh && sh.groupId === gid;
          })) {
            const lead = droppedIds[droppedIds.length - 1];
            connectIds = [lead];
            groupSiblingsByDropped.set(lead, new Set(droppedIds));
          }
        }

        if (target) {
          const appendMode = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
          // Append-merge is text→text only. For non-text targets we
          // fall through to the normal flow-connect path so the
          // modifier doesn't silently destroy the dropped shapes.
          const allText = target.type === "text" && droppedIds.every((id) => {
            const s = this.shapes.find((sh) => sh.id === id);
            return s?.type === "text";
          });
          if (appendMode && allText) {
            // Concatenate dropped texts in stack order and merge into target.
            const targetId = target.id;
            const appended: string[] = [];
            for (const id of droppedIds) {
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
            for (const id of droppedIds) this.flowchart.removeNode(id);
            this.selectedIds = new Set([targetId]);
            this.notify("selectedIds");
          } else {
            for (const droppedId of connectIds) {
              const dropped = this.shapes.find((s) => s.id === droppedId);
              if (!dropped) continue;
              const oldBounds = getShapeBounds(dropped, this.fontFamily);
              const newTL = this.flowchart.tryConnect(droppedId, target.id, this.shapes);
              if (!newTL) continue;
              const dx = newTL.minX - oldBounds.minX;
              const dy = newTL.minY - oldBounds.minY;
              const movers = new Set<string>([droppedId]);
              // Pull every sibling of the dropped shape's group so a
              // group of strokes (or a mixed group) stays glued
              // together through the snap.
              const groupSiblings = groupSiblingsByDropped.get(droppedId);
              if (groupSiblings) {
                for (const id of groupSiblings) movers.add(id);
              } else if (dropped.groupId) {
                for (const sh of this.shapes) {
                  if (sh.groupId === dropped.groupId) movers.add(sh.id);
                }
              }
              this.shapes = this.shapes.map((s) =>
                movers.has(s.id) ? moveShape(s, dx, dy) : s,
              );
              // Snapping the parent also pulls its descendants — replay their
              // existing offset so the chain stays intact. Grouped descendants
              // bring the rest of their group along so the group doesn't get
              // torn apart by the snap.
              const snapInert = this._inertLayerIds();
              const desc = new Set<string>();
              for (const id of this.flowchart.descendantsOf(droppedId)) {
                const sh = this.shapes.find((s) => s.id === id);
                if (sh && this._isShapeInert(sh, snapInert)) continue;
                desc.add(id);
              }
              if (desc.size > 0) {
                const groups = new Set<string>();
                for (const id of desc) {
                  const sh = this.shapes.find((s) => s.id === id);
                  if (sh?.groupId) groups.add(sh.groupId);
                }
                if (groups.size > 0) {
                  for (const sh of this.shapes) {
                    if (this._isShapeInert(sh, snapInert)) continue;
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

      // The tap that ends a finger's grab on the selection: nothing
      // moved, so there's no shape change to record — just drop the
      // selection. Skipping recordHistory here also keeps a tap from
      // spending an undo step on a no-op checkpoint.
      if (touchTap) {
        this.selectedIds = new Set();
        this.notify("selectedIds");
        return;
      }

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
      // The marquee is just a 4-point region — same hit test the
      // pen-mode lasso and finger marquee run (selection-region.ts),
      // so all three agree on what "inside" means for every shape type.
      const box = normalizeBox(this.selectionBox);
      const poly = rectPolygon({ x: box.minX, y: box.minY }, { x: box.maxX, y: box.maxY });
      this.selectionBox = null;
      this._selectStart = null;
      this.selectShapesInRegion(poly, { additive: e.shiftKey });
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
          createdAt: Date.now(),
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

  /** Select every shape a world-space region polygon touches — the one
   *  entry point behind all three sweep gestures (Select-tool marquee,
   *  pen-mode finger marquee, pen-mode lasso). Returns how many shapes
   *  the region hit so the caller can treat "nothing" as a dismissal;
   *  the drawing layer uses that to drop the user back into their brush.
   *
   *  Hit rules and group promotion live in selection-region.ts. */
  selectShapesInRegion(poly: Point[], opts?: { additive?: boolean }): number {
    const hits = collectShapesInPolygon(this.shapes, poly, {
      fontFamily: this.fontFamily,
      inertLayerIds: this._inertLayerIds(),
    });
    if (opts?.additive) {
      const next = new Set(this.selectedIds);
      for (const id of hits) next.add(id);
      this.selectedIds = next;
    } else {
      this.selectedIds = hits;
    }
    this.notify("selectedIds");
    return hits.size;
  }

  /** Snapshot of the non-stroke shapes an engine-driven bbox drag has
   *  to carry. Strokes ride the engine's preview transform; everything
   *  else is repositioned from this snapshot on each tick, so the two
   *  halves of a mixed selection stay locked together. */
  private _extMoveSnapshot: Map<string, Shape> | null = null;
  private _extMoveDirty = false;

  /** Begin an engine-driven move of the current selection (the user
   *  grabbed the stroke engine's bbox in pen mode). */
  beginExternalMove(): void {
    const areaIds = new Set<string>();
    for (const s of this.shapes) {
      if (this.selectedIds.has(s.id) && s.type === "drag-area") areaIds.add(s.id);
    }
    const snap = new Map<string, Shape>();
    for (const s of this.shapes) {
      if (s.type === "draw" || s.pocketed) continue;
      if (this.selectedIds.has(s.id) || (s.parentId && areaIds.has(s.parentId))) snap.set(s.id, s);
    }
    this._extMoveSnapshot = snap.size > 0 ? snap : null;
    this._extMoveDirty = false;
  }

  /** Apply the total offset of an engine-driven move. Absolute from the
   *  snapshot rather than incremental, so a dropped frame can't drift. */
  updateExternalMove(dx: number, dy: number): void {
    const snap = this._extMoveSnapshot;
    if (!snap) return;
    if (dx === 0 && dy === 0 && !this._extMoveDirty) return;
    this._extMoveDirty = true;
    this.shapes = this.shapes.map((s) => {
      const orig = snap.get(s.id);
      return orig ? moveShape(orig, dx, dy) : s;
    });
    this.notify("shapes");
  }

  /** Finish an engine-driven move. `cancelled` (a multi-touch gesture
   *  claimed the burst mid-drag) puts the shapes back where they
   *  started — the engine rolls its stroke preview back the same way,
   *  and half a committed move is worse than none. */
  endExternalMove(cancelled = false): void {
    const snap = this._extMoveSnapshot;
    const moved = this._extMoveDirty;
    if (!snap) return;
    this._extMoveSnapshot = null;
    this._extMoveDirty = false;
    if (!moved) return;
    if (cancelled) {
      this.shapes = this.shapes.map((s) => snap.get(s.id) || s);
      this.notify("shapes");
      return;
    }
    // The engine commits its own stroke transform first and records
    // history from that callback — a second checkpoint here would cost
    // the user two undos for one drag. Only record when the selection
    // was pure non-stroke shapes, which the engine never touches.
    for (const s of this.shapes) {
      if (s.type === "draw" && this.selectedIds.has(s.id)) return;
    }
    this.recordHistory();
  }

  /** Fire the drag-start hook and record what the drawing engine took
   *  over. While the engine previews strokes, Hush's own chrome for them
   *  is suppressed (`strokeEngineDragging`) — that also parks the
   *  selection bridge, which would otherwise recompute the engine bbox
   *  from every selected point on every frame of the drag. */
  private _beginShapeDrag(): void {
    this._dragStartFired = true;
    const adopted = this.onShapeDragStart?.(this.selectedIds);
    this._engineDragIds = adopted && adopted.size > 0 ? adopted : null;
    if (this._engineDragIds && !this.strokeEngineDragging) {
      this.strokeEngineDragging = true;
      this.notify("strokeEngineDragging");
    }
  }

  /** Tear down a shape drag: fire the end hook, release the engine
   *  preview bookkeeping, and drop the per-drag bounds cache. */
  private _endShapeDrag(): void {
    if (this._dragStartFired && this.onShapeDragEnd) this.onShapeDragEnd();
    this._dragStartFired = false;
    this._dragProbeBounds = null;
    // Only unset the flag if this drag was the one that set it — an
    // engine-driven transform owns it independently.
    const owned = this._engineDragIds !== null;
    this._engineDragIds = null;
    if (owned && this.strokeEngineDragging) {
      this.strokeEngineDragging = false;
      this.notify("strokeEngineDragging");
    }
  }

  /** Bounds for the drop-target probe. Anything actually moving this
   *  frame is measured live; everything else comes from the per-drag
   *  cache, so the probe costs one pass over the notebook per drag
   *  instead of one per frame. Selected shapes never reach here (the
   *  probe skips them), but flowchart descendants and the children of a
   *  dragged drag-area do — and they move, so they can't be cached. */
  private _probeBounds(shape: Shape, flowDescendants: Set<string>, draggedAreaIds: Set<string>): Bounds {
    if (flowDescendants.has(shape.id)) return getShapeBounds(shape, this.fontFamily);
    if (shape.parentId && draggedAreaIds.has(shape.parentId)) return getShapeBounds(shape, this.fontFamily);
    let cache = this._dragProbeBounds;
    if (!cache) { cache = new Map(); this._dragProbeBounds = cache; }
    let b = cache.get(shape.id);
    if (!b) { b = getShapeBounds(shape, this.fontFamily); cache.set(shape.id, b); }
    return b;
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
      this._touchSelectDrag = null;
      this._endShapeDrag();
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
    // A split-line drag promoted into a two-finger pan commits whatever
    // it moved rather than snapping back — the content and the line are
    // already consistent, and rewinding a half-finished concertina is
    // more surprising than keeping it.
    if (this.splitDrag || this.grabBandDrag || this.splitHover || this.splitTapPending) {
      // A pending touch tap is abandoned outright — the second finger
      // that triggered this is a pan, not a cut.
      this.splitTapPending = null;
      splitPointerUp(this);
      if (this.splitHover) this.splitHover = null;
      changed = true;
    }
    if (this._isPanningActive) {
      this._isPanningActive = false;
      this._panPointerId = null;
      changed = true;
    }
    // Repaint-only notify. Every branch above either reset transient
    // gesture state or already fired its own precise key (selectedIds,
    // selectionBox, creatingDragArea) — no shape content changed here.
    // This used to be notify("shapes"), which meant EVERY two-finger
    // pan flick (whose first finger arms a marquee / drag / resize
    // before the second finger promotes the gesture) marked the
    // notebook content-dirty: the autosave then ran a full multi-MB
    // envelope serialize at the next pause — the felt "pan freezes for
    // a second" hitch on stroke-heavy notebooks. Note a drag that got
    // far enough to actually move shapes (>1 px before the second
    // finger landed) has already fired real "shapes" notifies from its
    // move handler; those are genuine content changes and still save.
    if (changed) this.notify("interaction");
  }

  handleWheel(e: WheelEvent) {
    // A horizontal-dominant scroll belongs to the host when this canvas
    // is one column of something scrollable — a stack, a pane. On the
    // main canvas there is no host to give it to, so it pans instead.
    // Shift is exempt: it means "pin this canvas to its current axis",
    // and the platform's deltaY→deltaX remap would otherwise hand every
    // shift-held vertical swipe straight to the host.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.shiftKey && !this.gutterScrollDOM && this.paneHosted) return;
    e.preventDefault();
    if (!this.canvasEl) return;
    // Gutter mode: redirect the wheel into the host doc's scroller so
    // the canvas + doc stay in lockstep, and apply horizontal delta to
    // camera.x so trackpad horizontal-swipes still pan the canvas
    // sideways. Zoom is disabled — a Mac trackpad pinch fires wheel
    // events with ctrlKey=true and a synthetic deltaY representing the
    // pinch amount; we drop those so they don't yank the doc scroll.
    if (this.gutterScrollDOM) {
      if (e.ctrlKey) return;
      let camX = this.camera.x;
      if (e.deltaY) this.gutterScrollDOM.scrollTop += e.deltaY;
      if (e.deltaX) camX = this.camera.x - e.deltaX;
      // Atomic update — read the live scrollTop after our write (it
      // may have been clamped) so camera.y matches the visible slice.
      this.camera = { x: camX, y: this.gutterCameraOffset - this.gutterScrollDOM.scrollTop, zoom: 1 };
      this.notify("camera");
      return;
    }
    // The wheel scrolls; ⌘ (or a trackpad pinch, which WebKit reports as
    // a ctrl-wheel) zooms. A canvas is still a document to read, and the
    // reflex a mouse wheel carries in from every other surface in the
    // app — including the PDF this proof came from — is "move down the
    // page". Zoom stays on the modifier, where the rest of the platform
    // puts it. Deltas apply 1:1 like a doc scroller, with the line /
    // page delta modes converted so a notched wheel moves a sane amount.
    if (!e.metaKey && !e.ctrlKey) {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (this.canvasEl.clientHeight || 800) : 1;
      let dx = e.deltaX, dy = e.deltaY;
      // Shift pins the pan to the axis the user is already travelling on
      // and holds it there until shift comes back up.
      //
      // The axis comes from the last un-modified scroll, NOT from
      // whichever delta component is larger right now. Platforms remap a
      // shift-held scroll from deltaY into deltaX — iPadOS does it for
      // trackpad swipes as well as wheels — so reading the live deltas
      // makes shift *switch* the axis instead of pinning it: a vertical
      // swipe starts running sideways the moment the modifier goes down.
      // Whichever component carries the magnitude is fed to the locked
      // axis, so the remap is transparent.
      if (e.shiftKey) {
        if (!this._wheelAxisLock) this._wheelAxisLock = this._lastScrollAxis;
        const mag = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        if (this._wheelAxisLock === "x") { dx = mag; dy = 0; }
        else { dy = mag; dx = 0; }
      } else {
        // Belt and braces: a keyup missed while the window was unfocused
        // would otherwise strand the lock.
        if (this._wheelAxisLock) this._wheelAxisLock = null;
        if (Math.abs(dx) > Math.abs(dy)) this._lastScrollAxis = "x";
        else if (Math.abs(dy) > Math.abs(dx)) this._lastScrollAxis = "y";
      }
      this.camera = {
        ...this.camera,
        x: this.camera.x - dx * k,
        y: this.camera.y - dy * k,
      };
      this.notify("camera");
      return;
    }
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
    // Pivot-zoom scales the camera-relative screen vector uniformly, so
    // it stays correct under a rotated camera — carry rotation through.
    this.camera = {
      x: mouseX - scale * (mouseX - this.camera.x),
      y: mouseY - scale * (mouseY - this.camera.y),
      zoom: newZoom,
      rotation: this.camera.rotation,
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

  /** Snapshot the full pre-drag bounds of every selected child of the
   *  active reorder drag-area. Captured at pointerDown so the drop
   *  handler can swap (dragged ↔ target) or restore (drop in empty
   *  space) using positions that don't drift as the drag moves, and so
   *  the ghost-preview overlay can paint same-sized outlines at both
   *  endpoints. */
  private _captureReorderOrigins() {
    this._reorderOrigBounds.clear();
    if (!this.reorderDragAreaId) return;
    for (const s of this.shapes) {
      if (this.selectedIds.has(s.id) && s.parentId === this.reorderDragAreaId) {
        this._reorderOrigBounds.set(s.id, { ...getShapeBounds(s, this.fontFamily) });
      }
    }
  }

  /** Snap every dragged child back to the pre-drag bounds captured by
   *  `_captureReorderOrigins`. Used by the drop handler when the
   *  gesture isn't a clean single-unit-onto-single-unit swap (drop in
   *  empty canvas, incoherent multi-select, etc.). */
  private _restoreReorderOrigins() {
    this.shapes = this.shapes.map((s) => {
      const orig = this._reorderOrigBounds.get(s.id);
      if (!orig) return s;
      const b = getShapeBounds(s, this.fontFamily);
      return moveShape(s, orig.minX - b.minX, orig.minY - b.minY);
    });
  }

  /** Hit-test the cursor against every sibling-child of the active
   *  reorder drag-area. Updates `reorderHoverTargetId` and the matching
   *  `reorderPreview` ghost rectangles. Called from `handlePointerMove`
   *  while a reorder drag is in flight; cheap enough to run every
   *  frame (one parent-id filter + axis-aligned bbox test per shape). */
  private _handleReorderHover(canvasPt: Point) {
    if (!this.reorderDragAreaId || this._reorderOrigBounds.size === 0) return;
    const draggedIds = new Set(this._reorderOrigBounds.keys());
    let hit: Shape | null = null;
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (draggedIds.has(s.id)) continue;
      if (s.parentId !== this.reorderDragAreaId) continue;
      const b = getShapeBounds(s, this.fontFamily);
      if (canvasPt.x >= b.minX && canvasPt.x <= b.maxX && canvasPt.y >= b.minY && canvasPt.y <= b.maxY) {
        hit = s;
        break;
      }
    }
    const newId = hit?.id ?? null;
    if (newId === this.reorderHoverTargetId) return;
    this.reorderHoverTargetId = newId;
    this._recomputeReorderPreview();
    this.notify("reorderHoverTargetId");
    this.notify("reorderPreview");
  }

  /** Bucket every child of the active reorder drag-area into units (one
   *  unit per ungrouped shape, one unit per `groupId`) and sort by
   *  reading order — top-to-bottom, left-to-right with a 60%-of-the-
   *  tallest-unit row-band tolerance. Each unit's bounds use the
   *  pre-drag original for any dragged member (`_reorderOrigBounds`),
   *  current live bounds otherwise, so slots stay anchored to where
   *  units sat at pointerDown even while a drag is mid-flight. */
  private _collectReorderUnits(): { ids: string[]; bounds: Bounds }[] {
    if (!this.reorderDragAreaId) return [];
    const children = this.shapes.filter((s) => s.parentId === this.reorderDragAreaId);
    const ungrouped: Shape[] = [];
    const groupBuckets = new Map<string, Shape[]>();
    for (const s of children) {
      if (s.groupId) {
        let bucket = groupBuckets.get(s.groupId);
        if (!bucket) { bucket = []; groupBuckets.set(s.groupId, bucket); }
        bucket.push(s);
      } else {
        ungrouped.push(s);
      }
    }
    const effectiveBounds = (s: Shape): Bounds => {
      const orig = this._reorderOrigBounds.get(s.id);
      return orig ? orig : getShapeBounds(s, this.fontFamily);
    };
    const unionOf = (shapes: Shape[]): Bounds => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of shapes) {
        const b = effectiveBounds(s);
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
      return { minX, minY, maxX, maxY };
    };
    const units: { ids: string[]; bounds: Bounds }[] = [];
    for (const s of ungrouped) units.push({ ids: [s.id], bounds: effectiveBounds(s) });
    for (const shapes of groupBuckets.values()) units.push({ ids: shapes.map((s) => s.id), bounds: unionOf(shapes) });
    let maxH = 0;
    for (const u of units) maxH = Math.max(maxH, u.bounds.maxY - u.bounds.minY);
    const tol = Math.max(maxH * 0.6, 1);
    units.sort((a, b) => {
      const dy = a.bounds.minY - b.bounds.minY;
      if (Math.abs(dy) > tol) return dy;
      return a.bounds.minX - b.bounds.minX;
    });
    return units;
  }

  /** Recompute the ghost preview for the live reorder hover. Both
   *  dragged + target are expanded to their full group footprint so
   *  the preview shows the cluster that will actually move on drop;
   *  positioned shape clones are baked at the destinations so the
   *  renderer can paint actual contents (text, images, strokes) at
   *  reduced opacity. In swap mode the ghost shows the two units
   *  trading slots; in ripple mode it shows the dragged unit at the
   *  target's slot and the target shifted by one slot toward the
   *  dragged unit's old position. Cached at hover-change time and
   *  left untouched while the cursor stays over the same target. */
  private _recomputeReorderPreview() {
    if (!this.reorderHoverTargetId) { this.reorderPreview = null; return; }
    const target = this.shapes.find((s) => s.id === this.reorderHoverTargetId);
    if (!target) { this.reorderPreview = null; return; }
    const targetSet = target.groupId
      ? this.shapes.filter((s) => s.groupId === target.groupId)
      : [target];
    let tMinX = Infinity, tMinY = Infinity, tMaxX = -Infinity, tMaxY = -Infinity;
    for (const s of targetSet) {
      const b = getShapeBounds(s, this.fontFamily);
      if (b.minX < tMinX) tMinX = b.minX;
      if (b.minY < tMinY) tMinY = b.minY;
      if (b.maxX > tMaxX) tMaxX = b.maxX;
      if (b.maxY > tMaxY) tMaxY = b.maxY;
    }
    let dMinX = Infinity, dMinY = Infinity, dMaxX = -Infinity, dMaxY = -Infinity;
    for (const b of this._reorderOrigBounds.values()) {
      if (b.minX < dMinX) dMinX = b.minX;
      if (b.minY < dMinY) dMinY = b.minY;
      if (b.maxX > dMaxX) dMaxX = b.maxX;
      if (b.maxY > dMaxY) dMaxY = b.maxY;
    }
    const dW = dMaxX - dMinX, dH = dMaxY - dMinY;
    const tW = tMaxX - tMinX, tH = tMaxY - tMinY;

    // Where the target unit lands. Swap mode → dragged's pre-drag TL.
    // Ripple mode → the slot immediately adjacent to its current slot
    // in the reading-order direction of the dragged unit's old slot.
    let bMinX = dMinX, bMinY = dMinY;
    if (this.reorderMode === "ripple") {
      const units = this._collectReorderUnits();
      const draggedIdSet = new Set(this._reorderOrigBounds.keys());
      const D = units.findIndex((u) => u.ids.some((id) => draggedIdSet.has(id)));
      const T = units.findIndex((u) => u.ids.includes(target.id));
      if (D >= 0 && T >= 0 && D !== T) {
        const adjacent = D < T ? units[T - 1] : units[T + 1];
        if (adjacent) { bMinX = adjacent.bounds.minX; bMinY = adjacent.bounds.minY; }
      }
    }

    const dxD = tMinX - dMinX, dyD = tMinY - dMinY;
    const dxT = bMinX - tMinX, dyT = bMinY - tMinY;
    const draggedShapes: Shape[] = [];
    for (const id of this._reorderOrigBounds.keys()) {
      const live = this.shapes.find((x) => x.id === id);
      if (!live) continue;
      const orig = this._reorderOrigBounds.get(id)!;
      const curr = getShapeBounds(live, this.fontFamily);
      const dx = (orig.minX + dxD) - curr.minX;
      const dy = (orig.minY + dyD) - curr.minY;
      draggedShapes.push(moveShape({ ...live }, dx, dy));
    }
    const targetShapes: Shape[] = [];
    for (const s of targetSet) {
      targetShapes.push(moveShape({ ...s }, dxT, dyT));
    }
    this.reorderPreview = {
      ghostA: { minX: tMinX, minY: tMinY, maxX: tMinX + dW, maxY: tMinY + dH },
      ghostB: { minX: bMinX, minY: bMinY, maxX: bMinX + tW, maxY: bMinY + tH },
      draggedShapes,
      targetShapes,
    };
  }

  /** Resolve a drop while reorder mode is active. A coherent dragged
   *  unit (single shape, or every selected shape sharing one groupId)
   *  dropped onto another sibling-child either swaps the two units in
   *  place (`reorderMode === "swap"`) or shuffles the dragged unit
   *  into the target's reading-order slot, rippling intermediate units
   *  by one (`reorderMode === "ripple"`). Any other outcome
   *  (incoherent dragged selection, drop on empty canvas, drop on a
   *  non-sibling) snaps every dragged child back to its captured
   *  origin. Either way one history entry is recorded. */
  private _handleReorderDrop(e: PointerEvent) {
    const draggedIds = Array.from(this._reorderOrigBounds.keys());
    if (draggedIds.length === 0) {
      this._reorderOrigBounds.clear();
      this.flowDropTargetId = null;
      return;
    }
    const draggedSet = new Set(draggedIds);
    const draggedShapes = this.shapes.filter((s) => draggedSet.has(s.id));
    const dGid = draggedShapes[0]?.groupId;
    const isCoherent = draggedIds.length === 1
      || (!!dGid && draggedShapes.every((s) => s.groupId === dGid));

    let target: Shape | null = null;
    if (isCoherent && this.canvasEl) {
      const r = this.canvasEl.getBoundingClientRect();
      const dropPt = screenToCanvas(
        { x: e.clientX - r.left, y: e.clientY - r.top },
        this.camera,
      );
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        if (draggedSet.has(s.id)) continue;
        if (s.parentId !== this.reorderDragAreaId) continue;
        const b = getShapeBounds(s, this.fontFamily);
        if (dropPt.x >= b.minX && dropPt.x <= b.maxX && dropPt.y >= b.minY && dropPt.y <= b.maxY) {
          target = s;
          break;
        }
      }
    }

    if (isCoherent && target) {
      if (this.reorderMode === "ripple") {
        this._applyRippleReorder(target);
      } else {
        this._applySwapReorder(target, draggedSet);
      }
    } else {
      this._restoreReorderOrigins();
    }
    this._reorderOrigBounds.clear();
    this.reorderHoverTargetId = null;
    this.reorderPreview = null;
    this.flowDropTargetId = null;
    this.recordHistory();
    this.notify("shapes");
    this.notify("reorderHoverTargetId");
    this.notify("reorderPreview");
  }

  /** Swap the dragged unit with the target unit. The dragged unit's
   *  pre-drag TL slides to the target unit's TL and vice versa;
   *  members of each unit translate by a shared delta so their
   *  internal layouts stay intact. */
  private _applySwapReorder(target: Shape, draggedSet: Set<string>) {
    const targetSet = target.groupId
      ? new Set(this.shapes.filter((s) => s.groupId === target.groupId).map((s) => s.id))
      : new Set<string>([target.id]);
    let dMinX = Infinity, dMinY = Infinity;
    for (const b of this._reorderOrigBounds.values()) {
      if (b.minX < dMinX) dMinX = b.minX;
      if (b.minY < dMinY) dMinY = b.minY;
    }
    let tMinX = Infinity, tMinY = Infinity;
    for (const s of this.shapes) {
      if (!targetSet.has(s.id)) continue;
      const b = getShapeBounds(s, this.fontFamily);
      if (b.minX < tMinX) tMinX = b.minX;
      if (b.minY < tMinY) tMinY = b.minY;
    }
    const dxD = tMinX - dMinX, dyD = tMinY - dMinY;
    const dxT = dMinX - tMinX, dyT = dMinY - tMinY;
    this.shapes = this.shapes.map((s) => {
      if (draggedSet.has(s.id)) {
        const orig = this._reorderOrigBounds.get(s.id)!;
        const b = getShapeBounds(s, this.fontFamily);
        return moveShape(s, (orig.minX + dxD) - b.minX, (orig.minY + dyD) - b.minY);
      }
      if (targetSet.has(s.id)) {
        return moveShape(s, dxT, dyT);
      }
      return s;
    });
  }

  /** Ripple-reorder: remove the dragged unit from its reading-order
   *  slot and re-insert it at the target unit's slot. Every unit
   *  between them shifts by one slot to close the gap; the dragged
   *  unit lands exactly where the target was, the target moves one
   *  slot toward the dragged unit's old position. Slot coordinates
   *  are taken from each unit's pre-drag bounds (collected by
   *  `_collectReorderUnits`) so the layout stays anchored to where
   *  units sat at pointerDown. */
  private _applyRippleReorder(target: Shape) {
    const units = this._collectReorderUnits();
    const draggedIdSet = new Set(this._reorderOrigBounds.keys());
    const D = units.findIndex((u) => u.ids.some((id) => draggedIdSet.has(id)));
    const T = units.findIndex((u) => u.ids.includes(target.id));
    if (D < 0 || T < 0 || D === T) { this._restoreReorderOrigins(); return; }
    const slots = units.map((u) => ({ minX: u.bounds.minX, minY: u.bounds.minY }));
    const newOrder = units.slice();
    const [moved] = newOrder.splice(D, 1);
    newOrder.splice(T, 0, moved);
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (let i = 0; i < newOrder.length; i++) {
      const u = newOrder[i];
      const dx = slots[i].minX - u.bounds.minX;
      const dy = slots[i].minY - u.bounds.minY;
      if (dx === 0 && dy === 0) continue;
      for (const id of u.ids) deltas.set(id, { dx, dy });
    }
    this.shapes = this.shapes.map((s) => {
      const d = deltas.get(s.id);
      if (!d) {
        // Dragged shape with zero unit-delta still needs to snap from
        // its live (mid-drag) bounds back onto its captured origin.
        if (draggedIdSet.has(s.id)) {
          const orig = this._reorderOrigBounds.get(s.id)!;
          const b = getShapeBounds(s, this.fontFamily);
          return moveShape(s, orig.minX - b.minX, orig.minY - b.minY);
        }
        return s;
      }
      if (draggedIdSet.has(s.id)) {
        // For dragged shapes the unit delta is relative to the captured
        // original, not the live (mid-drag) position. Bridge through
        // the original so the shape lands on its new slot regardless
        // of where the cursor left it.
        const orig = this._reorderOrigBounds.get(s.id)!;
        const b = getShapeBounds(s, this.fontFamily);
        return moveShape(s, (orig.minX + d.dx) - b.minX, (orig.minY + d.dy) - b.minY);
      }
      return moveShape(s, d.dx, d.dy);
    });
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
    if (this.flowDragDescendants) {
      for (const id of this.selectedIds) {
        for (const d of this.flowchart.descendantsOf(id)) ids.add(d);
      }
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

    // 20 px breathing room between the moving cluster's edge and the
    // expanded drag-area border so the wrapped shapes don't end up
    // flush against the dashed outline.
    const PAD = 20;
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
    // Desktop file thumbnails can't be deleted from the canvas — the
    // Desktop mirrors the filesystem, so only deleting the file itself
    // removes its thumbnail. Mixed selections still delete the rest.
    for (const s of this.shapes) {
      if ((s as ImageShape).fileRef && deletingIds.has(s.id)) deletingIds.delete(s.id);
    }
    if (deletingIds.size === 0) return;
    this.shapes = this.shapes
      .filter((s) => !deletingIds.has(s.id))
      .map((s) => s.parentId && deletingIds.has(s.parentId) ? { ...s, parentId: undefined } : s);
    // Drop any flowchart edges that referenced the deleted nodes.
    for (const id of deletingIds) this.flowchart.removeNode(id);
    // If the active reorder drag-area got deleted, exit the mode so we
    // don't keep painting a solid outline against a phantom id.
    if (this.reorderDragAreaId && deletingIds.has(this.reorderDragAreaId)) {
      this.reorderDragAreaId = null;
      this._reorderOrigBounds.clear();
      this.reorderHoverTargetId = null;
      this.reorderPreview = null;
      this.notify("reorderDragAreaId");
      this.notify("reorderHoverTargetId");
      this.notify("reorderPreview");
    }
    this.selectedIds = new Set();
    this.recordHistory();
    this.notify("shapes");
    this.notify("selectedIds");
  }

  /** Swap a set of shapes for a single ImageShape covering `bounds` —
   *  the commit half of "Rasterize group" (the raster itself is built
   *  by selection-raster.ts at 2×; sizing the image to the original
   *  bounding box scales it back down so it stays crisp). The image
   *  keeps a shared surviving drag-area parent and the topmost
   *  replaced shape's layer, and lands at the end of the shapes array
   *  (top of the stack) — where the eye already reads the selection,
   *  since it was frontmost while selected. One undo entry. */
  replaceShapesWithImage(ids: Set<string>, dataUrl: string, name: string, bounds: Bounds, dataUrlDark?: string) {
    const replaced = this.shapes.filter((s) => ids.has(s.id));
    if (replaced.length === 0) return;
    const sharedParent = replaced[0].parentId;
    const parentId = sharedParent && !ids.has(sharedParent)
      && replaced.every((s) => s.parentId === sharedParent)
      ? sharedParent : undefined;
    const layerId = replaced[replaced.length - 1].layerId || this.activeLayerId;
    const id = generateId();
    const img: ImageShape = {
      id, type: "image",
      position: { x: bounds.minX, y: bounds.minY },
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      dataUrl, name, color: "#000000",
      ...(dataUrlDark ? { dataUrlDark } : {}),
      parentId, layerId,
      createdAt: Date.now(),
    };
    this.shapes = [
      ...this.shapes
        .filter((s) => !ids.has(s.id))
        .map((s) => s.parentId && ids.has(s.parentId) ? { ...s, parentId: undefined } : s),
      img,
    ];
    // Rasterized text nodes leave the flowchart — images aren't flowable.
    for (const rid of ids) this.flowchart.removeNode(rid);
    if (this.reorderDragAreaId && ids.has(this.reorderDragAreaId)) this.exitReorderMode();
    this.selectedIds = new Set([id]);
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
      createdAt: Date.now(),
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

  changeSelectedBorder(color: string) {
    const ids = this.selectedIds;
    if (ids.size === 0) return;
    this.shapes = this.shapes.map((s) => {
      if (!ids.has(s.id)) return s;
      if (s.type !== "text" && s.type !== "drag-area") return s;
      if (color === "reset") return { ...s, borderColor: undefined, borderWidth: undefined };
      return { ...s, borderColor: color, borderWidth: (s as { borderWidth?: number }).borderWidth || 2 };
    });
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
   * Apply a saved text-style preset (color + backgroundColor + fontSize +
   * borderColor + borderWidth) to every selected text shape in one shot.
   * `color` is a hex string (the preset captures the resolved hex, bypassing
   * the named-palette lookup); `backgroundColor` is either a palette key, a
   * CSS string, or undefined to clear the background.
   */
  applyTextStyle(opts: { color: string; backgroundColor: string | undefined; fontSize: number; borderColor?: string; borderWidth?: number }) {
    this.shapes = this.shapes.map((s) => {
      if (!this.selectedIds.has(s.id)) return s;
      if (s.type !== "text") return s;
      return {
        ...s,
        color: opts.color,
        backgroundColor: opts.backgroundColor,
        fontSize: opts.fontSize,
        borderColor: opts.borderColor,
        borderWidth: opts.borderWidth,
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

  /** Arrange every direct child of the supplied drag-area into a grid
   *  centred on the drag-area itself, and resize the drag-area to fit
   *  loosely around the resulting cluster (100 px margin on every
   *  side). The drag-area both grows *and* shrinks here so that
   *  cycling the column count through the flyout doesn't leave behind
   *  oversized boundaries from a previous configuration. `cols` is
   *  forwarded to `arrangeShapesAsGrid`; when omitted the layout
   *  defaults to as-square-as-possible (`ceil(sqrt(n))`). */
  arrangeDragAreaAsGrid(dragAreaId: string, cols?: number) {
    const da = this.shapes.find((s) => s.id === dragAreaId);
    if (!da || da.type !== "drag-area") return;
    const children = this.shapes.filter((s) => s.parentId === dragAreaId);
    if (children.length < 2) return;
    const center: Point = {
      x: da.position.x + da.width / 2,
      y: da.position.y + da.height / 2,
    };
    const arranged = arrangeShapesAsGrid(children, this.fontFamily, 20, center, cols);
    const map = new Map(arranged.map((s) => [s.id, s]));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of arranged) {
      const b = getShapeBounds(s, this.fontFamily);
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    const PAD = 100;
    const newMinX = minX - PAD;
    const newMinY = minY - PAD;
    const newMaxX = maxX + PAD;
    const newMaxY = maxY + PAD;

    this.shapes = this.shapes.map((s) => {
      if (s.id === dragAreaId && s.type === "drag-area") {
        return { ...s, position: { x: newMinX, y: newMinY }, width: newMaxX - newMinX, height: newMaxY - newMinY };
      }
      return map.get(s.id) || s;
    });
    this.recordHistory();
    this.notify("shapes");
  }

  /** Toggle reorder mode for the supplied drag-area. Two modes share
   *  one modal state — `"swap"` swaps the dragged unit with the drop
   *  target, `"ripple"` removes the dragged unit and re-inserts it at
   *  the target's reading-order slot, shifting intermediate units by
   *  one. Re-clicking the active mode's button exits; clicking the
   *  other mode's button while active switches mode. Calling with a
   *  different drag-area id switches focus. */
  toggleReorderMode(dragAreaId: string, mode: ReorderMode = "swap") {
    const sameTarget = this.reorderDragAreaId === dragAreaId;
    if (sameTarget && this.reorderMode === mode) {
      this.reorderDragAreaId = null;
    } else {
      this.reorderDragAreaId = dragAreaId;
      this.reorderMode = mode;
    }
    this._reorderOrigBounds.clear();
    this.reorderHoverTargetId = null;
    this.reorderPreview = null;
    this.notify("reorderDragAreaId");
    this.notify("reorderMode");
    this.notify("reorderHoverTargetId");
    this.notify("reorderPreview");
  }

  /** Force-exit reorder mode regardless of which sub-mode is active.
   *  Used by the Esc handler and the banner Exit button so a stale
   *  mode parameter can't accidentally swap the active mode instead
   *  of turning the whole thing off. */
  exitReorderMode() {
    if (!this.reorderDragAreaId) return;
    this.reorderDragAreaId = null;
    this._reorderOrigBounds.clear();
    this.reorderHoverTargetId = null;
    this.reorderPreview = null;
    this.notify("reorderDragAreaId");
    this.notify("reorderHoverTargetId");
    this.notify("reorderPreview");
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
      createdAt: Date.now(),
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
    const leftInset = this.leftInset || 0;
    const rightInset = this.rightInset || 0;
    const topInset = this.dockedTopHeight || 0;
    const bottomInset = this.dockedBottomHeight || 0;
    if (this.canvasEl) {
      const r = this.canvasEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // Visible region = canvas rect minus sidebar/shelf horizontally
        // and any top/bottom-docked panes vertically.
        return {
          x: r.left + leftInset + (r.width - leftInset - rightInset) / 2,
          y: r.top + topInset + (r.height - topInset - bottomInset) / 2,
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
    this.shapes = [...this.shapes, { id: generateId(), type: "text", position, text, fontSize: opts?.fontSize ?? this.fontSize, color: "#000000", width: this.maxTextWidth, layerId: this.activeLayerId, createdAt: Date.now() } as TextShape];
    this.recordHistory();
    this.notify("shapes");
  }

  /** Pan so `shapeId` is centered in the visible viewport.
   *  `offsetLeft` / `offsetRight` reserve screen space for inset chrome
   *  (sidebar / shelf). Defaults pick up the state's current leftInset.
   *  When the chrome would consume most of the canvas (a narrow pane
   *  with the shelf open), the offsets are dropped so the shape lands
   *  somewhere visible instead of being squeezed under the shelf. */
  focusShape(shapeId: string, offsetLeft?: number, offsetRight?: number, offsetTop?: number, offsetBottom?: number) {
    const shape = this.shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    const bounds = getShapeBounds(shape, this.fontFamily);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const requestedLeft = offsetLeft ?? this.leftInset;
    const requestedRight = offsetRight ?? this.rightInset;
    const requestedTop = offsetTop ?? this.dockedTopHeight;
    const requestedBottom = offsetBottom ?? this.dockedBottomHeight;
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
    let right = requestedRight;
    let top = requestedTop;
    let bottom = requestedBottom;
    if (top + bottom > h * 0.66) {
      top = 0;
      bottom = 0;
    }
    if (left + right > w * 0.66) {
      left = 0;
      right = 0;
    }

    const zoom = this.camera.zoom;
    // Gutter mode: world-y maps 1:1 onto doc-content-y. Scroll the
    // host doc so the shape's centre lands at the viewport vertical
    // centre and lock camera.y to the live scrollTop. Horizontal
    // centring still adjusts camera.x. Instant scroll — `smooth` would
    // fight any user gesture arriving before the animation completes.
    if (this.gutterScrollDOM) {
      // Gutter mode: scroll the host doc so the shape's centre lands at the
      // gutter canvas's vertical centre, then re-derive camera.y from the
      // resulting scrollTop so the 1:1 doc<->notebook mapping is preserved.
      //
      // Shape world-y maps 1:1 onto doc-content-y, and the gutter renders it
      // at canvas-y = (gutterCameraOffset - scrollTop) + cy. Solving for the
      // scrollTop that puts that at the canvas centre (h/2) gives
      // scrollTop = gutterCameraOffset + cy - h/2. Deriving the target from
      // the SAME `gutterCameraOffset` the steady-state sync uses keeps the doc
      // scroll and the canvas camera in lockstep — the earlier formula mixed
      // viewport coords (`scrollerRect.top`, `window.innerHeight`) into the
      // scroll target, which over-scrolled the doc and threw the sync off.
      const target = Math.max(0, this.gutterCameraOffset + cy - h / 2);
      this.gutterScrollDOM.scrollTop = target;
      this.camera = {
        x: (left + w - right) / 2 - cx,
        y: this.gutterCameraOffset - this.gutterScrollDOM.scrollTop,
        zoom: 1,
      };
    } else {
      // Land the shape's centre at the visible-viewport centre. Under a
      // rotated camera the world point maps through R(rotation)·zoom,
      // so subtract the rotated vector (identity when unrotated).
      const rot = this.camera.rotation || 0;
      const zx = cx * zoom, zy = cy * zoom;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      this.camera = {
        x: (left + w - right) / 2 - (rot === 0 ? zx : zx * cos - zy * sin),
        y: (top + h - bottom) / 2 - (rot === 0 ? zy : zx * sin + zy * cos),
        zoom,
        rotation: this.camera.rotation,
      };
    }
    this.selectedIds = new Set([shapeId]);
    this.notify("camera");
    this.notify("selectedIds");
  }

}
