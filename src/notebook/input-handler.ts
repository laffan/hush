import type { DrawingState } from "./state";
import type { Camera } from "./types";
import {
  cleanLineBreaks, extractDroppedText,
  fileToDataUrl, getImageDimensions, isImageFile, isTextFile,
} from "./external-content";
import { screenToCanvas } from "./utils";
import {
  handleCanvasPasteEvent, handleCanvasPasteShortcut, isClipboardOwner, writeClipboardText,
} from "./canvas-paste";

/** Shortcut keys read from Hush settings (camelCase field names). */
export interface NotebookShortcuts {
  shortcutNbSelect: string;
  shortcutNbText: string;
  shortcutNbDragArea: string;
  shortcutNbBrainstorm: string;
  shortcutNbDelete: string;
  shortcutNbUndo: string;
  shortcutNbRedo: string;
  shortcutNbGroup: string;
  shortcutNbUngroup: string;
  shortcutNbResetZoom: string;
  shortcutNbSplit: string;
  shortcutNbGrab: string;
}

const DEFAULTS: NotebookShortcuts = {
  shortcutNbSelect: "1",
  shortcutNbText: "T",
  shortcutNbDragArea: "A",
  shortcutNbBrainstorm: "B",
  shortcutNbDelete: "Backspace",
  shortcutNbUndo: "Mod+Z",
  shortcutNbRedo: "Mod+Shift+Z",
  shortcutNbGroup: "Mod+G",
  shortcutNbUngroup: "Mod+Shift+G",
  shortcutNbResetZoom: "Mod+0",
  shortcutNbSplit: "S",
  shortcutNbGrab: "G",
};

/**
 * Test if a KeyboardEvent matches a shortcut string like "Mod+Shift+Z" or "T".
 * "Mod" / "CmdOrCtrl" match either primary modifier; the strict "Cmd" and
 * "Ctrl" tokens match only their own key (same semantics as shortcuts.js).
 */
function matchesKey(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+");
  let wantMod = false, wantMeta = false, wantCtrl = false, wantShift = false, wantAlt = false;
  let key = "";
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === "mod" || lp === "cmdorctrl") wantMod = true;
    else if (lp === "cmd" || lp === "meta") wantMeta = true;
    else if (lp === "ctrl") wantCtrl = true;
    else if (lp === "shift") wantShift = true;
    else if (lp === "alt" || lp === "option") wantAlt = true;
    else key = p;
  }
  if (wantMod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (wantMeta !== e.metaKey) return false;
    if (wantCtrl !== e.ctrlKey) return false;
  }
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  // Compare key case-insensitively
  return e.key.toLowerCase() === key.toLowerCase();
}

export function bindInputEvents(
  canvas: HTMLCanvasElement,
  state: DrawingState,
  shortcuts?: Partial<NotebookShortcuts>,
): () => void {
  const sc = { ...DEFAULTS, ...shortcuts };
  const cleanups: (() => void)[] = [];

  /** Switch tools from the keyboard the same way the toolbar does —
   *  including abandoning anything Split / Grab had in flight. */
  function pickTool(tool: "split" | "grab") {
    if (state.tool !== tool) state.dismissSplits();
    state.tool = tool;
    state.brainstormMode = false;
    state.notify("tool");
    state.notify("brainstormMode");
  }

  function on<K extends keyof HTMLElementEventMap>(
    el: EventTarget, type: K, handler: (e: HTMLElementEventMap[K]) => void, listenerOpts?: AddEventListenerOptions,
  ) {
    el.addEventListener(type, handler as EventListener, listenerOpts);
    cleanups.push(() => el.removeEventListener(type, handler as EventListener, listenerOpts));
  }

  // Canvas pointer events
  on(canvas, "pointerdown", (e) => state.handlePointerDown(e));
  on(canvas, "pointermove", (e) => state.handlePointerMove(e));
  on(canvas, "pointerup", (e) => state.handlePointerUp(e));
  // pointercancel fires on iOS when the system grabs the gesture (e.g.
  // safe-area swipe, scroll). Route it through the same teardown so we
  // don't strand `_preTouchSelectedIds` or any other in-flight state.
  on(canvas, "pointercancel", (e) => state.handlePointerUp(e));
  on(canvas, "dblclick", (e) => state.handleDoubleClick(e));
  on(canvas, "wheel", (e) => state.handleWheel(e), { passive: false });

  // Two-finger touch: combined pan + pinch-zoom. Camera at gesture
  // start is the frame of reference for both translation (midpoint
  // delta) and zoom (distance ratio) — pivoted around the start
  // midpoint so the world point under the user's fingers stays put.
  let twoFingerActive = false;
  let twoFingerStartMid = { x: 0, y: 0 };
  let twoFingerStartDist = 0;
  let cameraAtTwoFingerStart: Camera = { x: 0, y: 0, zoom: 1 };
  let scrollTopAtTwoFingerStart = 0;
  // Pinch hysteresis: until the finger spread drifts past this many CSS px
  // the gesture is treated as a pure pan (zoom locked). Without it, the
  // natural wobble in two fingers during a pan produces a continuous stream
  // of micro-zooms that rescale the whole canvas every frame — felt as
  // jitter, and worst on stroke-heavy notebooks where every stroke resamples.
  // Mirrors the drawing engine's PINCH_START (gestures.js).
  const PINCH_ENGAGE_PX = 12;
  let twoFingerZoomEngaged = false;
  // Rotation hysteresis (only consulted when state.canvasRotationEnabled):
  // the pair angle must twist deliberately before the canvas starts
  // turning, so ordinary pans don't wobble the horizon.
  const ROTATE_ENGAGE_RAD = 0.15;
  let twoFingerRotateEngaged = false;
  let twoFingerStartAngle = 0;

  function pinchMid(t0: Touch, t1: Touch) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }
  function pinchDist(t0: Touch, t1: Touch) {
    const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function pinchAngle(t0: Touch, t1: Touch) {
    return Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
  }
  /** The two target touches in identifier order. Mid + dist are
   *  symmetric so TouchList order never mattered before, but the pair
   *  angle flips by π if the list reorders mid-gesture — sort by
   *  identifier so the segment's direction is stable. */
  function orderedPair(list: TouchList): [Touch, Touch] {
    const a = list[0], b = list[1];
    return a.identifier <= b.identifier ? [a, b] : [b, a];
  }
  /** Smallest signed difference between two angles, in (-π, π]. */
  function angDelta(a: number, b: number) {
    const d = a - b;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  on(canvas, "touchstart", (e) => {
    // Use `targetTouches` rather than `touches` so a finger that
    // started on something else (e.g. the on-screen Cmd button) isn't
    // counted as a second canvas touch and doesn't kick the canvas
    // into pinch-zoom while the other hand drags content out.
    if (e.targetTouches.length === 2) {
      e.preventDefault();
      // The first finger's pointerdown has already kicked off a
      // marquee / drag / resize / drag-area on the canvas. Drop it
      // so the chrome doesn't render between the user's fingers.
      state.cancelActiveInteraction();
      const [t0, t1] = orderedPair(e.targetTouches);
      twoFingerActive = true;
      twoFingerZoomEngaged = false;
      twoFingerRotateEngaged = false;
      twoFingerStartMid = pinchMid(t0, t1);
      twoFingerStartDist = pinchDist(t0, t1);
      twoFingerStartAngle = pinchAngle(t0, t1);
      cameraAtTwoFingerStart = { ...state.camera };
      scrollTopAtTwoFingerStart = state.gutterScrollDOM?.scrollTop || 0;
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerActive && e.targetTouches.length === 2) {
      e.preventDefault();
      const [t0, t1] = orderedPair(e.targetTouches);
      const mid = pinchMid(t0, t1);
      const dist = pinchDist(t0, t1);
      const angle = pinchAngle(t0, t1);
      // Gutter mode: zoom is disabled; vertical midpoint delta scrolls
      // the host doc 1:1, horizontal delta still pans camera.x.
      // Camera.y tracks the live scrollTop so the engine sees the
      // correct world rect.
      if (state.gutterScrollDOM) {
        const dx = mid.x - twoFingerStartMid.x;
        const dy = mid.y - twoFingerStartMid.y;
        state.gutterScrollDOM.scrollTop = scrollTopAtTwoFingerStart - dy;
        state.camera = { x: cameraAtTwoFingerStart.x + dx, y: state.gutterCameraOffset - state.gutterScrollDOM.scrollTop, zoom: 1 };
        state.notify("camera");
        return;
      }
      // Zoom + rotation hysteresis. Until the spread drifts past
      // PINCH_ENGAGE_PX (or, with the canvas-rotation option on, the
      // pair angle past ROTATE_ENGAGE_RAD) the gesture is a pure pan —
      // this kills the per-frame micro-zoom jitter that two-finger
      // panning otherwise produces. Every engagement rebaselines the
      // start references to the current frame so the new axis ramps up
      // from the present state with no visible jump.
      const rebase = () => {
        cameraAtTwoFingerStart = { ...state.camera };
        twoFingerStartMid = mid;
        twoFingerStartDist = dist;
        twoFingerStartAngle = angle;
      };
      if (!twoFingerZoomEngaged && Math.abs(dist - twoFingerStartDist) > PINCH_ENGAGE_PX) {
        rebase();
        twoFingerZoomEngaged = true;
      }
      if (state.canvasRotationEnabled && !twoFingerRotateEngaged &&
          Math.abs(angDelta(angle, twoFingerStartAngle)) > ROTATE_ENGAGE_RAD) {
        rebase();
        twoFingerRotateEngaged = true;
      }
      const cs = cameraAtTwoFingerStart;
      // One coherent transform — "the world point that was under the
      // start midpoint stays under the current midpoint" — with zoom
      // scaling and (opt-in) rotation turning about that midpoint.
      // With k = 1 and dTheta = 0 this reduces to a pure midpoint pan.
      // Need a non-zero start distance to compute a ratio; if two
      // fingers landed at the exact same point, hold zoom until they
      // separate. Zoom envelope matches the wheel handler: [0.25, 1].
      const rawScale = twoFingerZoomEngaged && twoFingerStartDist > 1 ? dist / twoFingerStartDist : 1;
      const newZoom = Math.min(1, Math.max(0.25, cs.zoom * rawScale));
      const k = newZoom / cs.zoom;
      const dTheta = twoFingerRotateEngaged ? angDelta(angle, twoFingerStartAngle) : 0;
      const vx = twoFingerStartMid.x - cs.x;
      const vy = twoFingerStartMid.y - cs.y;
      const cos = Math.cos(dTheta), sin = Math.sin(dTheta);
      state.camera = {
        x: mid.x - k * (vx * cos - vy * sin),
        y: mid.y - k * (vx * sin + vy * cos),
        zoom: newZoom,
        rotation: dTheta !== 0 ? (cs.rotation || 0) + dTheta : cs.rotation,
      };
      state.notify("camera");
    }
  }, { passive: false });

  on(canvas, "touchend", (e) => {
    if (twoFingerActive && e.targetTouches.length < 2) twoFingerActive = false;
  });

  on(canvas, "touchcancel", (e) => {
    if (twoFingerActive && e.targetTouches.length < 2) twoFingerActive = false;
  });

  // Space-to-pan state. `spaceEnabledPan` tracks whether THIS keydown
  // is the one that flipped isPanning on — so a persistent pan from the
  // toolbar grab button survives a space tap-and-release.
  let spaceDown = false;
  let spaceEnabledPan = false;

  // Pane this canvas belongs to (null for the main canvas). Used by the
  // global keydown guard so a pane's own canvas can still process input
  // when focus is somewhere else inside the same pane (the title bar,
  // a toolbar button, or — for an inline notebook pane — the host doc's
  // contentEditable, which the canvas click can't blur).
  const ownPane = canvas.closest(".floating-pane") as HTMLElement | null;

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    // While a Desktop takeover is open, only the Desktop's own canvas
    // (and pane canvases floating above it) may act on window keydowns
    // — the hidden main-notebook canvas underneath would otherwise
    // mirror deletes / undos invisibly into the covered file.
    if (document.body.classList.contains("desktop-active")
      && !ownPane && !canvas.closest(".desktop-view")) return;
    if (state.editingText) {
      if (e.key === "Escape") { state.endEditingText(); }
      return;
    }
    // Esc exits reorder mode at any time — checked before the
    // editable-focus guard below so the gesture works even if some
    // peripheral input has stolen focus on this device.
    if (e.key === "Escape" && state.reorderDragAreaId) {
      state.exitReorderMode();
      e.preventDefault();
      return;
    }
    // Esc also backs out of a split-line hover or an in-flight grab —
    // same reasoning: the user may have clicked chrome on the way here,
    // and abandoning a grab must always be one key away.
    if (e.key === "Escape" && state.dismissSplits()) {
      e.preventDefault();
      return;
    }
    // Decide whether this canvas should handle the keystroke. The
    // tricky cases are panes: focus can be in a different pane (skip),
    // in our own pane (handle), or — for an *inline* notebook pane —
    // on the host doc's contentEditable that wraps the canvas. The
    // inline case can't blur the host editor when the user clicks the
    // canvas, so we use `.active` (set on the most-recently-focused
    // pane by pane-manager.focusPane) to tell "user is interacting
    // with this canvas" from "user is typing in the host doc".
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl) {
      const activePane = activeEl.closest(".floating-pane") as HTMLElement | null;
      if (activePane && activePane !== ownPane) return;
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") return;
      // contentEditable focus, editable doesn't wrap us → user is
      // typing somewhere else (a different pane's editor, a stack
      // column, etc.). Skip.
      if (activeEl.isContentEditable && !activeEl.contains(canvas)) return;
      // contentEditable focus that DOES wrap us — only the inline
      // pane case. Require this pane to be the active pane so plain
      // typing in the host doc doesn't trigger our tool shortcuts.
      if (activeEl.isContentEditable && activeEl.contains(canvas)) {
        if (!ownPane || !ownPane.classList.contains("active")) return;
      }
      // Pane canvas, focus is outside every pane (body / sidebar) and
      // not inside a host editable wrapping us — let the main canvas
      // handle.
      if (!activePane && ownPane && !activeEl.contains(canvas)) return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Space-to-pan. We preventDefault on every space (including OS-
    // auto-repeated keydowns) so an inline notebook canvas hosted
    // inside a doc editor's contentEditable doesn't leak the held-
    // down spaces into the doc as inserted characters.
    if (e.key === " ") {
      e.preventDefault();
      if (e.repeat) return;
      spaceDown = true;
      // Only flip isPanning if it wasn't already on (persistent grab
      // tool). Tracks whether we were the one who turned it on so
      // keyup doesn't kill a pre-existing persistent pan.
      if (!state.isPanning) {
        spaceEnabledPan = true;
        state.isPanning = true;
        state.notify("isPanning");
      }
      return;
    }

    // Tool shortcuts (single-key, no modifiers). When this canvas
    // belongs to a pane whose focus is technically on a host editable
    // (inline notebook pane case), preventDefault keeps those letters
    // from being typed into the host doc as well.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const inHostEditable = !!activeEl?.isContentEditable && activeEl.contains(canvas);
      const preventTypingLeak = () => { if (inHostEditable) e.preventDefault(); };
      if (matchesKey(e, sc.shortcutNbSelect)) { preventTypingLeak(); state.tool = "select"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbText)) { preventTypingLeak(); state.tool = "text"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbDragArea)) { preventTypingLeak(); state.tool = "drag-area"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbBrainstorm)) {
        preventTypingLeak();
        state.brainstormMode = !state.brainstormMode;
        if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
        state.notify("brainstormMode"); return;
      }
      if (matchesKey(e, sc.shortcutNbSplit)) { preventTypingLeak(); pickTool("split"); return; }
      if (matchesKey(e, sc.shortcutNbGrab)) { preventTypingLeak(); pickTool("grab"); return; }
    }

    if (matchesKey(e, sc.shortcutNbDelete)) { state.deleteSelected(); return; }
    if (matchesKey(e, sc.shortcutNbUngroup)) { e.preventDefault(); state.ungroupSelected(); return; }
    if (matchesKey(e, sc.shortcutNbGroup)) { e.preventDefault(); state.groupSelected(); return; }
    if (matchesKey(e, sc.shortcutNbRedo)) { e.preventDefault(); state.redo(); return; }
    if (matchesKey(e, sc.shortcutNbUndo)) { e.preventDefault(); state.undo(); return; }
    if (matchesKey(e, sc.shortcutNbResetZoom)) {
      e.preventDefault();
      // Reset zoom also squares up any two-finger canvas rotation —
      // it's the "straighten everything out" escape hatch.
      state.camera = { ...state.camera, zoom: 1, rotation: 0 };
      state.notify("camera");
      return;
    }

    // Cmd+Arrow aligns the current selection along the named edge;
    // Cmd+Shift+Arrow distributes along the axis of the arrow (so
    // horizontal arrows distribute horizontally, vertical arrows
    // distribute vertically). Only fires when 2+ (align) / 3+ (distribute)
    // shapes are selected; otherwise the state helpers no-op and we still
    // swallow the event so the OS doesn't act on the arrow.
    if ((e.metaKey || e.ctrlKey) && !e.altKey
        && (e.key === "ArrowLeft" || e.key === "ArrowRight"
         || e.key === "ArrowUp"   || e.key === "ArrowDown")) {
      if (state.selectedIds.size < 2) return;
      e.preventDefault();
      if (e.shiftKey) {
        const axis: "horizontal" | "vertical" =
          (e.key === "ArrowLeft" || e.key === "ArrowRight") ? "horizontal" : "vertical";
        state.distributeSelected(axis);
      } else {
        const direction =
          e.key === "ArrowLeft"  ? "left"  :
          e.key === "ArrowRight" ? "right" :
          e.key === "ArrowUp"    ? "top"   : "bottom";
        state.alignSelected(direction);
      }
      return;
    }

    // Copy / Cut — write the current selection out as a `canvas-clipboard@1`
    // envelope so the shapes can be pasted back into Hush, into another Hush
    // window, or into Steiner. Cut additionally deletes the source.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X")) {
      if (!isClipboardOwner(state)) return;
      const payload = state.serializeSelection();
      if (!payload) return;
      e.preventDefault();
      void writeClipboardText(payload);
      // Stash on the window so an immediate paste in the same session
      // round-trips even when the OS clipboard write was rejected.
      (window as any).__hushNotebookClipboard = payload;
      if (e.key === "x" || e.key === "X") state.deleteSelected();
      return;
    }
    // Paste — see canvas-paste.ts. Whether the key gets cancelled is
    // the whole question there and not ours to answer: cancelling is
    // what stops WebKit dispatching the `paste` event that carries the
    // payload, so on iOS it deliberately isn't.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      if (handleCanvasPasteShortcut(state)) e.preventDefault();
      return;
    }
    // Ctrl+Y as alternative redo (not customizable)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "y" || e.key === "Y")) { e.preventDefault(); state.redo(); }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  on(window as unknown as HTMLElement, "keyup", ((e: KeyboardEvent) => {
    if (e.key === " " && spaceDown) {
      spaceDown = false;
      if (spaceEnabledPan) {
        spaceEnabledPan = false;
        state.isPanning = false;
        state.notify("isPanning");
      }
    }
    // Cmd / Ctrl release during a drag — contracts any tracked drag-area
    // back toward its original bounds. The Touch-mode Cmd button
    // synthesises a Meta keyup, so this listener catches both paths.
    if (e.key === "Meta" || e.key === "Control") {
      state.setDragCmdHeld(false);
      state.setSplitVertical(false);
    }
    // Releasing Shift ends the wheel's axis lock, so the next
    // shift-held gesture is free to pick a different axis.
    if (e.key === "Shift") state.clearWheelAxisLock();
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Cmd / Ctrl press during a drag — expands every parent drag-area to
  // wrap the moving cluster. Mirrors the keyup hook above; pointermove
  // still re-syncs the flag so a press-without-key-event (rare) can't
  // leave the area stale.
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (e.key === "Meta" || e.key === "Control") {
      state.setDragCmdHeld(true);
      // ⌘ turns the Split / Grab rule from horizontal to vertical. Bound
      // to the modifier itself, not to pointer state, so the preview
      // flips under a stationary cursor.
      state.setSplitVertical(true);
    }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  // Paste — fires when an editable element is focused, when the user
  // confirms iOS's paste UI, and (where the browser obliges) on a plain
  // ⌘V with nothing editable focused. canvas-paste.ts owns what happens
  // next; both routes dedupe there.
  on(document as unknown as HTMLElement, "paste", ((e: ClipboardEvent) => {
    void handleCanvasPasteEvent(state, e);
  }) as unknown as (e: HTMLElementEventMap["paste"]) => void);

  // Drag/drop — direct canvas drops only.
  // External file drops are handled by Hush's file-drop.js which
  // forwards to the canvas via notebook-bridge when appropriate.
  on(canvas, "dragover", ((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }) as unknown as (e: HTMLElementEventMap["dragover"]) => void);

  on(canvas, "drop", (async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer) return;
    const rect = canvas.getBoundingClientRect();
    const dropPos = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);

    // Cmd/Ctrl-drag of plain text formats the dropped text as a
    // markdown blockquote at 14px — for pasting reference quotes
    // from outside the app without follow-up reformatting.
    const asQuote = e.metaKey || e.ctrlKey || !!(window as unknown as { __hushCmdHeld?: boolean }).__hushCmdHeld;
    const formatText = (t: string) => asQuote ? `> ${t}` : t;
    const textOpts = asQuote ? { fontSize: 14 } : undefined;

    // File drops (images, text) — direct canvas drops
    const files = Array.from(e.dataTransfer.files);
    let handledFile = false;
    for (const file of files) {
      if (isImageFile(file)) { const dataUrl = await fileToDataUrl(file); const dims = await getImageDimensions(dataUrl); state.addImageShape(dataUrl, file.name, dims.width, dims.height, dropPos); handledFile = true; }
      else if (isTextFile(file)) { const text = await file.text(); if (text.trim()) state.addTextShapeAtPosition(formatText(cleanLineBreaks(text)), dropPos, textOpts); handledFile = true; }
    }
    if (handledFile) return;

    // Plain text drops
    const text = await extractDroppedText(e.dataTransfer);
    if (text && text.trim()) state.addTextShapeAtPosition(formatText(cleanLineBreaks(text)), dropPos, textOpts);
  }) as unknown as (e: HTMLElementEventMap["drop"]) => void);

  return () => { for (const fn of cleanups) fn(); };
}
