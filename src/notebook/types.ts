// === Tools ===
export type Tool = "select" | "text" | "drag-area" | "brainstorm" | "pen"
  | "split" | "grab";

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
  /** Wall-clock ms the shape was created. Only collapsing a split reads
   *  it — a split remembers when it was cut, and a collapse discards the
   *  material that appeared inside it *since*. Optional because every
   *  shape written before splits shipped lacks it; a missing stamp counts
   *  as "older than every split", so pre-existing content is carried
   *  across a collapse rather than swept away by it. */
  createdAt?: number;
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
  /** Per-shape overrides of the canvas-wide text style. Absent means
   *  "follow the canvas", which is every shape on an ordinary notebook;
   *  a proofread notebook seeds new text with its own (see
   *  `DrawingState.newTextStyle`) so annotation reads as a correction
   *  mark against the page rather than as more of the document. */
  fontFamily?: string;
  bold?: boolean;
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
  /** The thumbnail bakes its own borders (e.g. the doc page-pile, whose
   *  bounding box isn't a clean rectangle) — the canvas chrome skips
   *  its hairline border for these. */
  frameless?: boolean;
  /** Docs only (Desktop): the clickable outline column is shown to the
   *  right of the page. Persisted so it survives reopen; the row
   *  hit-geometry lives in the thumbnail record, not here. */
  outline?: boolean;
  /** The file's sidebar highlight colour (a ROW_COLORS key). Painted as
   *  a tinted wash + border over the thumbnail so a colour-coded file
   *  reads the same on its Desktop as in the file tree. */
  tint?: string;
  /** Stack files only: each constituent's slice band in the thumbnail's
   *  own CSS px, so hovering a slice can caption that file's name. */
  slices?: { x: number; w: number; name: string }[];
  /** Nested projects only: where each child file landed inside the
   *  composite, in the thumbnail's own CSS px, plus the scale the
   *  composite shrank them by. The renderer uses these to paint each
   *  child's own file stickies onto the composite live, the same way it
   *  paints a top-level thumbnail's — stickies are never baked into a
   *  thumbnail (they change per keystroke). */
  projectChildren?: { kind: string; fileId: string | null; x: number; y: number; w: number; h: number }[];
  projectScale?: number;
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
  /** Proofread notebooks: which source page this image (or, after a
   *  split, this piece of it) came from. Survives cuts for free — every
   *  cut spreads the original shape — which is what lets the page rail
   *  draw a live minimap: a piece's `crop` window indexes into the same
   *  page it indexes into on the full raster, so the rail can paint the
   *  piece out of that page's small thumbnail. */
  proofPageIndex?: number;
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

// === Splits ===

export type Axis = "horizontal" | "vertical";

/**
 * A split is a pair of parallel lines cut across the whole canvas. It is
 * NOT a shape: it has no bounds, never joins a group or a layer, and is
 * never selected — so it lives in its own notebook-level list
 * (`DrawingState.splits`, persisted alongside `bookmarks` /`flowEdges`)
 * rather than in the `Shape` union.
 *
 * `a` and `b` are the two lines' positions on the split's cross axis in
 * WORLD units — y for a horizontal split, x for a vertical one. They are
 * equal at creation (the renderer still draws them 10 screen px apart so
 * both are grabbable) and separate as the user drags:
 *
 *   coordinate < a   →  the "near" side, carried by the a line
 *   coordinate > b   →  the "far" side, carried by the b line
 *   a ≤ coord ≤ b    →  inside the split — material that appeared in the
 *                       gap the drag opened, and moves with neither line
 *
 * Because a line only ever moves together with the content on its own
 * side, that classification stays true across any number of drags, and
 * nesting falls out of it: a split whose lines sit on the near side of
 * an outer split is carried by the outer split's line like anything else.
 */
export interface Split {
  id: string;
  orientation: Axis;
  /** Near line (top for horizontal, left for vertical), world units. */
  a: number;
  /** Far line (bottom / right), world units. Equal to `a` at creation. */
  b: number;
  /** Wall-clock ms the split was cut. "Clear split content" removes
   *  shapes inside the gap whose `createdAt` is newer than this. */
  createdAt: number;
}

/** Which of a split's two lines a gesture is addressing. */
export type SplitLine = "a" | "b";

/**
 * The in-flight grab. A grab is a split with a lift built in: sweep a
 * band, apply it (the band's content moves into `buffer` and the two
 * edges are drawn together), then place the buffer somewhere else.
 *
 * The session rides the undo checkpoint, which is what makes ⌘Z after a
 * place drop the user back into the place stage rather than unwinding
 * the whole grab.
 */
export interface GrabSession {
  /** "band" while the sweep / edge adjustment is live (nothing has been
   *  moved yet), "place" once the content is in the buffer. */
  stage: "band" | "place";
  orientation: Axis;
  /** Band edges in world units on the cross axis; `a` ≤ `b`. */
  a: number;
  b: number;
  /** Lifted content, positioned relative to the band's `a` edge so it
   *  can be dropped anywhere. Empty during the band stage. */
  buffer: Shape[];
  /** Splits that were lifted along with the content, same convention. */
  bufferSplits: Split[];
  /** Canvas state captured immediately before Apply, so Cancel can put
   *  everything back in one step at any point in the two-stage flow. */
  restore: { shapes: Shape[]; splits: Split[] } | null;
}

// === Proofreading ===

/** One page of a proofread notebook: the image shape holding the render
 *  plus the small raster the thumbnail rail paints. `y` / `height` are
 *  the page's world placement AT CREATION — the rail re-reads the live
 *  shape when it can, and falls back to these once a page image has been
 *  split into pieces (a split cut renames nothing, but it does replace
 *  the shape id the page was created under). */
export interface ProofPage {
  index: number;
  shapeId: string;
  y: number;
  height: number;
  /** Page size in world units, so the rail can lay pieces out against
   *  the page they came from without consulting the live shapes. */
  width: number;
  thumbDataUrl: string;
}

/** Proofread metadata carried by a notebook created from a PDF. Its
 *  presence is what puts the canvas in proofread mode (the page
 *  thumbnail rail). */
export interface ProofMeta {
  sourcePdfFileId: string | null;
  sourceName: string;
  /** Layer that holds the page images. Starts locked. */
  pageLayerId: string;
  pages: ProofPage[];
}

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
