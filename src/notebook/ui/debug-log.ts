/* Temporary on-screen activity log for debugging handwriting
 * recognition on-device, where there are no devtools to read
 * console.error from. The panel mounts on the first log line and
 * floats above everything; × hides it (the next log line re-opens
 * it), Clear empties it. Remove once the recognition engines have
 * settled.
 */

const MAX_LINES = 200;

let panel: HTMLElement | null = null;
let body: HTMLElement | null = null;

function makeBtn(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    background: "transparent", border: "1px solid rgba(255,255,255,0.25)",
    color: "inherit", borderRadius: "4px", font: "inherit",
    padding: "1px 8px", cursor: "pointer",
  });
  b.addEventListener("click", onClick);
  return b;
}

function ensurePanel(): HTMLElement {
  if (panel && document.body.contains(panel)) {
    panel.style.display = "flex";
    return body as HTMLElement;
  }
  panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", left: "12px", bottom: "70px",
    width: "min(440px, 80vw)", maxHeight: "40vh", zIndex: "5000",
    display: "flex", flexDirection: "column",
    background: "rgba(18,20,26,0.93)", color: "#d6e2ff",
    font: "10px/1.5 ui-monospace, Menlo, monospace",
    borderRadius: "8px", boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
    overflow: "hidden", pointerEvents: "auto",
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", gap: "8px",
    padding: "4px 8px", background: "rgba(255,255,255,0.07)",
    flexShrink: "0",
  });
  const title = document.createElement("span");
  title.textContent = "Recognition log";
  title.style.flex = "1";
  title.style.fontWeight = "600";
  header.appendChild(title);
  header.appendChild(makeBtn("Clear", () => { if (body) body.textContent = ""; }));
  header.appendChild(makeBtn("×", () => { if (panel) panel.style.display = "none"; }));

  body = document.createElement("div");
  Object.assign(body.style, {
    overflowY: "auto", padding: "6px 8px",
    overscrollBehavior: "contain",
  });

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);
  return body;
}

/** Append a timestamped line to the on-screen log (mirrors to the
 *  console for desktop sessions). */
export function nbLog(msg: string): void {
  const target = ensurePanel();
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const line = document.createElement("div");
  line.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}  ${msg}`;
  Object.assign(line.style, { whiteSpace: "pre-wrap", wordBreak: "break-word" });
  target.appendChild(line);
  while (target.childElementCount > MAX_LINES) target.firstElementChild?.remove();
  target.scrollTop = target.scrollHeight;
  console.log("[hush:recognition]", msg);
}

/** Human-readable rendering of whatever a recognition path threw —
 *  Tauri command failures arrive as plain strings, engine bugs as
 *  Error objects. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
