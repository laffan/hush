import type { DrawingState } from "./state";
import {
  cleanLineBreaks, extractDroppedText, extractTextFromDataTransfer,
  fileToDataUrl, getImageDimensions, isImageFile, isTextFile,
} from "./external-content";
import { screenToCanvas } from "./utils";

export interface InputOptions {
  onShelfDrop?: (index: number, x: number, y: number) => void;
}

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
};

/**
 * Test if a KeyboardEvent matches a shortcut string like "Mod+Shift+Z" or "T".
 * "Mod" matches Cmd on Mac, Ctrl elsewhere.
 */
function matchesKey(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+");
  let wantMod = false, wantShift = false, wantAlt = false;
  let key = "";
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === "mod" || lp === "cmdorctrl" || lp === "cmd" || lp === "ctrl" || lp === "meta") wantMod = true;
    else if (lp === "shift") wantShift = true;
    else if (lp === "alt" || lp === "option") wantAlt = true;
    else key = p;
  }
  const hasMod = e.metaKey || e.ctrlKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  // Compare key case-insensitively
  return e.key.toLowerCase() === key.toLowerCase();
}

export function bindInputEvents(
  canvas: HTMLCanvasElement,
  state: DrawingState,
  inputOpts?: InputOptions,
  shortcuts?: Partial<NotebookShortcuts>,
): () => void {
  const sc = { ...DEFAULTS, ...shortcuts };
  const cleanups: (() => void)[] = [];

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
  let cameraAtTwoFingerStart = { x: 0, y: 0, zoom: 1 };

  function pinchMid(t0: Touch, t1: Touch) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }
  function pinchDist(t0: Touch, t1: Touch) {
    const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  on(canvas, "touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      // The first finger's pointerdown has already kicked off a
      // marquee / drag / resize / drag-area on the canvas. Drop it
      // so the chrome doesn't render between the user's fingers.
      state.cancelActiveInteraction();
      twoFingerActive = true;
      twoFingerStartMid = pinchMid(e.touches[0], e.touches[1]);
      twoFingerStartDist = pinchDist(e.touches[0], e.touches[1]);
      cameraAtTwoFingerStart = { ...state.camera };
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerActive && e.touches.length === 2) {
      e.preventDefault();
      const mid = pinchMid(e.touches[0], e.touches[1]);
      const dist = pinchDist(e.touches[0], e.touches[1]);
      // Need a non-zero start distance to compute a ratio. If two
      // fingers landed at the exact same point, fall back to pure pan
      // until they separate.
      const rawScale = twoFingerStartDist > 1 ? dist / twoFingerStartDist : 1;
      // Match the wheel handler's zoom envelope exactly: [0.25, 1].
      const newZoom = Math.min(1, Math.max(0.25, cameraAtTwoFingerStart.zoom * rawScale));
      const effectiveScale = newZoom / cameraAtTwoFingerStart.zoom;
      // Pivot zoom around the *initial* midpoint (M0) and translate
      // by (M1 - M0) — equivalent to "the world point that was under
      // the start midpoint stays under the current midpoint".
      const cs = cameraAtTwoFingerStart;
      state.camera = {
        x: mid.x - effectiveScale * (twoFingerStartMid.x - cs.x),
        y: mid.y - effectiveScale * (twoFingerStartMid.y - cs.y),
        zoom: newZoom,
      };
      state.notify("camera");
    }
  }, { passive: false });

  on(canvas, "touchend", (e) => {
    if (twoFingerActive && e.touches.length < 2) twoFingerActive = false;
  });

  on(canvas, "touchcancel", (e) => {
    if (twoFingerActive && e.touches.length < 2) twoFingerActive = false;
  });

  // Space-to-pan state. `spaceEnabledPan` tracks whether THIS keydown
  // is the one that flipped isPanning on — so a persistent pan from the
  // toolbar grab button survives a space tap-and-release.
  let spaceDown = false;
  let spaceEnabledPan = false;

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (state.editingText) {
      if (e.key === "Escape") { state.endEditingText(); }
      return;
    }
    // Skip if focus is in any editable area. .cm-content (the main document
    // editor) is contentEditable but is neither INPUT nor TEXTAREA; without
    // this guard the canvas handler would swallow space keystrokes meant
    // for the doc editor whenever a notebook canvas is alive anywhere
    // (including notebook panes opened over a doc).
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl) {
      if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") return;
      if (activeEl.isContentEditable) return;
      if (activeEl.closest(".floating-pane")) return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Space-to-pan
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
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

    // Tool shortcuts (single-key, no modifiers)
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (matchesKey(e, sc.shortcutNbSelect)) { state.tool = "select"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbText)) { state.tool = "text"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbDragArea)) { state.tool = "drag-area"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); return; }
      if (matchesKey(e, sc.shortcutNbBrainstorm)) {
        state.brainstormMode = !state.brainstormMode;
        if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
        state.notify("brainstormMode"); return;
      }
    }

    if (matchesKey(e, sc.shortcutNbDelete)) { state.deleteSelected(); return; }
    if (matchesKey(e, sc.shortcutNbUngroup)) { e.preventDefault(); state.ungroupSelected(); return; }
    if (matchesKey(e, sc.shortcutNbGroup)) { e.preventDefault(); state.groupSelected(); return; }
    if (matchesKey(e, sc.shortcutNbRedo)) { e.preventDefault(); state.redo(); return; }
    if (matchesKey(e, sc.shortcutNbUndo)) { e.preventDefault(); state.undo(); return; }

    // Copy / Cut — write the current selection out as a portable
    // clipboard envelope (also dropping a plain-text fallback) so the
    // shapes can be pasted back into Hush, into another Hush window, or
    // into the Steiner project. Cut additionally deletes the source.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C" || e.key === "x" || e.key === "X")) {
      const payload = state.serializeSelection();
      if (!payload) return;
      e.preventDefault();
      const json = JSON.stringify(payload);
      try {
        navigator.clipboard?.writeText(json).catch(() => {});
      } catch { /* ignore */ }
      // Stash on the window so an immediate paste in the same session
      // round-trips even when the OS clipboard write was rejected.
      (window as any).__hushNotebookClipboard = json;
      if (e.key === "x" || e.key === "X") state.deleteSelected();
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
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Paste
  on(document as unknown as HTMLElement, "paste", (async (e: ClipboardEvent) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    // Skip if focus is inside a floating pane — let the pane handle its own paste
    if (document.activeElement?.closest(".floating-pane")) return;
    if (state.editingText) return;
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    for (const item of Array.from(cd.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) { const dataUrl = await fileToDataUrl(file); const dims = await getImageDimensions(dataUrl); state.addImageShape(dataUrl, file.name, dims.width, dims.height); return; }
      }
    }
    const text = extractTextFromDataTransfer(cd);
    // First try to parse as a Hush/Steiner clipboard envelope; only fall
    // back to plain-text shape creation if that fails.
    if (text && text.trim()) {
      const stash = (window as any).__hushNotebookClipboard as string | undefined;
      const candidate = (text.trim().startsWith("{") ? text : null) || stash || null;
      if (candidate) {
        try {
          const parsed = JSON.parse(candidate);
          const fmt = (parsed && typeof parsed.format === "string") ? parsed.format : "";
          if ((fmt === "hush-clipboard" || fmt === "steiner-clipboard") && Array.isArray(parsed.shapes)) {
            state.pasteSerializedShapes(parsed);
            return;
          }
        } catch { /* not JSON — fall through */ }
      }
      state.addTextShapeAtCenter(cleanLineBreaks(text));
    }
  }) as unknown as (e: HTMLElementEventMap["paste"]) => void);

  // Drag/drop — only handle shelf drags and direct canvas drops.
  // External file drops are handled by Hush's file-drop.js which
  // forwards to the canvas via notebook-bridge when appropriate.
  on(canvas, "dragover", ((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-shelf-index") ? "move" : "copy";
  }) as unknown as (e: HTMLElementEventMap["dragover"]) => void);

  on(canvas, "drop", (async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer) return;
    const rect = canvas.getBoundingClientRect();
    const dropPos = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);

    // Shelf item drag-to-restore
    const shelfIdx = e.dataTransfer.getData("application/x-shelf-index");
    if (shelfIdx !== "") { inputOpts?.onShelfDrop?.(parseInt(shelfIdx, 10), dropPos.x, dropPos.y); return; }

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
