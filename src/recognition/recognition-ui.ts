/**
 * Minimal shared UI for the recognition engine: a progress pill for
 * the one-time ML Kit language-model download, and a transient notice
 * for recognition errors (there's no console to read on iPad).
 * Lives beside the engine so Docs can reuse it later; everything
 * mounts on document.body and is theme-independent.
 */

let downloadEl: HTMLElement | null = null;
let downloadBar: HTMLElement | null = null;
let downloadLabel: HTMLElement | null = null;

const PILL_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed", left: "50%", bottom: "88px", transform: "translateX(-50%)",
  zIndex: "5000", padding: "10px 16px", borderRadius: "10px",
  background: "rgba(24,26,32,0.92)", color: "#f0f3fa",
  font: "12px/1.5 -apple-system, BlinkMacSystemFont, sans-serif",
  boxShadow: "0 4px 16px rgba(0,0,0,0.4)", pointerEvents: "none",
  maxWidth: "min(420px, 85vw)", textAlign: "center",
};

/** Show / update the model-download pill. `fraction` is 0..1 from the
 *  native NSProgress; 0 renders a sliver so the bar reads as alive. */
export function showModelDownloadProgress(fraction: number): void {
  if (!downloadEl || !document.body.contains(downloadEl)) {
    downloadEl = document.createElement("div");
    Object.assign(downloadEl.style, PILL_STYLE);
    downloadLabel = document.createElement("div");
    downloadLabel.textContent = "Downloading handwriting model — one-time, ~20 MB…";
    const track = document.createElement("div");
    Object.assign(track.style, {
      marginTop: "8px", height: "4px", borderRadius: "2px",
      background: "rgba(255,255,255,0.18)", overflow: "hidden",
    });
    downloadBar = document.createElement("div");
    Object.assign(downloadBar.style, {
      height: "100%", width: "3%", borderRadius: "2px",
      background: "#7aa8ff", transition: "width 0.4s ease",
    });
    track.appendChild(downloadBar);
    downloadEl.appendChild(downloadLabel);
    downloadEl.appendChild(track);
    document.body.appendChild(downloadEl);
  }
  const pct = Math.max(0, Math.min(1, fraction));
  if (downloadBar) downloadBar.style.width = `${Math.max(3, Math.round(pct * 100))}%`;
  if (downloadLabel && pct > 0) {
    downloadLabel.textContent = `Downloading handwriting model — one-time, ~20 MB… ${Math.round(pct * 100)}%`;
  }
}

export function hideModelDownloadProgress(): void {
  downloadEl?.remove();
  downloadEl = null;
  downloadBar = null;
  downloadLabel = null;
}

/** Brief bottom-center notice for recognition failures — visible on
 *  iPad where console.error isn't. Auto-dismisses. */
export function flashRecognitionNotice(message: string): void {
  const el = document.createElement("div");
  Object.assign(el.style, PILL_STYLE);
  el.style.background = "rgba(96,28,32,0.94)";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** Human-readable rendering of whatever a recognition path threw —
 *  Tauri command failures arrive as plain strings, engine bugs as
 *  Error objects. */
export function describeRecognitionError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
