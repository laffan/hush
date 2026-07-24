// === Tools ===
export type Tool = "select" | "text" | "drag-area" | "brainstorm" | "pen";

/** Sub-tool while Tool === "pen" (drawing mode). The top-level `tool`
 *  stays "pen"; `drawingSubTool` picks which pen-mode operation is
 *  active. Has no meaning outside drawing mode. */
export type DrawingSubTool = "draw" | "erase" | "slice" | "select";

// === Geometry ===
export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// === Camera ===
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** View rotation in radians. Applied after zoom, before the x/y
   *  translation: screen = (x, y) + R(rotation) · (zoom · world).
   *  Absent / 0 = axis-aligned. Only produced by the two-finger
   *  rotate gesture, which is opt-in via the canvas settings menu;
   *  pan / zoom code must carry the field through when rebuilding
   *  the camera object. */
  rotation?: number;
}

export interface CameraBookmark {
  id: string;
  name: string;
  camera: Camera;
}

// === Shapes ===
export const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT_RATIO = 1.3;

interface ShapeBase {
  id: string;
  color: string;
  parentId?: string; // id of drag-area parent, if any
  groupId?: string;  // shared id for logically grouped shapes
  pocketed?: boolean;  // true if shape is pocketed to right-side zone
  /** Layer membership. Optional on read (legacy shapes default to the
   *  first layer on load); set by every shape creator going forward. */
  layerId?: string;
}

/** Stroke points carry pressure for brush-size modulation by the
 *  stamped drawing engine. Legacy v1 data (points without pressure)
 *  is upgraded at load time by file-io. */
export interface DrawPoint extends Point {
  pressure: number;
  /** Capture timestamp in ms (PointerEvent.timeStamp — relative to
   *  page load, so only *deltas within a stroke* are meaningful).
   *  Optional: strokes drawn before timing shipped don't have it.
   *  Consumed by the ML Kit ink recognizer, which reads pen velocity;
   *  every point-rebuilding transform must carry it through. */
  t?: number;
}

export interface DrawShape extends ShapeBase {
  type: "draw";
  /** Base stamp radius in world CSS px. Renamed from v1 `width`. */
  size: number;
  /** Brush atlas id; see BRUSH_DEFS in the drawing engine. */
  brushId: string;
  /** Stroke composite behavior. `highlighter` uses multiply + alpha. */
  mode: "normal" | "highlighter";
  /** Drawing layer the stroke belongs to. See `Layer` below. */
  layerId: string;
  points: DrawPoint[];
  /** When true, stroke's color tracks theme.foreground. Saved as
   *  `"auto"` in the color field on disk; resolved on load. */
  colorIsAuto?: boolean;
  /** When true, stroke's color tracks theme.headingColor — the same
   *  hue markdown headings get in the editor. Mutually exclusive with
   *  colorIsAuto. */
  colorIsHeading?: boolean;
}

/** Drawing layers are a drawing-mode-only concept — notebooks have
 *  one or more layers, each owning a subset of DrawShapes via
 *  stroke.layerId. Layers are stored top-first (index 0 = top). */
export interface Layer {
  id: string;
  name: string;
  locked: boolean;
  hidden: boolean;
}

/** One of the 4 brush presets in drawing mode. Not persisted with
 *  the notebook; lives in app state. */
export interface DrawingSlot {
  brushId: string;
  color: string;            // hex or the literal "auto"
  size: number;
  streamline: number;       // 0..1
  spacing: number;          // 0..1 (fraction of stamp radius)
  mode: "normal" | "highlighter";
}

export interface TextShape extends ShapeBase {
  type: "text";
  position: Point;
  text: string;
  fontSize: number;
  width?: number; // constraint width for wrapping; undefined = auto-size
  manualWidth?: boolean; // true if user explicitly resized via handles
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  /** Marks this text shape as a persisted gutter header label. Renders
   *  with the faded shadow-header style + horizontal rule above, is
   *  immune to selection / drag / edit, and gets its y position synced
   *  to the matching doc header on every gutter scan. */
  headerLabel?: boolean;
  headerText?: string;
  headerLevel?: number;
}

export interface ImageCrop {
  /** Crop region as fractions (0-1) of the full image */
  x: number; y: number; w: number; h: number;
}

/** Marks an ImageShape as a Desktop file thumbnail — a live preview of
 *  a real file (doc / notebook / pdf / stack) or project. `key` is the
 *  Desktop reconcile identity (fileId, or node id for projects). These
 *  shapes drag / group / scale like any image but are protected from
 *  delete + rename: the Desktop mirrors the filesystem, so the file
 *  itself is the source of truth. dataUrls are stripped on persist and
 *  rehydrated from the thumbnail cache on open. */
export interface DesktopFileRef {
  key: string;
  kind: "doc" | "notebook" | "pdf" | "stack" | "project";
  fileId?: string | null;
  nodeId?: string;
  name: string;
  /** Docs only: the file has a paired gutter notebook — surfaces the
   *  "Open with Gutter Visible" hover control on its thumbnail. */
  hasGutter?: boolean;
  /** Thumbnail-stack membership (Desktop only). Members share this id
   *  AND a groupId (so the engine drags the pile together); labels hide
   *  while stacked and reappear below the pile on hover. Mirrors the
   *  shape's groupId — desktop-stacks.js keeps the two in sync. */
  stackId?: string;
}

export interface ImageShape extends ShapeBase {
  type: "image";
  position: Point;
  width: number;
  height: number;
  dataUrl: string;
  /** Appearance-aware image: when present, `dataUrl` holds the
   *  light-appearance raster and `dataUrlDark` the dark one; render
   *  paths pick by the active theme variant. Produced by rasterizing
   *  theme-tracking content (auto/heading-coloured strokes and text)
   *  so the bake keeps following light/dark switches. */
  dataUrlDark?: string;
  name: string;
  crop?: ImageCrop;
  /** Present only on Desktop file-thumbnail shapes. */
  fileRef?: DesktopFileRef;
}

export interface DragAreaShape extends ShapeBase {
  type: "drag-area";
  position: Point;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  borderRadius: number;
  borderColor?: string;
  borderWidth?: number;
  /** Screen-pinned: the box (and its contents) holds its on-screen
   *  position while the camera pans — the canvas scrolls beneath it.
   *  Zoom changes rebase the anchor instead of compensating. */
  pinned?: boolean;
}

export type Shape = DrawShape | TextShape | ImageShape | DragAreaShape;

// === Selection ===
export interface SelectionBox {
  start: Point;
  end: Point;
}

// === Color palette ===
export const COLOR_PALETTE: Record<string, string> = {
  black: "#000000",
  gray: "#6b7280",
  red: "#ea4335",
  orange: "#ff9800",
  yellow: "#fbbc04",
  green: "#34a853",
  blue: "#4285f4",
  violet: "#9c27b0",
  "light-red": "#ffb3ba",
  "light-green": "#90ee90",
  "light-blue": "#87ceeb",
  "light-violet": "#dda0dd",
  white: "#ffffff",
};

export const BACKGROUND_COLORS = ["reset", "auto", "heading", "black", "white", "red", "light-blue", "green"] as const;
export const TEXT_COLORS = ["reset", "auto", "heading", "black", "white", "red", "light-blue", "green"] as const;

/** Pen palette shared by the brush flyout's color row and the
 *  mini-palette's secondary color selector. "auto" tracks the theme
 *  foreground and "heading" the theme heading colour; the rest are
 *  explicit hex values. */
export const PEN_COLORS = ["auto", "heading", "#111111", "#e11d48", "#f59e0b", "#16a34a", "#2563eb", "#7c3aed", "#fde047"];

// === Shelf ===
export interface ShelfNode {
  id: string;
  type: "text" | "image" | "drag-area" | "group";
  label: string;
  excerpt: string;
  shapeId: string;
  parentId: string | null;
  childIds: string[];
  color: string | null;
  depth: number;
  pinned: boolean;
}
