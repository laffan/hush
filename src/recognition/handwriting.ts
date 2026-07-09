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
