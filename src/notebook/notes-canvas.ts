import type { Shape } from "./types";
import type { BackgroundPattern } from "./state";
import type { AppearanceMode } from "./themes";
import { DrawingState } from "./state";
import { render } from "./renderer";
import { bindInputEvents, type NotebookShortcuts } from "./input-handler";
import { createToolbar } from "./ui/toolbar";
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
import { createDrawingToolPanel } from "./drawing/tool-panel";

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
  private _imageCache = new Map<string, HTMLImageElement>();
  private _cleanupInput: (() => void) | null = null;
  private _cleanupDropTarget: (() => void) | null = null;
  private _cleanupPaneListener: (() => void) | null = null;
  private _shelfPanel: HTMLElement | null = null;
  private _shelfResizer: HTMLElement | null = null;
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
      if (this.state.isPanning) this._canvas.style.cursor = "grab";
      // Brainstorm mode now behaves like select on the canvas (drag
      // shapes, double-click to add text); the floating input has its
      // own focus / cursor. Show the default arrow so this matches.
      else this._canvas.style.cursor = this.state.brainstormMode ? "default" : (cursorMap[this.state.tool] || "default");
    });

    // Image cache management
    this.state.addEventListener("change", () => this._syncImageCache());

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
    let touchGestureCamStart: { x: number; y: number; zoom: number } | null = null;
    let touchPinchStartMid = { x: 0, y: 0 };
    let touchPinchStartDist = 0;
    let touchPinching = false;
    this._drawingLayer = createDrawingLayer({
      container,
      state: this.state as unknown as import("./drawing/sync-shim").ShimState,
      theme: this.state.theme,
      camera: this.state.camera,
      onTouchPanStart: () => {
        if (!touchGestureCamStart) touchGestureCamStart = { ...this.state.camera };
      },
      onTouchPanMove: (dx, dy) => {
        if (!touchGestureCamStart) return;
        // Pinch path owns the camera while it's active — the pinch
        // formula already accounts for midpoint translation.
        if (touchPinching) return;
        this.state.camera = {
          x: touchGestureCamStart.x + dx,
          y: touchGestureCamStart.y + dy,
          zoom: touchGestureCamStart.zoom,
        };
        this.state.notify("camera");
      },
      onTouchPanEnd: () => {
        if (!touchPinching) touchGestureCamStart = null;
      },
      onTouchPinchStart: (mid, dist) => {
        if (!touchGestureCamStart) touchGestureCamStart = { ...this.state.camera };
        touchPinchStartMid = mid;
        touchPinchStartDist = dist;
        touchPinching = true;
      },
      onTouchPinchMove: (mid, dist) => {
        if (!touchGestureCamStart || touchPinchStartDist <= 0) return;
        const cs = touchGestureCamStart;
        const rawScale = dist / touchPinchStartDist;
        // Match the wheel handler's zoom envelope: [0.25, 1].
        const newZoom = Math.min(1, Math.max(0.25, cs.zoom * rawScale));
        const effectiveScale = newZoom / cs.zoom;
        this.state.camera = {
          x: mid.x - effectiveScale * (touchPinchStartMid.x - cs.x),
          y: mid.y - effectiveScale * (touchPinchStartMid.y - cs.y),
          zoom: newZoom,
        };
        this.state.notify("camera");
      },
      onTouchPinchEnd: () => {
        touchPinching = false;
        touchGestureCamStart = null;
      },
    });
    // Seed the engine with the user's chosen lasso hold duration.
    this._drawingLayer.setLassoHoldMs(this.state.lassoHoldMs);
    this.state.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = (e.detail && e.detail.keys) || [];
      if (!this._drawingLayer) return;
      if (keys.includes("camera")) this._drawingLayer.setCamera(this.state.camera);
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
    // the pill's overflow. Both live inside `container`. The meta
    // pill (drag handle + minimize) sits to the right of the main
    // pill and travels with it when dragged.
    const drawingChrome = createDrawingToolPanel(this.state, this._drawingLayer);
    container.appendChild(drawingChrome.root);
    container.appendChild(drawingChrome.metaPill);
    container.appendChild(drawingChrome.flyout);

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

    container.appendChild(createSelectionToolbar(this.state));
    container.appendChild(createTextEditor(this.state));
    container.appendChild(createBrainstormInput(this.state));
    const bottomToolbar = createToolbar(this.state);
    container.appendChild(bottomToolbar);

    // Mount the drawing-toolbar restore pill (pencil) next to the
    // bottom toolbar; the layout function below positions it to the
    // right of the bottom toolbar with a 10px gap whenever shown.
    container.appendChild(drawingChrome.restorePill);
    const positionRestorePill = () => {
      if (!this.state.drawingToolbarMinimized) return;
      const tbRect = bottomToolbar.getBoundingClientRect();
      const parentRect = container.getBoundingClientRect();
      const left = tbRect.right - parentRect.left + 10;
      drawingChrome.restorePill.style.left = `${left}px`;
      drawingChrome.restorePill.style.transform = "none";
    };
    this.state.addEventListener("change", ((e: CustomEvent) => {
      const keys: string[] = (e.detail && e.detail.keys) || [];
      if (keys.includes("drawingToolbarMinimized") || keys.includes("theme") ||
          keys.includes("isPanning") || keys.includes("brainstormMode") ||
          keys.includes("tool")) {
        // Defer to next frame so the bottom toolbar has rendered any
        // size changes (active tool tints don't change width, but
        // theme/leftInset shifts do).
        requestAnimationFrame(positionRestorePill);
      }
    }) as EventListener);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => positionRestorePill());
      ro.observe(bottomToolbar);
      ro.observe(container);
    }
    requestAnimationFrame(positionRestorePill);

    this._shelfPanel = createShelfPanel(this.state, shelfCallbacks);
    container.appendChild(this._shelfPanel);

    // Shelf resize handle. Mounted to body so its fixed-position math is
    // independent of the canvas container's transform / scroll.
    const shelfResizer = createShelfResizer(this._shelfPanel as ShelfPanelEl, {
      onCommit: (w: number) => {
        const appState = (window as unknown as { __hushState__?: { updateSettings?: (p: Record<string, unknown>) => void } }).__hushState__;
        if (appState && typeof appState.updateSettings === "function") {
          appState.updateSettings({ notebookShelfWidth: w });
        }
      },
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

  getShapes(): Shape[] {
    return this.state.shapes;
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
    if (opts.canvasBackgroundOverride !== undefined) {
      this.state.canvasBackgroundOverride = opts.canvasBackgroundOverride;
      this.state.notify("theme");
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

  destroy() {
    cancelAnimationFrame(this._rafId);
    if (this._cleanupInput) this._cleanupInput();
    if (this._cleanupDropTarget) this._cleanupDropTarget();
    if (this._cleanupPaneListener) { this._cleanupPaneListener(); this._cleanupPaneListener = null; }
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

  private _startRenderLoop() {
    const loop = () => {
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
        // Inject DPR so renderer.ts stays free of `window` reads.
        dpr: window.devicePixelRatio || 1,
        flowchart: this.state.flowchart,
        flowDropTargetId: this.state.flowDropTargetId,
        flowHoveredEdgeId: this.state.flowHoveredEdgeId,
        strokeEngineDragging: this.state.strokeEngineDragging,
        flagColors: getFlagColorsFromHush(),
      });
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _syncImageCache() {
    for (const shape of this.state.shapes) {
      if (shape.type === "image" && !this._imageCache.has(shape.id)) {
        const img = new Image();
        img.src = shape.dataUrl;
        this._imageCache.set(shape.id, img);
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
