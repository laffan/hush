import type { DrawingState } from "./state";
import {
  cleanLineBreaks, extractDroppedText, extractTextFromDataTransfer,
  fileToDataUrl, getImageDimensions, isImageFile, isTextFile,
} from "./external-content";
import { screenToCanvas } from "./utils";
import { tryDecode } from "./clipboard-format";
import { getActiveNotebookState } from "./notes-canvas";
import {
  writeText as tauriWriteText, readText as tauriReadText,
} from "@tauri-apps/plugin-clipboard-manager";

/** Cmd+C / V / X bind on `window`, so when several NotesCanvas instances
 *  exist (main canvas + a pane, desk thumbnail, etc.) every state's
 *  handler fires on the same keystroke. Allow only the canvas the user
 *  last interacted with to act — otherwise hidden / 0-sized panes paste
 *  in parallel and the visible canvas's paste lands at unexpected
 *  coordinates. NotesCanvas claims the slot on mount, so a single
 *  fresh notebook always has an active canvas before the user can
 *  reach for the keyboard. */
function isClipboardOwner(state: DrawingState): boolean {
  return getActiveNotebookState() === state;
}

const IS_TAURI: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;

// Tauri's WKWebView blocks `navigator.clipboard.writeText` /
// `readText` from non-editable canvas focus, surfacing the macOS
// "Paste from..." prompt for every read. The clipboard-manager plugin
// talks to NSPasteboard directly and bypasses that UI; the browser
// build keeps the standard navigator API.
async function writeClipboardText(text: string): Promise<void> {
  if (IS_TAURI) {
    try { await tauriWriteText(text); return; } catch { /* fall through */ }
  }
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
}

async function readClipboardText(): Promise<string> {
  if (IS_TAURI) {
    try { return await tauriReadText(); } catch { /* fall through */ }
  }
  try { return await navigator.clipboard.readText(); } catch { return ""; }
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
      twoFingerActive = true;
      twoFingerStartMid = pinchMid(e.targetTouches[0], e.targetTouches[1]);
      twoFingerStartDist = pinchDist(e.targetTouches[0], e.targetTouches[1]);
      cameraAtTwoFingerStart = { ...state.camera };
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerActive && e.targetTouches.length === 2) {
      e.preventDefault();
      const mid = pinchMid(e.targetTouches[0], e.targetTouches[1]);
      const dist = pinchDist(e.targetTouches[0], e.targetTouches[1]);
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

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
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
    // Paste — the browser only fires the `paste` event reliably when an
    // editable element (input/textarea/contenteditable) is focused. The
    // canvas page has no such element by default, so without this handler
    // Cmd+V silently no-ops. Read the clipboard ourselves via the async
    // API; the document `paste` listener stays as a fallback for when a
    // paste *is* dispatched (e.g. native Edit > Paste in Tauri), and the
    // two paths dedupe on `lastPasteAt`.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      if (!isClipboardOwner(state)) return;
      e.preventDefault();
      void asyncCanvasPaste(state);
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
    }
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Cmd / Ctrl press during a drag — expands every parent drag-area to
  // wrap the moving cluster. Mirrors the keyup hook above; pointermove
  // still re-syncs the flag so a press-without-key-event (rare) can't
  // leave the area stale.
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (e.key === "Meta" || e.key === "Control") {
      state.setDragCmdHeld(true);
    }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  // Paste — fires when an editable element is focused (or via native
  // Edit > Paste in Tauri). The Cmd+V keydown handler above covers the
  // canvas-focused case via the async clipboard API. Both paths share
  // `lastPasteAt` to avoid double-pasting if both fire.
  on(document as unknown as HTMLElement, "paste", (async (e: ClipboardEvent) => {
    if (!isClipboardOwner(state)) return;
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    // Skip when focus is in any contenteditable surface — the main Doc
    // editor (CodeMirror's `.cm-content`) lives outside `.floating-pane`
    // so without this gate a paste fired into the Doc would also land
    // on a Notebook-as-pane that happened to be the last-touched canvas.
    if ((document.activeElement as HTMLElement | null)?.isContentEditable) return;
    // Skip if focus is inside a floating pane — let the pane handle its own paste
    if (document.activeElement?.closest(".floating-pane")) return;
    if (state.editingText) return;
    e.preventDefault();
    if (recentlyPasted()) return;
    const cd = e.clipboardData;
    if (!cd) return;

    const rawText = extractTextFromDataTransfer(cd);
    // The window stash is a same-session safety net for when the OS
    // clipboard write was rejected. If the OS clipboard now carries
    // *anything* — even plain text from another app — that's the
    // real payload and the stash must yield. Otherwise an in-app copy
    // followed by an external copy would still paste the in-app
    // shapes, because `tryDecode(rawText)` returns null for the
    // external text and the `??` would fall straight through to the
    // stale envelope.
    const env = tryDecode(rawText) ?? (rawText ? null : tryDecode((window as any).__hushNotebookClipboard ?? ""));
    if (env) {
      markPasted();
      state.pasteEnvelope(env);
      return;
    }

    for (const item of Array.from(cd.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          markPasted();
          const dataUrl = await fileToDataUrl(file);
          const dims = await getImageDimensions(dataUrl);
          state.addImageShape(dataUrl, file.name, dims.width, dims.height);
          return;
        }
      }
    }
    if (rawText && rawText.trim()) {
      markPasted();
      state.addTextShapeAtCenter(cleanLineBreaks(rawText));
    }
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

// Dedupe between the keydown Cmd+V path and the document `paste` listener:
// browsers vary on whether they dispatch `paste` when nothing editable is
// focused, so we always run the keydown path and skip the paste-event work
// if it already ran (or vice-versa).
let lastPasteAt = 0;
const PASTE_DEDUP_MS = 400;
function markPasted() { lastPasteAt = Date.now(); }
function recentlyPasted(): boolean { return Date.now() - lastPasteAt < PASTE_DEDUP_MS; }

async function asyncCanvasPaste(state: DrawingState) {
  if (recentlyPasted()) return;
  // Bail early if the focus is in any editable surface — the paste belongs
  // there, not on the canvas.
  const activeEl = document.activeElement as HTMLElement | null;
  if (activeEl) {
    if (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") return;
    if (activeEl.isContentEditable) return;
    if (activeEl.closest(".floating-pane")) return;
  }
  if (state.editingText) return;

  const text = await readClipboardText();

  // Same-session fallback: only consult the stash when the OS clipboard
  // truly returned nothing. Any non-empty text wins — without this gate
  // an in-app copy persisted across subsequent external copies (the
  // foreign text decoded as `null`, and the `??` fell straight through
  // to the stale shape envelope).
  const env = tryDecode(text) ?? (text ? null : tryDecode((window as any).__hushNotebookClipboard ?? ""));
  if (env) {
    markPasted();
    state.pasteEnvelope(env);
    return;
  }

  // navigator.clipboard.read() returns image blobs on browsers that
  // support it. Best-effort; failures fall through to plain text.
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          const dataUrl = await blobToDataUrl(blob);
          const dims = await getImageDimensions(dataUrl);
          markPasted();
          state.addImageShape(dataUrl, "pasted-image", dims.width, dims.height);
          return;
        }
      }
    }
  } catch {
    // clipboard.read() unsupported — fall through.
  }

  if (text && text.trim()) {
    markPasted();
    state.addTextShapeAtCenter(cleanLineBreaks(text));
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Failed to read blob"));
    r.readAsDataURL(blob);
  });
}
