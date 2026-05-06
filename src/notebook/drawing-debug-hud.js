/**
 * Drawing-debug HUD — an on-screen log overlay we use to gather
 * diagnostics on the iPad while debugging the pencil bridge / drawing
 * surface. This is only mounted in Tauri builds and only when the
 * `__hushDrawingDebug` global is truthy or in debug iOS builds.
 *
 * The HUD is a small fixed pill in the top-right that expands to a
 * scrollable log panel. It records every pointerdown / pointermove
 * (sampled) / pointerup / pointercancel on the document with the
 * relevant fields (pointerType, button, width/height, target tag),
 * plus engine + bridge events when we instrument them.
 *
 * "Copy" puts the entire log on the clipboard via the Tauri clipboard
 * plugin so the iPad user can paste it into the chat.
 */

import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;
let _initialised = false;

const MAX_ENTRIES = 400;

function isIOS() {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent || "")) return true;
  const tp = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return /Mac/i.test(navigator.platform || "") && tp > 0;
}

export function initDrawingDebugHud() {
  if (_initialised) return;
  _initialised = true;

  // Default-on while we debug iPad drawing. Set window.__hushDrawingDebug
  // = false in the console before reload to suppress.
  const optedOut = typeof window !== "undefined" && window.__hushDrawingDebug === false;
  if (!IS_TAURI || optedOut || !isIOS()) return;

  const startedAt = performance.now();
  const lines = [];
  let enabled = true;
  let collapsed = true;

  function ts() {
    return Math.round(performance.now() - startedAt).toString().padStart(5, " ");
  }

  function push(line) {
    lines.push(`${ts()} ${line}`);
    if (lines.length > MAX_ENTRIES) lines.splice(0, lines.length - MAX_ENTRIES);
    if (!collapsed) renderLog();
  }

  // Public hook so other modules (engine, bridge) can pipe into the log.
  window.__hushDebug = (line) => push(String(line));

  // ---- HUD DOM ----
  const root = document.createElement("div");
  root.id = "hush-drawing-debug-hud";
  Object.assign(root.style, {
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + 8px)",
    right: "8px",
    zIndex: "2147483647",
    pointerEvents: "auto",
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
    fontSize: "11px",
    color: "#fff",
    background: "rgba(0,0,0,0.78)",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: "6px",
    padding: "4px 6px",
    maxWidth: "min(70vw, 520px)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  });

  const header = document.createElement("div");
  Object.assign(header.style, { display: "flex", gap: "6px", alignItems: "center" });

  const toggleBtn = mkBtn("hud", () => {
    collapsed = !collapsed;
    log.style.display = collapsed ? "none" : "block";
    toggleBtn.textContent = collapsed ? "hud" : "hud ▾";
    if (!collapsed) renderLog();
  });

  const onOffBtn = mkBtn("on", () => {
    enabled = !enabled;
    onOffBtn.textContent = enabled ? "on" : "off";
    onOffBtn.style.background = enabled ? "#1f5" : "#666";
    push(enabled ? "[hud] enabled" : "[hud] disabled");
  });
  onOffBtn.style.background = "#1f5";
  onOffBtn.style.color = "#000";

  const copyBtn = mkBtn("copy", async () => {
    const text = lines.join("\n");
    let ok = false;
    try { await tauriWriteText(text); ok = true; } catch (_) {}
    if (!ok) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
    }
    if (!ok) {
      // Last resort: drop into a textarea + select-all so the user can long-press
      // copy. iOS sometimes blocks navigator.clipboard from non-user contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      Object.assign(ta.style, {
        position: "fixed", left: "0", top: "0",
        width: "100vw", height: "100vh", zIndex: "2147483647",
        background: "#000", color: "#fff", fontSize: "12px", padding: "8px",
      });
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const close = mkBtn("close", () => ta.remove());
      Object.assign(close.style, { position: "fixed", top: "8px", right: "8px", zIndex: "2147483648" });
      document.body.appendChild(close);
      return;
    }
    copyBtn.textContent = "copied!";
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1200);
  });

  const clearBtn = mkBtn("clear", () => { lines.length = 0; renderLog(); });

  header.appendChild(toggleBtn);
  header.appendChild(onOffBtn);
  header.appendChild(copyBtn);
  header.appendChild(clearBtn);
  root.appendChild(header);

  const log = document.createElement("pre");
  Object.assign(log.style, {
    display: "none",
    margin: "4px 0 0 0",
    padding: "0",
    maxHeight: "44vh",
    overflowY: "auto",
    overflowX: "auto",
    whiteSpace: "pre",
    color: "#cfe",
    userSelect: "text",
    WebkitUserSelect: "text",
  });
  root.appendChild(log);

  document.body.appendChild(root);

  function renderLog() {
    log.textContent = lines.slice(-200).join("\n");
    log.scrollTop = log.scrollHeight;
  }

  function mkBtn(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      padding: "2px 6px",
      fontFamily: "inherit",
      fontSize: "11px",
      borderRadius: "4px",
      border: "1px solid rgba(255,255,255,0.25)",
      background: "rgba(255,255,255,0.08)",
      color: "#fff",
      cursor: "pointer",
    });
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    // Don't let the HUD eat pointer-events from underlying gesture handlers.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    return b;
  }

  // ---- environment + capability snapshot ----
  push(`UA  ${(navigator.userAgent || "").slice(0, 180)}`);
  push(`PLT ${navigator.platform || ""} maxTouch=${navigator.maxTouchPoints || 0} hasTouch=${"ontouchend" in document}`);
  push(`PE  PointerEvent=${typeof PointerEvent !== "undefined"} touch-action=${getComputedStyle(document.body).touchAction}`);

  // ---- pointer event firehose ----
  const targetTag = (e) => (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : String(e.target);
  let lastMoveLogAt = 0;
  function summarise(e) {
    const x = Math.round(e.clientX), y = Math.round(e.clientY);
    const w = e.width, h = e.height;
    const pid = e.pointerId, pt = e.pointerType, pr = (e.pressure ?? 0).toFixed(2);
    const btn = e.button, btns = e.buttons;
    return `id=${pid} pt=${pt} btn=${btn}/${btns} p=${pr} w=${w} h=${h} xy=${x},${y} tgt=${targetTag(e)}`;
  }

  window.addEventListener("pointerdown", (e) => {
    if (!enabled) return;
    push(`DOWN ${summarise(e)}`);
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (!enabled) return;
    const now = performance.now();
    if (now - lastMoveLogAt < 80) return; // throttle
    lastMoveLogAt = now;
    push(`MOVE ${summarise(e)}`);
  }, true);

  window.addEventListener("pointerup", (e) => {
    if (!enabled) return;
    push(`UP   ${summarise(e)}`);
  }, true);

  window.addEventListener("pointercancel", (e) => {
    if (!enabled) return;
    push(`CXL  ${summarise(e)}`);
  }, true);

  // touchstart for parallel comparison — sometimes iOS reports touches
  // here that the pointer event pipeline skipped.
  window.addEventListener("touchstart", (e) => {
    if (!enabled) return;
    const t = e.targetTouches[0];
    if (!t) return;
    push(`TST  n=${e.targetTouches.length} type=${t.touchType ?? "?"} force=${(t.force ?? 0).toFixed(2)} radius=${t.radiusX?.toFixed?.(0) ?? "?"}x${t.radiusY?.toFixed?.(0) ?? "?"}`);
  }, true);

  push(`[hud] ready — ts in ms since hud-init`);
}
