/**
 * Handwriting recognition engine.
 *
 * Shared home for handwriting → text recognition. Notebooks use it
 * today (the "Recognize handwriting" selection-toolbar action on
 * stroke groups); Docs will route through the same entry points later,
 * so nothing in here may depend on notebook types.
 *
 * The engine is raster-based: callers rasterize their ink (the
 * notebook uses selection-raster.ts at 2×) and hand over a canvas.
 * The pixels go to the `recognize_handwriting` Tauri command, which
 * runs Apple's on-device Vision text recognizer (VNRecognizeTextRequest
 * at the "accurate" level, which handles handwriting) on macOS and
 * iOS. No network, no cloud — recognition happens entirely on device.
 */

const IS_TAURI = typeof window !== "undefined"
  && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** True when the current runtime can recognize handwriting at all —
 *  a Tauri build on an Apple platform. UI uses this to decide whether
 *  to surface recognition affordances. */
export function isHandwritingRecognitionAvailable(): boolean {
  if (!IS_TAURI) return false;
  const probe = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(probe);
}

/** Recognize the handwriting in `canvas`. Resolves to the recognized
 *  text (lines joined with "\n"; empty string when nothing was
 *  legible). Rejects with a message when recognition isn't available
 *  or the recognizer fails. */
export async function recognizeHandwriting(canvas: HTMLCanvasElement): Promise<string> {
  if (!IS_TAURI) throw new Error("Handwriting recognition requires the desktop or iOS app");
  const dataUrl = canvas.toDataURL("image/png");
  const pngBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("recognize_handwriting", { pngBase64 });
}

// ───────────── stroke-based backend (Google ML Kit) ─────────────
//
// The second engine, kept alongside Vision for comparison. ML Kit's
// Digital Ink Recognition works from the pen's actual point sequence
// rather than a raster, which is what Apple's own Scribble does
// internally — but Google only ships it for iOS/Android, so this
// path is iPad-only. The pod is linked into the Tauri iOS project by
// scripts/ios-add-mlkit-pod.mjs.

export interface InkPoint {
  x: number;
  y: number;
  /** Milliseconds. Hush doesn't record pen timing, so callers
   *  synthesize a monotonic sequence. */
  t: number;
}

export interface InkStroke {
  points: InkPoint[];
}

/** True when the ML Kit ink recognizer can run — a Tauri build on
 *  iOS / iPadOS. (iPadOS 13+ reports `MacIntel` for
 *  navigator.platform, so also accept Mac + touch, mirroring
 *  pencil-bridge.js.) */
export function isInkRecognitionAvailable(): boolean {
  if (!IS_TAURI || typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

/** Recognize a stroke sequence with ML Kit. Coordinates should be
 *  relative to the writing area's top-left corner; `writingArea` is
 *  its size in the same units. Resolves to the top candidate ("" when
 *  nothing was legible); rejects when ML Kit isn't linked into the
 *  build or recognition fails.
 *
 *  The first recognition on a device downloads the per-language model
 *  (~20 MB, one time). The Rust side streams NSProgress fractions via
 *  the `mlkit-ink-download-progress` event; a progress pill shows for
 *  the duration so the wait reads as work rather than a hang. */
export async function recognizeHandwritingInk(
  strokes: InkStroke[],
  writingArea: { width: number; height: number },
  language = "en-US",
): Promise<string> {
  if (!IS_TAURI) throw new Error("Handwriting recognition requires the iOS app");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { showModelDownloadProgress, hideModelDownloadProgress } = await import("./recognition-ui");
  const unlisten = await listen<number>("mlkit-ink-download-progress", (e) => {
    showModelDownloadProgress(typeof e.payload === "number" ? e.payload : 0);
  });
  try {
    return await invoke<string>("recognize_handwriting_ink", {
      payload: {
        strokes,
        language,
        writingAreaWidth: writingArea.width,
        writingAreaHeight: writingArea.height,
      },
    });
  } finally {
    unlisten();
    hideModelDownloadProgress();
  }
}
