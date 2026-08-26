/**
 * Pasting onto a notebook canvas.
 *
 * Two routes, because iPadOS and the desktop disagree about what ⌘V is:
 *
 *   - **The `paste` event.** The browser hands over a `DataTransfer`
 *     with the payload already in it — no permission, no prompt,
 *     nothing to race. Where it arrives it is always the right answer,
 *     and on iPadOS it is the only one that doesn't raise a system
 *     dialog.
 *   - **The ⌘V keydown, reading the OS clipboard ourselves.** Needed
 *     where a non-editable canvas gets no paste event at all, which is
 *     what browsers historically did and why this path exists.
 *
 * The trap this module was extracted to fix: **cancelling the ⌘V keydown
 * is what stops WebKit dispatching the paste event.** Hush cancelled it
 * unconditionally and asked `navigator.clipboard.read()` instead — which
 * on iOS is permission-gated. The read raised a "Paste" dialog and was
 * refused (`NotAllowedError`) while the event carrying the bytes stayed
 * suppressed; the image only landed on the third ⌘V, because the presses
 * after the first went to the dialog and *those* produced real paste
 * events. So on iOS the key is left alone and a short grace timer waits
 * for the event, falling back to the clipboard read only if none comes.
 * Elsewhere the keydown path stays as it was — the desktop reads through
 * the Tauri plugin, which needs no permission and shows no prompt.
 *
 * The second rule, in both routes: **spend the event before the OS
 * clipboard.** Asking for a permission you don't need is not free, and
 * the event's payload is both cheaper and more reliable than anything a
 * later read can tell you.
 *
 * Every branch reports into the Activity Log (Settings → Debug, source
 * `paste`), because on iPad there is no console to fall back on.
 */
import type { DrawingState } from "./state";
import {
  cleanLineBreaks, extractTextFromDataTransfer, fileToDataUrl, getImageDimensions,
} from "./external-content";
import { tryDecode } from "./clipboard-format";
import { getActiveNotebookState } from "./notes-canvas";
import {
  writeText as tauriWriteText, readText as tauriReadText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  readClipboardImageDataUrl, imageFilesFromDataTransfer,
  fetchableImageSrcsFromHtml, filesFromImageSrcs, isIOS,
} from "../clipboard-image.js";
import { logActivity } from "../activity-log.js";
import { describeActiveElement, describeClipboard } from "../paste-diagnostics.js";

const IS_TAURI: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;

/** Cmd+C / V / X bind on `window`, so when several NotesCanvas instances
 *  exist (main canvas + a pane, desk thumbnail, etc.) every state's
 *  handler fires on the same keystroke. Allow only the canvas the user
 *  last interacted with to act — otherwise hidden / 0-sized panes paste
 *  in parallel and the visible canvas's paste lands at unexpected
 *  coordinates. NotesCanvas claims the slot on mount, so a single fresh
 *  notebook always has an active canvas before the user can reach for
 *  the keyboard. Exported for the copy / cut half of the same rule. */
export function isClipboardOwner(state: DrawingState): boolean {
  return getActiveNotebookState() === state;
}

// Tauri's WKWebView blocks `navigator.clipboard.writeText` / `readText`
// from non-editable canvas focus, surfacing the macOS "Paste from..."
// prompt for every read. The clipboard-manager plugin talks to
// NSPasteboard directly and bypasses that UI; the browser build keeps
// the standard navigator API.
export async function writeClipboardText(text: string): Promise<void> {
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

// Dedupe between the keydown Cmd+V path and the document `paste`
// listener: browsers vary on whether they dispatch `paste` when nothing
// editable is focused, so either may be the one that runs.
let lastPasteAt = 0;
const PASTE_DEDUP_MS = 400;
function markPasted() { lastPasteAt = Date.now(); }
function recentlyPasted(): boolean { return Date.now() - lastPasteAt < PASTE_DEDUP_MS; }
/** A paste that marked itself and then failed has to un-mark, or the
 *  dedup window swallows the user's retry as a repeat. */
function unmarkPasted() { lastPasteAt = 0; }
/** Claim the paste for this route, atomically. Both routes can be in
 *  flight at once — iOS's paste dialog is raised by one and answered
 *  with an event that reaches the other — so the check belongs after
 *  *every* await, not only at entry, or the two of them each add the
 *  same image. */
function claimPaste(): boolean {
  if (recentlyPasted()) return false;
  markPasted();
  return true;
}

/** How long ⌘V waits for WebKit to dispatch the paste event before
 *  giving up and reading the clipboard itself. The event, when it comes
 *  at all, comes in the same turn; this is slack, not a guess. */
const PASTE_EVENT_GRACE_MS = 300;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function armPasteFallback(state: DrawingState): void {
  cancelPasteFallback();
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (recentlyPasted()) return;
    logActivity("paste", "warn",
      "No paste event followed Cmd+V — falling back to the clipboard read, which iOS may prompt for");
    void asyncCanvasPaste(state);
  }, PASTE_EVENT_GRACE_MS);
}

function cancelPasteFallback(): void {
  if (fallbackTimer != null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
}

/** True when the paste belongs to some other surface — a text field, a
 *  doc editor, a floating pane, the canvas's own inline text editor. */
function focusIsElsewhere(state: DrawingState): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    if (el.closest?.(".floating-pane")) return true;
  }
  return !!state.editingText;
}

/** Decode a `File` into an image shape. Marks the paste up front so the
 *  other route can't double it, and un-marks on failure so the user's
 *  next ⌘V isn't swallowed as a repeat of one that never landed. */
async function addImageShape(state: DrawingState, file: File, via: string): Promise<boolean> {
  const about = { via, name: file?.name, type: file?.type, size: file?.size };
  if (!claimPaste()) {
    logActivity("paste", "info", "Canvas paste dropped as a duplicate — the other route got there first", about);
    return true;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    const dims = await getImageDimensions(dataUrl);
    state.addImageShape(dataUrl, file.name || "pasted-image", dims.width, dims.height);
    logActivity("paste", "info", "Canvas paste added an image shape", { ...about, ...dims });
    return true;
  } catch (err) {
    unmarkPasted();
    logActivity("paste", "error", "Canvas paste could not read the image", {
      ...about, error: String((err as Error)?.message || err),
    });
    return false;
  }
}

/** An in-app shape envelope, from the clipboard text or the same-session
 *  window stash. The stash is only consulted when the clipboard returned
 *  nothing at all — any non-empty text is the real payload, or an in-app
 *  copy would outlive every later copy from another app. */
function envelopeFrom(text: string) {
  return tryDecode(text) ?? (text ? null : tryDecode((window as unknown as { __hushNotebookClipboard?: string }).__hushNotebookClipboard ?? ""));
}

/**
 * ⌘V on the canvas. Returns true when the caller should cancel the key.
 *
 * On iOS it returns false on purpose: cancelling is what suppresses
 * WebKit's `paste` event, and that event is the only route carrying the
 * bytes without a permission prompt. The grace timer covers the case
 * where no event arrives.
 */
export function handleCanvasPasteShortcut(state: DrawingState): boolean {
  if (!isClipboardOwner(state)) {
    logActivity("paste", "info", "Canvas Cmd+V ignored — another surface owns the clipboard");
    return false;
  }
  if (isIOS()) {
    logActivity("paste", "info", "Canvas Cmd+V — leaving the key uncancelled so the paste event can carry the payload",
      { graceMs: PASTE_EVENT_GRACE_MS });
    armPasteFallback(state);
    return false;
  }
  void asyncCanvasPaste(state);
  return true;
}

/**
 * The document-level `paste` listener. Reads everything it needs out of
 * the event synchronously — a `DataTransfer` is only guaranteed live
 * during its own dispatch — and only asks the OS clipboard once the
 * event has been shown to hold nothing.
 */
export async function handleCanvasPasteEvent(state: DrawingState, e: ClipboardEvent): Promise<void> {
  const cd = e.clipboardData;
  logActivity("paste", "info", "Canvas paste event", {
    clipboardOwner: isClipboardOwner(state),
    activeElement: describeActiveElement(),
    editingText: state.editingText,
    ...describeClipboard(cd),
  });
  if (!isClipboardOwner(state)) return;
  // The main Doc editor's `.cm-content` lives outside `.floating-pane`,
  // so without the contentEditable gate a paste into a doc would also
  // land on whichever canvas was last touched.
  if (focusIsElsewhere(state)) return;
  e.preventDefault();
  // The event beat the ⌘V grace timer — the good case, and the one that
  // costs no permission.
  cancelPasteFallback();
  if (recentlyPasted()) {
    logActivity("paste", "info", `Canvas paste event skipped — a paste landed within the last ${PASTE_DEDUP_MS}ms`);
    return;
  }
  if (!cd) return;

  // Everything the event carries, read before any `await`.
  const rawText = extractTextFromDataTransfer(cd);
  const files = imageFilesFromDataTransfer(cd);
  const html = (() => { try { return cd.getData("text/html") || ""; } catch { return ""; } })();
  const htmlImages = files.length ? { fetchable: [], skipped: [] } : fetchableImageSrcsFromHtml(html);

  const env = envelopeFrom(rawText);
  if (env) {
    if (!claimPaste()) return;
    state.pasteEnvelope(env);
    logActivity("paste", "info", "Canvas paste restored an in-app shape envelope");
    return;
  }
  if (files.length) {
    await addImageShape(state, files[0], "the event's own files");
    return;
  }
  if (htmlImages.fetchable.length) {
    const fetched = await filesFromImageSrcs(htmlImages.fetchable);
    if (fetched.length && await addImageShape(state, fetched[0], "the event's HTML")) return;
  }
  if (rawText && rawText.trim()) {
    if (!claimPaste()) return;
    state.addTextShapeAtCenter(cleanLineBreaks(rawText));
    logActivity("paste", "info", "Canvas paste added a text shape", { chars: rawText.length });
    return;
  }
  // Only now is the OS clipboard worth the prompt it costs on iOS.
  if (htmlImages.skipped.length) {
    logActivity("paste", "info", "Canvas paste HTML held images we can't fetch", { schemes: htmlImages.skipped });
  }
  const osImage = await readClipboardImageDataUrl().catch(() => null);
  if (!osImage) {
    logActivity("paste", "warn", "Canvas paste found nothing — the event was empty and the clipboard read came back with nothing");
    return;
  }
  const dims = await getImageDimensions(osImage);
  if (!claimPaste()) return;
  state.addImageShape(osImage, "pasted-image", dims.width, dims.height);
  logActivity("paste", "info", "Canvas paste added an image shape", { via: "clipboard read", ...dims });
}

/**
 * The keydown route: no event to read, so the OS clipboard is all there
 * is. Text decides — a clipboard carrying text is a text paste, and an
 * in-app shape envelope travels as text — but the image read is *started*
 * first, because its browser half needs the ⌘V gesture's transient
 * activation and awaiting an IPC text read is long enough to spend it.
 */
async function asyncCanvasPaste(state: DrawingState): Promise<void> {
  if (recentlyPasted()) {
    logActivity("paste", "info", `Canvas Cmd+V skipped — a paste landed within the last ${PASTE_DEDUP_MS}ms`);
    return;
  }
  logActivity("paste", "info", "Canvas Cmd+V reading the clipboard", {
    activeElement: describeActiveElement(), editingText: state.editingText,
  });
  if (focusIsElsewhere(state)) return;

  const imageP = readClipboardImageDataUrl().catch(() => null);
  const text = await readClipboardText();

  const env = envelopeFrom(text);
  if (env) {
    if (!claimPaste()) return;
    state.pasteEnvelope(env);
    logActivity("paste", "info", "Canvas Cmd+V restored an in-app shape envelope");
    return;
  }
  if (text && text.trim()) {
    if (!claimPaste()) return;
    state.addTextShapeAtCenter(cleanLineBreaks(text));
    logActivity("paste", "info", "Canvas Cmd+V added a text shape", { chars: text.length });
    return;
  }
  const dataUrl = await imageP;
  if (!dataUrl) {
    logActivity("paste", "warn", "Canvas Cmd+V found nothing — no shapes, no text, no image");
    return;
  }
  const dims = await getImageDimensions(dataUrl);
  // The dialog this read may have raised is answered with a paste event,
  // and that event reaches the other route — so by the time the read
  // finally resolves the image can already be on the canvas.
  if (!claimPaste()) {
    logActivity("paste", "info", "Canvas Cmd+V read resolved after the paste event had already landed");
    return;
  }
  state.addImageShape(dataUrl, "pasted-image", dims.width, dims.height);
  logActivity("paste", "info", "Canvas Cmd+V added an image shape", dims);
}
