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
  on(canvas, "dblclick", (e) => state.handleDoubleClick(e));
  on(canvas, "wheel", (e) => state.handleWheel(e), { passive: false });

  // Two-finger touch to pan
  let twoFingerPanning = false;
  let twoFingerStart = { x: 0, y: 0 };
  let cameraAtTwoFingerStart = { x: 0, y: 0, zoom: 1 };

  on(canvas, "touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      twoFingerPanning = true;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      twoFingerStart = { x: midX, y: midY };
      cameraAtTwoFingerStart = { ...state.camera };
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerPanning && e.touches.length === 2) {
      e.preventDefault();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      state.camera = { x: cameraAtTwoFingerStart.x + (midX - twoFingerStart.x), y: cameraAtTwoFingerStart.y + (midY - twoFingerStart.y), zoom: cameraAtTwoFingerStart.zoom };
      state.notify("camera");
    }
  }, { passive: false });

  on(canvas, "touchend", (e) => {
    if (twoFingerPanning && e.touches.length < 2) twoFingerPanning = false;
  });

  // Space-to-pan state
  let spaceDown = false;
  let toolBeforeSpace: string | null = null;

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (state.editingText) {
      if (e.key === "Escape") { state.commitText(state.editingText); state.editingText = null; state.notify("editingText"); }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Space-to-pan
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      spaceDown = true;
      toolBeforeSpace = state.tool;
      state.isPanning = true;
      state.notify("tool");
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
    // Ctrl+Y as alternative redo (not customizable)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "y" || e.key === "Y")) { e.preventDefault(); state.redo(); }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  on(window as unknown as HTMLElement, "keyup", ((e: KeyboardEvent) => {
    if (e.key === " " && spaceDown) {
      spaceDown = false;
      state.isPanning = false;
      if (toolBeforeSpace) { state.tool = toolBeforeSpace as import("./types").Tool; toolBeforeSpace = null; }
      state.notify("tool");
    }
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Paste
  on(document as unknown as HTMLElement, "paste", (async (e: ClipboardEvent) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
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
    if (text && text.trim()) state.addTextShapeAtCenter(cleanLineBreaks(text));
  }) as unknown as (e: HTMLElementEventMap["paste"]) => void);

  // Drag/drop
  on(window as unknown as HTMLElement, "dragover", ((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-shelf-index") ? "move" : "copy";
  }) as unknown as (e: HTMLElementEventMap["dragover"]) => void, { capture: true });

  on(window as unknown as HTMLElement, "drop", (async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer) return;
    const rect = canvas.getBoundingClientRect();
    const dropPos = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);
    const shelfIdx = e.dataTransfer.getData("application/x-shelf-index");
    if (shelfIdx !== "") { inputOpts?.onShelfDrop?.(parseInt(shelfIdx, 10), dropPos.x, dropPos.y); return; }
    const files = Array.from(e.dataTransfer.files);
    let handledFile = false;
    for (const file of files) {
      if (isImageFile(file)) { const dataUrl = await fileToDataUrl(file); const dims = await getImageDimensions(dataUrl); state.addImageShape(dataUrl, file.name, dims.width, dims.height, dropPos); handledFile = true; }
      else if (isTextFile(file)) { const text = await file.text(); if (text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos); handledFile = true; }
    }
    if (handledFile) return;
    const text = await extractDroppedText(e.dataTransfer);
    if (text && text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos);
  }) as unknown as (e: HTMLElementEventMap["drop"]) => void, { capture: true });

  return () => { for (const fn of cleanups) fn(); };
}
