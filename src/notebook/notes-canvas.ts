import type { Camera, Shape } from "./types";
import type { BackgroundPattern } from "./state";
import type { AppearanceMode } from "./themes";
import { DrawingState } from "./state";
import { render } from "./renderer";
import { bindInputEvents, type NotebookShortcuts } from "./input-handler";
import { createToolbar } from "./ui/toolbar";
import { createReorderBanner } from "./ui/reorder-banner";
import { createSelectionToolbar } from "./ui/selection-toolbar";
import { createShelfPanel, type ShelfPanelEl } from "./ui/shelf-panel";
import { createShelfResizer } from "./ui/shelf-resizer";
import { createTextEditor } from "./ui/text-editor";
import { createBrainstormInput } from "./ui/brainstorm-input";
// @ts-ignore — JS module, no type declaration file
import { registerNotebookDropTarget } from "../pane/text-drag.js";
// @ts-ignore — JS module, no type declaration file
import { getNotebookCanvasPanes, focusAndCenterPaneById, scrollPaneToMatch } from "../pane/pane-manager.js";
import { createDrawingLayer } from "./drawing/drawing-layer";
import type { DrawingLayer } from "./drawing/drawing-layer";
// PERF-HUD (temporary): tracer singleton — see perf-hud.ts.
import { perf } from "./perf-hud";
import { createDrawingToolPanel } from "./drawing/tool-panel";
import { createBgSettingsFixedButton } from "./ui/bg-settings-fixed-button";

/** Read the user's flag-colour map from Hush settings. Notebook text
 *  shapes mirror Docs by colouring `==FLAG==` highlights with the flag's
 *  configured hue; falling back to undefined just means the renderer
 *  uses its default highlight tint. */
function getFlagColorsFromHush(): Record<string, string> | undefined {
  const appState = (window as unknown as {
    __hushState__?: { settings?: { flagColors?: Record<string, string> } };
  }).__hushState__;
  return appState?.settings?.flagColors;
}

/** Mirror Hush's `touchMode` setting into the render state so the
 *  flowchart-edge delete dot only paints in Touch mode (mouse users
 *  already get the X on hover). */
function getTouchModeFromHush(): boolean {
  const appState = (window as unknown as {
    __hushState__?: { settings?: { touchMode?: boolean } };
  }).__hushState__;
  return !!appState?.settings?.touchMode;
}

/** A file's own file-level stickies (sticky-notes.js publishes the hook),
 *  drawn as mini notes on that file's Desktop thumbnail. Read per frame
 *  so a note edit shows without regenerating the cached thumbnail. */
function getFileStickiesFromHush(kind: string, fileId: string): { text: string }[] {
  const fn = (window as unknown as {
    __hushFileStickies?: (kind: string, fileId: string) => { text: string }[];
  }).__hushFileStickies;
  try { return fn ? fn(kind, fileId) || [] : []; } catch { return []; }
}

/** Desktop-pinned stickies for one project, in that Desktop's world
 *  coords. Same bridge the composite thumbnails read (sticky-notes.js
 *  publishes it); null target means this canvas paints none. */
function getDesktopStickiesFromHush(projectId: string | null) {
  if (!projectId) return null;
  // When this project's own full-window Desktop is open, its notes are on
  // screen as real (editable) DOM in that view's sticky layer. Painting
  // them here as well would double them up.
  if ((window as unknown as { __hushDesktopOpenId?: string }).__hushDesktopOpenId === projectId) return null;
  const fn = (window as unknown as {
    __hushDesktopStickiesFor?: (id: string) => { text: string; wx: number; wy: number; w: number; h: number }[];
  }).__hushDesktopStickiesFor;
  try { return fn ? fn(projectId) || null : null; } catch { return null; }
}

/** The notebook instance that most recently received a pointer interaction.
 *  The document-level "copy" listener below routes Cmd+C to this one. */
let lastActiveNotebook: NotesCanvas | null = null;

/** State of the most recently interacted-with notebook canvas. Set on
 *  pointerdown and cleared on destroy. The window-scoped Cmd+C / V / X
 *  keyboard handlers in `input-handler.ts` consult this so multi-canvas
 *  scenarios (main canvas + a pane, desk thumbnail, etc.) don't all
 *  paste in parallel. Returns null when no canvas has been touched yet. */
export function getActiveNotebookState(): DrawingState | null {
  return lastActiveNotebook ? lastActiveNotebook.state : null;
}

/** Explicitly make `c` the clipboard/undo routing target. The Desktop
 *  takeover calls this on mount: the hidden main-notebook canvas
 *  underneath may already hold the slot (the constructor's claim only
 *  fires when the slot is empty), and without the hand-off Cmd+C / V
 *  on the fresh Desktop would no-op until its first pointerdown. */
export function claimActiveNotebook(c: NotesCanvas): void {
  lastActiveNotebook = c;
}

/** Live registry of mounted NotesCanvas instances, used by the iOS
 *  pencil bridge to push `pencilOnly` into every drawing layer (main
 *  canvas + any pane snapshots) without each surface having to subscribe
 *  individually. Module-local; populated/depopulated by the constructor
 *  and `destroy()`. */
const liveCanvases = new Set<NotesCanvas>();

/** Module-level pencil-only flag. Default off so non-iOS platforms keep
 *  the existing finger-as-mouse behaviour. Toggled once at startup by
 *  `pencil-bridge.js` when the iOS plugin reports `loaded`. New canvases
 *  read this on mount; existing canvases are updated in place by the
 *  setter below. */
let _pencilOnly = false;

/** Apply the pencil-only flag to every mounted NotesCanvas (and future
 *  ones). Called by the iOS pencil bridge once the native plugin is
 *  ready. Idempotent. */
export function setNotebookPencilOnly(on: boolean): void {
  _pencilOnly = !!on;
  for (const c of liveCanvases) c._applyPencilOnly(_pencilOnly);
}

/** Notebook undo, exposed for the iPad touch-mode floating undo button.
 *  Routes the call to the most-recently interacted-with notebook (same
 *  routing the copy/paste path uses). Returns true if a notebook
 *  handled the undo, false if no notebook is mounted (so the caller
 *  can fall back to a doc-side path if it has one). */
export function notebookUndo(): boolean {
  const target = lastActiveNotebook ?? liveCanvases.values().next().value ?? null;
  if (!target) return false;
  target.state.undo();
  return true;
}

/** Last eraser-class sub-tool the user picked. Tracks slice / erase so
 *  the Apple Pencil double-tap can flip the user back into whichever
 *  eraser they were last using. Defaults to "erase" — the more common
 *  pick — so a fresh session that's never touched slice still hands
 *  the user a working eraser on the first squeeze. Updated whenever a
 *  notebook's drawingSubTool transitions into either eraser; see the
 *  per-canvas listener in NotesCanvas's constructor. */
let _lastEraserSubTool: "erase" | "slice" = "erase";

/** Apple Pencil 2nd-gen / Pencil Pro double-tap handler. Toggles the
 *  active notebook between the user's last-used eraser type (slice or
 *  erase, defaulting to erase) and the active brush — the brush's
 *  configuration lives on `state.activeBrushSlot`, so flipping back to
 *  `draw` restores everything the user had set up. Routed in via
 *  `pencil-bridge.js` listening to the iOS plugin's `double-tap` event.
 *
 *  Routes to the most-recently interacted-with notebook (matches the
 *  copy/paste routing convention) and falls back to the first live
 *  canvas if no pointer interaction has happened yet. No-op if no
 *  notebook is mounted — the user could be in a Doc when the Pencil
 *  fires, in which case we silently drop the gesture rather than
 *  surface a tool change in an unrelated surface. */
export function toggleNotebookEraser(): void {
  const target = lastActiveNotebook ?? liveCanvases.values().next().value ?? null;
  if (!target) return;
  const s = target.state;
  if (s.tool !== "pen") {
    s.tool = "pen";
    s.notify("tool");
    s.notify("drawingMode");
  }
  const sub = s.drawingSubTool;
  if (sub === "erase" || sub === "slice") {
    s.setDrawingSubTool("draw");
  } else {
    s.setDrawingSubTool(_lastEraserSubTool);
  }
}

let copyListenerAttached = false;

function ensureCopyListener() {
  if (copyListenerAttached) return;
  copyListenerAttached = true;
  document.addEventListener("copy", (e: ClipboardEvent) => {
    if (!lastActiveNotebook) return;
    // Never hijack Cmd+C when the user is editing text in an input/textarea
    // (including the notebook's inline text editor and brainstorm input).
    const a = document.activeElement as HTMLElement | null;
    if (a) {
      const tag = a.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || a.isContentEditable) return;
    }
    lastActiveNotebook.handleCopy(e);
  });
}

export class NotesCanvas {
  readonly container: HTMLElement;
  readonly state: DrawingState;

  private _canvas: HTMLCanvasElement;
  private _rafId = 0;
  private _needsRender = true;
  private _imageCache = new Map<string, HTMLImageElement>();
  private _cleanupInput: (() => void) | null = null;
  private _cleanupDropTarget: (() => void) | null = null;
  private _cleanupPaneListener: (() => void) | null = null;
  private _shelfPanel: HTMLElement | null = null;
  private _shelfResizer: HTMLElement | null = null;
  private _shelfRightInsetCleanup: (() => void) | null = null;
  private _shelfTrackRaf = 0;
  private _drawingLayer: DrawingLayer | null = null;

  constructor(container: HTMLElement, shortcuts?: Partial<NotebookShortcuts>) {
    this.container = container;
    this.state = new DrawingState();

    // Set up container styles
    Object.assign(container.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      overflow: "hidden",
      background: "#f4f5f7",
    });

    // Create canvas
    this._canvas = document.createElement("canvas");
    Object.assign(this._canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      touchAction: "none",
    });
    container.appendChild(this._canvas);

    // Store canvas ref in state for pointer handlers
    this.state.canvasEl = this._canvas;

    // Bind input events
    this._cleanupInput = bindInputEvents(this._canvas, this.state, shortcuts);

    // Update cursor on tool change
    const cursorMap: Record<string, string> = {
      select: "default", text: "text", "drag-area": "crosshair", brainstorm: "text",
    };
    this.state.addEventListener("change", () => {
      // Brainstorm mode behaves like select on the canvas — keep the default cursor instead of the text I-beam.
      if (this.state.isPanning) this._canvas.style.cursor = "grab";
      else this._canvas.style.cursor = this.state.brainstormMode ? "default" : (cursorMap[this.state.tool] || "default");
    });

    // Image cache management
    this.state.addEventListener("change", () => this._syncImageCache());

    // Track the user's most-recent eraser pick so the Apple Pencil
    // double-tap can flip back into that specific eraser instead of
    // always landing on "erase". The double-tap itself goes through
    // setDrawingSubTool too, so this listener also picks up double-tap
    // transitions — harmless, since the value being recorded matches
    // the destination the toggle just chose.
    this.state.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = e.detail?.keys || [];
      if (!keys.includes("drawingSubTool")) return;
      const sub = this.state.drawingSubTool;
      if (sub === "erase" || sub === "slice") _lastEraserSubTool = sub;
    }) as EventListener);

    // Apply theme to container
    this.state.addEventListener("change", () => {
      const t = this.state.theme;
      container.style.background = this.state.canvasBackgroundOverride || t.canvasBackground;
      this._updatePatternCssVar();
    });

    // Drawing layer. Mounts its own DOM (3 canvases + SVG) inside
    // `container` alongside the notebook canvas. The layer subscribes
    // to state shape events via its sync shim; we sync camera +
    // theme + drawing-mode input routing explicitly.
    // Two-finger pan inside the drawing engine: the engine owns
    // touches while the brush/eraser/lasso is active, so the canvas's
    // own touchstart pan handler never sees them. The engine's
    // gesture recogniser emits pan callbacks when two fingers drift;
    // we translate them into state.camera motion here.
    // Frame of reference for the multi-touch gesture that's currently
    // active. Pan and pinch both run off the same start camera so a
    // combined spread+drift produces one coherent transform — the
    // world point under the gesture's start midpoint stays under the
    // user's current midpoint.
    let touchGestureCamStart: Camera | null = null;
    let touchGestureScrollTop = 0;
    let touchPinchStartMid = { x: 0, y: 0 };
    let touchPinchStartDist = 0;
    let touchPinchStartAngle = 0;
    let touchPinching = false;
    // Zoom + rotation each engage with their own hysteresis inside the
    // pinch stream, mirroring input-handler.ts's PINCH_ENGAGE_PX: until
    // the spread (or pair angle) drifts deliberately, the gesture is a
    // pure midpoint pan. Every engagement rebaselines the start refs to
    // the current frame so the camera continues from where it is — no
    // snap-back to the gesture-start position.
    let touchZoomEngaged = false;
    let touchRotateEngaged = false;
    const TOUCH_ZOOM_ENGAGE_PX = 12;
    const TOUCH_ROTATE_ENGAGE_RAD = 0.15;
    const angDelta = (a: number, b: number) => {
      const d = a - b;
      return Math.atan2(Math.sin(d), Math.cos(d));
    };
    this._drawingLayer = createDrawingLayer({
      container,
      state: this.state as unknown as import("./drawing/sync-shim").ShimState,
      theme: this.state.theme,
      camera: this.state.camera,
      onTouchPanStart: () => {
        if (!touchGestureCamStart) touchGestureCamStart = { ...this.state.camera };
        touchGestureScrollTop = this.state.gutterScrollDOM?.scrollTop || 0;
      },
      onTouchPanMove: (dx, dy) => {
        if (!touchGestureCamStart) return;
        // Pinch path owns the camera while it's active — the pinch
        // formula already accounts for midpoint translation.
        if (touchPinching) return;
        // Gutter mode: vertical drag scrolls the host doc 1:1; horizontal
        // still pans camera.x. Camera.y tracks the live scrollTop.
        if (this.state.gutterScrollDOM) {
          this.state.gutterScrollDOM.scrollTop = touchGestureScrollTop - dy;
          this.state.camera = { x: touchGestureCamStart.x + dx, y: this.state.gutterCameraOffset - this.state.gutterScrollDOM.scrollTop, zoom: 1 };
          this.state.notify("camera");
          return;
        }
        this.state.camera = {
          x: touchGestureCamStart.x + dx,
          y: touchGestureCamStart.y + dy,
          zoom: touchGestureCamStart.zoom,
          rotation: touchGestureCamStart.rotation,
        };
        this.state.notify("camera");
      },
      onTouchPanEnd: () => {
        if (!touchPinching) touchGestureCamStart = null;
      },
      onTouchPinchStart: (mid, dist, angle) => {
        // Rebaseline the shared gesture frame at the engage instant.
        // The pan path has usually been moving the camera since
        // pan-start; keeping the original camStart here snapped the
        // camera back to its pre-pan position the moment the spread
        // drifted 12 px — the "two-finger pan doesn't work in pen
        // mode" bug.
        touchGestureCamStart = { ...this.state.camera };
        touchGestureScrollTop = this.state.gutterScrollDOM?.scrollTop || 0;
        touchPinchStartMid = mid;
        touchPinchStartDist = dist;
        touchPinchStartAngle = angle;
        touchZoomEngaged = false;
        touchRotateEngaged = false;
        touchPinching = true;
      },
      onTouchPinchMove: (mid, dist, angle) => {
        if (!touchGestureCamStart || touchPinchStartDist <= 0) return;
        // Gutter mode: zoom is disabled. Pinch becomes pure pan —
        // midpoint dy → doc scroll, dx → camera.x. Camera.y tracks the
        // live scrollTop.
        if (this.state.gutterScrollDOM) {
          const cs = touchGestureCamStart;
          const dx = mid.x - touchPinchStartMid.x;
          const dy = mid.y - touchPinchStartMid.y;
          this.state.gutterScrollDOM.scrollTop = touchGestureScrollTop - dy;
          this.state.camera = { x: cs.x + dx, y: this.state.gutterCameraOffset - this.state.gutterScrollDOM.scrollTop, zoom: 1 };
          this.state.notify("camera");
          return;
        }
        // Zoom + rotation hysteresis. Each engagement rebaselines every
        // start ref to the current frame so the transform continues
        // seamlessly from the camera's present state.
        const rebase = () => {
          touchGestureCamStart = { ...this.state.camera };
          touchPinchStartMid = mid;
          touchPinchStartDist = dist;
          touchPinchStartAngle = angle;
        };
        if (!touchZoomEngaged && Math.abs(dist - touchPinchStartDist) > TOUCH_ZOOM_ENGAGE_PX) {
          rebase();
          touchZoomEngaged = true;
        }
        if (this.state.canvasRotationEnabled && !touchRotateEngaged &&
            Math.abs(angDelta(angle, touchPinchStartAngle)) > TOUCH_ROTATE_ENGAGE_RAD) {
          rebase();
          touchRotateEngaged = true;
        }
        const cs = touchGestureCamStart;
        // Match the wheel handler's zoom envelope: [0.25, 1].
        const rawScale = touchZoomEngaged && touchPinchStartDist > 1 ? dist / touchPinchStartDist : 1;
        const newZoom = Math.min(1, Math.max(0.25, cs.zoom * rawScale));
        const k = newZoom / cs.zoom;
        const dTheta = touchRotateEngaged ? angDelta(angle, touchPinchStartAngle) : 0;
        // One coherent transform: the world point that was under the
        // start midpoint stays under the current midpoint while zoom
        // scales and (opt-in) rotation turns about it. With k = 1 and
        // dTheta = 0 this reduces to a pure midpoint pan.
        const vx = touchPinchStartMid.x - cs.x;
        const vy = touchPinchStartMid.y - cs.y;
        const cos = Math.cos(dTheta), sin = Math.sin(dTheta);
        this.state.camera = {
          x: mid.x - k * (vx * cos - vy * sin),
          y: mid.y - k * (vx * sin + vy * cos),
          zoom: newZoom,
          rotation: dTheta !== 0 ? (cs.rotation || 0) + dTheta : cs.rotation,
        };
        this.state.notify("camera");
      },
      onTouchPinchEnd: () => {
        touchPinching = false;
        touchZoomEngaged = false;
        touchRotateEngaged = false;
        touchGestureCamStart = null;
      },
    });
    // Seed the engine with the user's chosen lasso hold duration.
    this._drawingLayer.setLassoHoldMs(this.state.lassoHoldMs);
    this.state.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = (e.detail && e.detail.keys) || [];
      if (!this._drawingLayer) return;
      if (keys.includes("camera")) {
        // PERF-HUD (temporary): covers ensureCoverage + wrapper transform.
        perf.begin("engine:setCamera");
        this._drawingLayer.setCamera(this.state.camera);
        perf.end("engine:setCamera");
      }
      if (keys.includes("theme")) this._drawingLayer.setTheme(this.state.theme);
      if (keys.includes("drawingMode") || keys.includes("tool") || keys.includes("isPanning")) {
        // Pen tool on ⇒ engine SVG captures pointers. Anything else —
        // including a persistent / transient pan (isPanning) while
        // inside drawing mode — releases the SVG so the notebook
        // canvas owns input for pan. Without the isPanning check,
        // holding space over a drawing would do nothing because the
        // SVG was still swallowing the pointerdown.
        this._drawingLayer.setInputEnabled(this.state.drawingMode && !this.state.isPanning);
      }
      if (keys.includes("lassoHoldMs")) {
        this._drawingLayer.setLassoHoldMs(this.state.lassoHoldMs);
      }
    }) as EventListener);

    // Top tool panel + brush-slot flyout. The panel is a pill; the
    // flyout is wider and mounts alongside so it isn't clipped by
    // the pill's overflow. Both live inside `container`. The drawing
    // pill anchors itself to the right edge of the bottom toolbar at
    // layout time; the dragTab (gray hamburger) is appended further
    // below alongside the rest of the bottom-bar UI.
    // The drawing-tools controller appends its buttons (divider,
    // brush slots, slice / erase, lasso) directly to the bottom
    // toolbar so the bar reads as one continuous strip — no
    // inter-pill shadow seam. The end-cap tabs (drag, rotate,
    // bg-settings) are returned separately and mounted alongside.
    // Bottom toolbar must already exist before we get here.
    container.appendChild(createSelectionToolbar(this.state, {
      getImageCache: () => this._imageCache,
      getDrawingLayer: () => this._drawingLayer,
    }));
    container.appendChild(createTextEditor(this.state));
    container.appendChild(createBrainstormInput(this.state));
    container.appendChild(createReorderBanner(this.state));
    const bottomToolbar = createToolbar(this.state);
    container.appendChild(bottomToolbar);
    const drawingChrome = createDrawingToolPanel(this.state, this._drawingLayer, bottomToolbar);
    container.appendChild(drawingChrome.flyout);
    container.appendChild(drawingChrome.dragTab);
    const bgFixed = createBgSettingsFixedButton(this.state);
    container.appendChild(bgFixed.button);
    container.appendChild(bgFixed.popup);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => drawingChrome.relayout());
      ro.observe(bottomToolbar);
      ro.observe(container);
    }
    requestAnimationFrame(() => drawingChrome.relayout());

    // Route Hush select-drag through the drawing engine's preview
    // pipeline for DrawShapes. Without this, dragging N selected
    // strokes spams per-frame setStrokePoints on the engine — each
    // call does a linear stroke lookup + tile rebake. The engine's
    // previewTransform does the same work as one GPU blit per frame.
    const dl = this._drawingLayer;
    this.state.onShapeDragStart = (ids) => {
      const drawIds: string[] = [];
      for (const s of this.state.shapes) {
        if (s.type === "draw" && ids.has(s.id)) drawIds.push(s.id);
      }
      if (drawIds.length > 0) dl.beginSelectionDrag(drawIds);
    };
    this.state.onShapeDragMove = (dx, dy) => { dl.updateSelectionDrag(dx, dy); };
    this.state.onShapeDragEnd = () => { dl.endSelectionDrag(); };

    // Emit "notebook-change" for autosave integration whenever shapes
    // (or other persisted state — bookmarks) change. Camera (pan / zoom)
    // changes ride a separate event so the bridge can persist them
    // without spending a version snapshot on every pan / zoom step.
    this.state.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = e.detail?.keys || [];
      if (keys.includes("shapes") || keys.includes("bookmarks")) {
        this.container.dispatchEvent(new CustomEvent("notebook-change"));
      }
      if (keys.includes("camera")) {
        this.container.dispatchEvent(new CustomEvent("notebook-camera-change"));
      }
    }) as EventListener);

    // Track which notebook the user is currently interacting with so the
    // shared document "copy" listener can route Cmd+C to the right one.
    this._canvas.addEventListener("pointerdown", () => { lastActiveNotebook = this; }, true);
    // Claim active-canvas status on mount so window-scoped clipboard
    // handlers route to this instance even before any pointerdown. If a
    // pane mounts later it will steal the slot on its first pointer
    // gesture (the listener above), and the user's last-touched canvas
    // remains the clipboard target.
    if (!lastActiveNotebook) lastActiveNotebook = this;
    ensureCopyListener();

    // Register as a drop target for the Cmd-drag text system so text
    // dragged from a doc editor lands as a new text shape on this canvas.
    this._cleanupDropTarget = registerNotebookDropTarget(this._canvas, this.state);

    // Build UI — no settings panel or file panel (Hush manages those)
    const shelfCallbacks = {
      // Surface notebook panes inside the shelf so their text content
      // is searchable next to the canvas's own shapes. The list is read
      // live on every rebuild so editor edits show up without a
      // dedicated subscription.
      getPanes: () => getNotebookCanvasPanes(),
      onFocusPane: (id: string) => focusAndCenterPaneById(id),
      onScrollPaneToMatch: (id: string, from: number, to: number) => scrollPaneToMatch(id, from, to),
      initialWidth: (() => {
        const appState = (window as unknown as { __hushState__?: { settings?: { notebookShelfWidth?: number } } }).__hushState__;
        return appState?.settings?.notebookShelfWidth;
      })(),
    };

    this._shelfPanel = createShelfPanel(this.state, shelfCallbacks);
    container.appendChild(this._shelfPanel);
    const syncShelfRightInset = () => {
      const rect = this._shelfPanel?.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      if (rect && cr.width) this.setRightInset(Math.max(0, cr.right - rect.left));
    };
    // The shelf opens / closes via a `transition: width 0.2s`. A single
    // observer-driven read lands on the *pre*-transition width, which left
    // the inset (and so the minimap + bg button) stuck after a close — on
    // open, mounting the shelf content kicked further re-measures that
    // happened to settle it, but close detaches content and nothing
    // followed up. Re-measure every frame for the transition's duration so
    // the inset tracks the animating width both ways and settles correctly.
    let _shelfTrackUntil = 0;
    const trackShelfInsetDuringTransition = () => {
      _shelfTrackUntil = performance.now() + 260;
      if (this._shelfTrackRaf) return;
      const step = () => {
        syncShelfRightInset();
        if (performance.now() < _shelfTrackUntil) {
          this._shelfTrackRaf = requestAnimationFrame(step);
        } else {
          this._shelfTrackRaf = 0;
        }
      };
      this._shelfTrackRaf = requestAnimationFrame(step);
    };
    const onDockChanged = (e: Event) => {
      requestAnimationFrame(syncShelfRightInset);
      const d = (e as CustomEvent).detail || {};
      // The pane-dock CSS vars describe panes docked in the MAIN editor area.
      // A gutter canvas is itself a right-docked pane, so the global
      // right-dock width is its OWN width — applying it as `dockedRightWidth`
      // would push the pocket inset across the whole canvas and pocket every
      // dropped shape. A gutter canvas hosts no docks of its own, so zero them.
      const isGutter = !!this.state.gutterScrollDOM;
      const l = isGutter ? 0 : (+d.leftWidth || 0), r = isGutter ? 0 : (+d.rightWidth || 0);
      const t = isGutter ? 0 : (+d.topHeight || 0), b = isGutter ? 0 : (+d.bottomHeight || 0);
      if (
        this.state.dockedLeftWidth === l && this.state.dockedRightWidth === r
        && this.state.dockedTopHeight === t && this.state.dockedBottomHeight === b
      ) return;
      this.state.dockedLeftWidth = l;
      this.state.dockedRightWidth = r;
      this.state.dockedTopHeight = t;
      this.state.dockedBottomHeight = b;
      this.state.notify("theme");
    };
    queueMicrotask(syncShelfRightInset);
    const onShelfMutate = () => { syncShelfRightInset(); trackShelfInsetDuringTransition(); };
    const shelfObs = new MutationObserver(onShelfMutate);
    shelfObs.observe(this._shelfPanel, { attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", syncShelfRightInset);
    document.addEventListener("pane-dock-changed", onDockChanged);
    this._shelfRightInsetCleanup = () => { shelfObs.disconnect(); window.removeEventListener("resize", syncShelfRightInset); document.removeEventListener("pane-dock-changed", onDockChanged); if (this._shelfTrackRaf) { cancelAnimationFrame(this._shelfTrackRaf); this._shelfTrackRaf = 0; } };
    // Shelf resize handle. Mounted to body so its fixed-position math is independent of the canvas container.
    const shelfResizer = createShelfResizer(this._shelfPanel as ShelfPanelEl, {
      onCommit: (w: number) => {
        const appState = (window as unknown as { __hushState__?: { updateSettings?: (p: Record<string, unknown>) => void } }).__hushState__;
        if (appState && typeof appState.updateSettings === "function") {
          appState.updateSettings({ notebookShelfWidth: w });
        }
        syncShelfRightInset();
      },
      onResize: syncShelfRightInset,
    });
    document.body.appendChild(shelfResizer);
    this._shelfResizer = shelfResizer;

    // Refresh the shelf when panes are added / removed / hidden so its
    // pane rows stay in sync without polling. Pane content edits don't
    // emit this event — they're picked up the next time the shelf
    // rebuilds for any other reason (search input, shape change).
    if (typeof window !== "undefined") {
      const appState = (window as unknown as { __hushState__?: { on(ev: string, fn: () => void): void; off(ev: string, fn: () => void): void } }).__hushState__;
      if (appState && typeof appState.on === "function") {
        const handler = () => this.state.notify("shapes");
        appState.on("notebook-pane-changed", handler);
        this._cleanupPaneListener = () => appState.off("notebook-pane-changed", handler);
      }
    }

    // Initialize undo history with empty canvas
    this.state.initHistory();

    // Sync the pattern CSS variable up front so the sidebar border is
    // correct before the first state change fires.
    this._updatePatternCssVar();

    // Register so the iOS pencil bridge can push `pencilOnly` across
    // every live canvas at once.
    liveCanvases.add(this);
    if (_pencilOnly) this._applyPencilOnly(true);

    // Start render loop
    this._startRenderLoop();
  }

  /** Internal — pushed by `setNotebookPencilOnly`. Forwards to the
   *  drawing layer so the engine drops finger touches. */
  _applyPencilOnly(on: boolean): void {
    if (this._drawingLayer) this._drawingLayer.setPencilOnly(on);
  }

  // === Public API ===

  loadShapes(shapes: Shape[], layers?: import("./types").Layer[], activeLayerId?: string) {
    // Ensure every shape has a layerId; default to the seed / first
    // layer so legacy notebooks render on a real layer.
    const nextLayers = layers && layers.length ? layers : this.state.layers;
    const topLayerId = nextLayers[0]?.id ?? this.state.activeLayerId;
    this.state.layers = nextLayers;
    this.state.activeLayerId = activeLayerId && nextLayers.some((l) => l.id === activeLayerId)
      ? activeLayerId
      : topLayerId;
    this.state.shapes = shapes.map((s) => s.layerId ? s : ({ ...s, layerId: topLayerId }));
    this.state.initHistory();
    this.state.notify("layers");
    this.state.notify("activeLayerId");
    this.state.notify("shapes");
  }

  /** Mirror externally-produced content for the SAME notebook onto this
   *  canvas — pane↔main sync, a remote sync pull, a version restore —
   *  without resetting the undo history the way `loadShapes` (a fresh
   *  hydration) does. The applied state is recorded as a checkpoint, so
   *  ⌘Z on this surface steps back through changes made on the other
   *  surface instead of finding an empty history. */
  mirrorContent(snapshot: {
    shapes: Shape[];
    layers?: import("./types").Layer[];
    flowEdges?: import("./flowchart").FlowEdge[];
    bookmarks?: import("./types").CameraBookmark[];
  }) {
    // Bookmarks travel outside the undo checkpoint — apply them even
    // when the shape content turns out to be identical.
    if (Array.isArray(snapshot.bookmarks)) {
      this.state.bookmarks = snapshot.bookmarks;
      this.state.notify("bookmarks");
    }
    // No-op guard: mirror events can fire for changes that don't touch
    // the shape content (or echo content this side already has).
    // Recording a checkpoint for those would silently clear this
    // surface's redo stack.
    const sameShapes = JSON.stringify(this.state.shapes) === JSON.stringify(snapshot.shapes);
    const sameEdges = !snapshot.flowEdges
      || JSON.stringify(this.state.flowchart.serialize()) === JSON.stringify(snapshot.flowEdges);
    const sameLayers = !snapshot.layers || !snapshot.layers.length
      || JSON.stringify(this.state.layers) === JSON.stringify(snapshot.layers);
    if (sameShapes && sameEdges && sameLayers) return;

    const nextLayers = snapshot.layers && snapshot.layers.length ? snapshot.layers : this.state.layers;
    const topLayerId = nextLayers[0]?.id ?? this.state.activeLayerId;
    this.state.layers = nextLayers;
    if (!nextLayers.some((l) => l.id === this.state.activeLayerId)) {
      this.state.activeLayerId = topLayerId;
      this.state.notify("activeLayerId");
    }
    this.state.shapes = snapshot.shapes.map((s) => s.layerId ? s : ({ ...s, layerId: topLayerId }));
    if (snapshot.flowEdges) this.state.flowchart.deserialize(snapshot.flowEdges);
    // Keep whatever part of the selection survived the mirror.
    const surviving = new Set(this.state.shapes.map((s) => s.id));
    const nextSel = new Set([...this.state.selectedIds].filter((id) => surviving.has(id)));
    if (nextSel.size !== this.state.selectedIds.size) {
      this.state.selectedIds = nextSel;
      this.state.notify("selectedIds");
    }
    this.state.recordHistory();
    this.state.notify("layers");
    this.state.notify("shapes");
  }

  getShapes(): Shape[] {
    return this.state.shapes;
  }

  /** True while a stroke is being drawn on this canvas. The bridge's
   *  autosave defers file writes until pen-up — the save's IPC marshal
   *  blocks the JS thread long enough to drop pointer samples, which
   *  read as straight-line gaps in whatever stroke was in flight. */
  isStrokeInFlight(): boolean {
    return this._drawingLayer?.hasActiveStroke() ?? false;
  }

  /** Apply notebook settings from Hush settings */
  applySettings(opts: {
    appearanceMode?: AppearanceMode;
    themeId?: string;
    backgroundPattern?: BackgroundPattern;
    gridSpacing?: number;
    gridOpacity?: number;
    fontFamily?: string;
    fontSize?: number;
    canvasBackgroundOverride?: string;
    foregroundOverride?: string; headingColorOverride?: string; linkColorOverride?: string;
    backgroundImage?: any;
    maxTextWidth?: number;
    flowConnectMode?: "closest" | "horizontal";
  }) {
    if (opts.appearanceMode !== undefined) this.state.setAppearance(opts.appearanceMode);
    if (opts.themeId !== undefined) this.state.setTheme(opts.themeId);
    if (opts.backgroundPattern !== undefined) { this.state.backgroundPattern = opts.backgroundPattern; this.state.notify("theme"); }
    if (opts.gridSpacing !== undefined) { this.state.gridSpacing = opts.gridSpacing; this.state.notify("theme"); }
    if (opts.gridOpacity !== undefined) { this.state.gridOpacity = opts.gridOpacity; this.state.notify("theme"); }
    if (opts.fontFamily !== undefined) { this.state.fontFamily = opts.fontFamily; this.state.notify("theme"); }
    if (opts.fontSize !== undefined) { this.state.fontSize = opts.fontSize; this.state.notify("fontSize"); }
    if (opts.backgroundImage !== undefined) { this.state.backgroundImage = opts.backgroundImage; this.state.notify("theme"); }
    for (const k of ["canvasBackgroundOverride", "foregroundOverride", "headingColorOverride", "linkColorOverride"] as const) {
      if (opts[k] !== undefined) { (this.state as any)[k] = opts[k]; this.state.notify("theme"); }
    }
    if (opts.maxTextWidth !== undefined && opts.maxTextWidth > 0) {
      this.state.maxTextWidth = opts.maxTextWidth;
    }
    if (opts.flowConnectMode !== undefined) {
      this.state.flowchart.setConnectMode(opts.flowConnectMode);
      this.state.notify("shapes");
    }
  }

  /** Update the left inset (sidebar width) so pocket tray and toolbar adjust. */
  setLeftInset(px: number) {
    this.state.leftInset = px;
    this.state.notify("theme"); // triggers re-render
  }

  /** Update the right inset (shelf width). The pocket tray now lives on
   *  the shelf's left edge, so this needs to track open/close + resize. */
  setRightInset(px: number) {
    if (this.state.rightInset === px) return;
    this.state.rightInset = px;
    this.state.notify("theme");
  }

  /** Expose the drawing-layer handle for the export path. Returns null
   *  when the layer is no longer mounted (post-destroy). */
  getDrawingLayer(): DrawingLayer | null {
    return this._drawingLayer;
  }

  /** Expose the image cache so the export path can draw image shapes
   *  without re-decoding. */
  getImageCache(): Map<string, HTMLImageElement> {
    return this._imageCache;
  }

  on(event: string, handler: (detail: unknown) => void) {
    this.state.addEventListener(event, ((e: CustomEvent) => handler(e.detail)) as EventListener);
  }

  /** Open the shape shelf and focus its search box — the notebook's
   *  equivalent of the doc quick-find bar (Cmd+F). */
  openShelfSearch() {
    (this._shelfPanel as ShelfPanelEl | null)?.__openAndFocusSearch?.();
  }

  destroy() {
    cancelAnimationFrame(this._rafId);
    if (this._cleanupInput) this._cleanupInput();
    if (this._cleanupDropTarget) this._cleanupDropTarget();
    if (this._cleanupPaneListener) { this._cleanupPaneListener(); this._cleanupPaneListener = null; }
    if (this._shelfRightInsetCleanup) { this._shelfRightInsetCleanup(); this._shelfRightInsetCleanup = null; }
    if (this._drawingLayer) { this._drawingLayer.destroy(); this._drawingLayer = null; }
    if (this._shelfResizer) { this._shelfResizer.remove(); this._shelfResizer = null; }
    this.container.innerHTML = "";
    liveCanvases.delete(this);
    if (lastActiveNotebook === this) lastActiveNotebook = null;
    // The text-editor mirrors its active handle onto window for
    // synchronous lookups (command palette, Zotero modal). Clear it on
    // teardown so later code doesn't reach a handle whose textarea was
    // just removed from the DOM.
    if (typeof window !== "undefined") {
      (window as unknown as { __activeNotebookTextEditor: unknown }).__activeNotebookTextEditor = null;
    }
    // Clear the pattern colour so the sidebar border disappears when we leave
    // the notebook view.
    document.documentElement.style.setProperty("--notebook-pattern-color", "transparent");
  }

  /**
   * Place the current selection on the system clipboard as a
   * `canvas-clipboard@1` envelope (text/plain JSON), so paste round-trips
   * back into Hush or into Steiner. Synchronous setData via the copy
   * event is the reliable path on a non-editable canvas; the keydown
   * Cmd+C handler in input-handler.ts is a backstop with the same payload.
   */
  handleCopy(e: ClipboardEvent): boolean {
    const json = this.state.serializeSelection();
    if (!json) return false;
    if (!e.clipboardData) return false;
    e.clipboardData.setData("text/plain", json);
    (window as unknown as { __hushNotebookClipboard?: string }).__hushNotebookClipboard = json;
    e.preventDefault();
    return true;
  }

  /**
   * Push the current dot/grid colour (same hex + alpha the renderer uses)
   * to a CSS variable so other chrome — e.g. the files sidebar's right
   * border in notebook mode — can match it exactly. Set to "transparent"
   * when the pattern is blank or opacity is zero.
   */
  private _updatePatternCssVar() {
    const { backgroundPattern, gridOpacity } = this.state;
    let value = "transparent";
    if (backgroundPattern !== "blank" && gridOpacity > 0) {
      value = hexToRgba(this.state.theme.foreground, gridOpacity * 0.8);
    }
    document.documentElement.style.setProperty("--notebook-pattern-color", value);
  }

  // === Private ===

  /**
   * Mark the canvas dirty and ensure a frame is scheduled. The render
   * loop is no longer free-running — it renders only when state changes
   * (every render-affecting mutation flows through `state.notify`, which
   * fires the "change" event we subscribe to) or while an interaction is
   * mid-flight, then parks itself until the next change. Keeping an idle
   * notebook from repainting 60×/sec is the single biggest power win for
   * canvas-heavy sessions, and multiplies across every live canvas
   * (panes, stack columns, gutters).
   */
  private _scheduleRender = () => {
    this._needsRender = true;
    if (!this._rafId) this._rafId = requestAnimationFrame(this._renderLoop);
  };

  private _renderLoop = () => {
    // Stay frame-locked while an interaction is in flight so motion is
    // smooth even across frames that don't individually flip the dirty
    // flag (e.g. an inertial pan that hasn't notified yet).
    const interacting =
      this.state.isActiveDrag ||
      this.state.strokeEngineDragging ||
      this.state.isPanning ||
      this.state.selectionBox != null ||
      this.state.creatingDragArea != null ||
      this.state.reorderDragAreaId != null;

    // The bookkeeping below has to run even if the frame throws. The loop
    // is dirty-driven: `_rafId` doubles as "a frame is already queued", so
    // a throw that skipped past it would leave a stale non-zero handle
    // with nothing scheduled — `_scheduleRender` would then decline to
    // start a new loop and the canvas would stay frozen on its last
    // (possibly half-painted) frame for the rest of the session.
    try {
      if (this._needsRender || interacting) {
        this._needsRender = false;
        this._renderFrame();
      }
    } finally {
      // Reschedule only if there's a reason to: an active interaction, or a
      // change that landed while we were rendering this frame. Otherwise go
      // idle — `_scheduleRender` restarts us on the next state change.
      if (interacting || this._needsRender) {
        this._rafId = requestAnimationFrame(this._renderLoop);
      } else {
        this._rafId = 0;
      }
    }
  };

  private _startRenderLoop() {
    // Any render-affecting state change schedules a frame.
    this.state.addEventListener("change", this._scheduleRender);
    this._scheduleRender();
  }

  private _renderFrame() {
    perf.begin("render:frame"); // PERF-HUD (temporary)
    try {
      this._renderFrameInner();
    } finally {
      perf.end("render:frame"); // PERF-HUD (temporary)
    }
  }

  private _renderFrameInner() {
    render(this._canvas, {
        shapes: this.state.shapes,
        selectedIds: this.state.selectedIds,
        camera: this.state.camera,
        selectionBox: this.state.selectionBox,
        creatingDragArea: this.state.creatingDragArea,
        editingShapeId: this.state.editingText?.shapeId ?? null,
        imageCache: this._imageCache,
        theme: this.state.theme,
        canvasBackgroundOverride: this.state.canvasBackgroundOverride,
        backgroundImage: (this.state as any).backgroundImage,
        onBgImageLoad: () => this.state.notify("theme"),
        croppingImageId: this.state.croppingImageId,
        fontFamily: this.state.fontFamily,
        backgroundPattern: this.state.backgroundPattern,
        gridSpacing: this.state.gridSpacing,
        gridOpacity: this.state.gridOpacity,
        layers: this.state.layers,
        drawingLayer: this._drawingLayer ?? undefined,
        isDragging: this.state.isActiveDrag,
        pocketProximity: this.state.pocketProximity,
        pocketInZone: this.state.pocketInZone,
        leftInset: this.state.leftInset,
        shadowHeaders: this.state.shadowHeaders,
        gutter: !!this.state.gutterScrollDOM,
        // Inject DPR so renderer.ts stays free of `window` reads.
        dpr: window.devicePixelRatio || 1,
        flowchart: this.state.flowchart,
        flowDropTargetId: this.state.flowDropTargetId,
        flowHoveredEdgeId: this.state.flowHoveredEdgeId,
        flowArrowAlpha: this.state.flowArrowAlpha,
        flowArrowWidth: this.state.flowArrowWidth ?? undefined,
        flowArrowHeadSize: this.state.flowArrowHeadSize ?? undefined,
        flowArrowLineCap: this.state.flowArrowLineCap ?? undefined,
        flowEdgesLocked: this.state.flowEdgesLocked,
        strokeEngineDragging: this.state.strokeEngineDragging,
        reorderDragAreaId: this.state.reorderDragAreaId,
        reorderPreview: this.state.reorderPreview,
        flagColors: getFlagColorsFromHush(),
        touchMode: getTouchModeFromHush(),
        desktopOutlineHover: this.state.desktopOutlineHover,
        fileStickies: getFileStickiesFromHush,
        desktopStickies: getDesktopStickiesFromHush(this.state.desktopStickyTarget),
    });
  }

  private _syncImageCache() {
    // Appearance-aware images (dataUrlDark present) load the variant
    // matching the active theme; a light/dark switch swaps the src in
    // place. The loaded variant is tracked on the element so the check
    // is a cheap string compare rather than a data-URL diff.
    const variant = this.state.theme.variant;
    for (const shape of this.state.shapes) {
      if (shape.type !== "image") continue;
      const cached = this._imageCache.get(shape.id) as (HTMLImageElement & { _hushVariant?: string }) | undefined;
      // Nothing to decode yet (a Desktop pane's placeholder, mid
      // hydration). Setting `src = ""` would resolve against the
      // document URL and load the page as an image — a broken element
      // that never recovers. Wait for the bytes; the notify that brings
      // them re-runs this pass.
      const src = shape.dataUrlDark && variant === "dark" ? shape.dataUrlDark : shape.dataUrl;
      if (!cached && !src) continue;
      if (!cached) {
        const img = new Image() as HTMLImageElement & { _hushVariant?: string };
        // Repaint once the bytes decode — the loop is dirty-driven now,
        // so without this an async-loaded image wouldn't appear until the
        // next unrelated state change.
        img.addEventListener("load", this._scheduleRender);
        img.src = src;
        img._hushVariant = variant;
        this._imageCache.set(shape.id, img);
      } else if (shape.dataUrlDark && cached._hushVariant !== variant) {
        cached.src = variant === "dark" ? shape.dataUrlDark : shape.dataUrl;
        cached._hushVariant = variant;
      }
    }
    const ids = new Set(this.state.shapes.filter((s) => s.type === "image").map((s) => s.id));
    for (const id of this._imageCache.keys()) {
      if (!ids.has(id)) this._imageCache.delete(id);
    }
  }

}

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
