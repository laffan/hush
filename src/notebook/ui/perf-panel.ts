/**
 * TEMPORARY stroke-engine perf panel.
 *
 * A small "PERF" pill sits in the notebook's top-left; expanding it
 * reveals the test harness (Create Template / Generate Text — see
 * perf-harness.ts) plus a live metrics readout and a copyable log:
 *
 *   - FPS (1 s rolling) and worst frame in the last window
 *   - frame stalls > 150 ms (logged)
 *   - stroke / point counts
 *   - recordHistory (undo snapshot) duration per commit
 *   - undo / redo duration
 *   - autosave encode/write/version-snapshot timings + payload size
 *     (emitted by notebook-bridge.js as "hush-notebook-save-perf")
 *   - window errors / unhandled rejections / console.error mirrors
 *
 * Everything here is instrumentation-only: it wraps state methods at
 * mount and restores them on destroy. Remove this file (and its mount
 * in notebook-bridge.js) when the perf work lands.
 */

import type { DrawingState } from "../state";
import { h } from "./dom-helpers";
import {
  createTemplate,
  generateHandwriting,
  createCancelToken,
  type CancelToken,
} from "../perf-harness";

const MAX_LOG_LINES = 800;

export interface PerfPanelHandle {
  el: HTMLElement;
  destroy: () => void;
}

export function createPerfPanel(state: DrawingState): PerfPanelHandle {
  const t0 = performance.now();
  const stamp = () => `[+${((performance.now() - t0) / 1000).toFixed(1)}s]`;

  // ---------- root ----------
  const root = h("div", {
    style: {
      position: "absolute", top: "8px", left: "8px", zIndex: "600",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  });

  const pill = h("button", {
    text: "PERF",
    style: {
      border: "none", borderRadius: "10px", padding: "4px 10px",
      background: "rgba(17,24,39,0.85)", color: "#fbbf24",
      fontSize: "11px", fontWeight: "700", cursor: "pointer",
      letterSpacing: "1px",
    },
  });

  const panel = h("div", {
    style: {
      display: "none", flexDirection: "column", marginTop: "6px",
      width: "340px", maxHeight: "72vh",
      background: "rgba(17,24,39,0.94)", color: "#e5e7eb",
      borderRadius: "10px", padding: "10px", gap: "8px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    },
  });
  root.appendChild(pill);
  root.appendChild(panel);

  let open = false;
  pill.addEventListener("click", () => {
    open = !open;
    panel.style.display = open ? "flex" : "none";
  });

  // ---------- metrics ----------
  const metricsEl = h("div", {
    style: {
      display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px",
      fontSize: "10px", lineHeight: "1.5",
    },
  });

  interface Metrics {
    fps: number; worstMs: number;
    strokes: number; pointsK: number;
    histMs: number; histCalls: number;
    undoMs: number;
    encodeMs: number; saveMs: number; snapMs: number; bytes: number;
    heapMB: number;
    errors: number;
  }
  const m: Metrics = {
    fps: 0, worstMs: 0, strokes: 0, pointsK: 0, histMs: 0, histCalls: 0,
    undoMs: 0, encodeMs: 0, saveMs: 0, snapMs: 0, bytes: 0, heapMB: 0, errors: 0,
  };

  function metricRows(): [string, string][] {
    return [
      ["fps", `${m.fps} (worst ${m.worstMs.toFixed(0)}ms)`],
      ["strokes", `${m.strokes} · ${m.pointsK.toFixed(1)}k pts`],
      ["undo snapshot", `${m.histMs.toFixed(1)}ms × ${m.histCalls} commits`],
      ["undo/redo", m.undoMs ? `${m.undoMs.toFixed(0)}ms` : "—"],
      ["autosave", m.bytes
        ? `enc ${m.encodeMs.toFixed(0)}ms · ${(m.bytes / 1048576).toFixed(2)}MB · write ${m.saveMs.toFixed(0)}ms · ver ${m.snapMs.toFixed(0)}ms`
        : "—"],
      ["js heap", m.heapMB ? `${m.heapMB.toFixed(0)}MB` : "n/a"],
      ["errors", `${m.errors}`],
    ];
  }

  function renderMetrics() {
    metricsEl.textContent = "";
    for (const [k, v] of metricRows()) {
      metricsEl.appendChild(h("div", { text: k, style: { color: "#9ca3af" } }));
      metricsEl.appendChild(h("div", { text: v, style: { color: "#e5e7eb" } }));
    }
  }

  // ---------- log ----------
  const logEl = h("div", {
    style: {
      flex: "1", minHeight: "80px", maxHeight: "34vh", overflowY: "auto",
      background: "rgba(0,0,0,0.35)", borderRadius: "6px", padding: "6px",
      fontSize: "10px", lineHeight: "1.45", whiteSpace: "pre-wrap",
      userSelect: "text",
    } as Partial<CSSStyleDeclaration>,
  });
  const logLines: string[] = [];

  function log(msg: string) {
    const line = `${stamp()} ${msg}`;
    logLines.push(line);
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    const nearBottom = logEl.scrollTop + logEl.clientHeight > logEl.scrollHeight - 30;
    logEl.appendChild(h("div", { text: line }));
    while (logEl.childNodes.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild!);
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- FPS sampler ----------
  let rafId = 0;
  let frameCount = 0;
  let windowStart = performance.now();
  let worstInWindow = 0;
  let lastFrame = performance.now();
  let lastStallLog = 0;
  let generating = false;
  let lastGenSummaryLog = 0;

  function frame(now: number) {
    const delta = now - lastFrame;
    lastFrame = now;
    frameCount++;
    if (delta > worstInWindow) worstInWindow = delta;
    if (delta > 150 && now - lastStallLog > 2000) {
      lastStallLog = now;
      log(`frame stall ${delta.toFixed(0)}ms (strokes ${m.strokes})`);
    }
    if (now - windowStart >= 1000) {
      m.fps = Math.round((frameCount * 1000) / (now - windowStart));
      m.worstMs = worstInWindow;
      frameCount = 0;
      worstInWindow = 0;
      windowStart = now;
      if (generating && now - lastGenSummaryLog > 5000) {
        lastGenSummaryLog = now;
        log(`sample: fps ${m.fps} · worst ${m.worstMs.toFixed(0)}ms · strokes ${m.strokes} · hist ${m.histMs.toFixed(1)}ms · enc ${m.encodeMs.toFixed(0)}ms/${(m.bytes / 1048576).toFixed(2)}MB`);
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  // ---------- shape counter + display refresh ----------
  const tick = window.setInterval(() => {
    let strokes = 0, points = 0;
    for (const s of state.shapes) {
      if (s.type === "draw") { strokes++; points += s.points.length; }
    }
    m.strokes = strokes;
    m.pointsK = points / 1000;
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    if (perf.memory) m.heapMB = perf.memory.usedJSHeapSize / 1048576;
    // The files sidebar floats over the canvas's left edge — keep the
    // pill inboard of it (leftInset tracks the sidebar width).
    const inset = (state as unknown as { leftInset?: number }).leftInset || 0;
    root.style.left = `${inset + 8}px`;
    if (open) renderMetrics();
  }, 500);

  // ---------- instrumentation wraps ----------
  const stateAny = state as unknown as Record<string, unknown>;
  const origRecord = state.recordHistory.bind(state);
  stateAny.recordHistory = () => {
    const s0 = performance.now();
    origRecord();
    m.histMs = performance.now() - s0;
    m.histCalls++;
    if (m.histMs > 100) log(`slow undo snapshot: ${m.histMs.toFixed(0)}ms at ${m.strokes} strokes`);
  };
  const origUndo = state.undo.bind(state);
  stateAny.undo = () => {
    const s0 = performance.now();
    origUndo();
    m.undoMs = performance.now() - s0;
    log(`undo took ${m.undoMs.toFixed(0)}ms`);
  };
  const origRedo = state.redo.bind(state);
  stateAny.redo = () => {
    const s0 = performance.now();
    origRedo();
    m.undoMs = performance.now() - s0;
    log(`redo took ${m.undoMs.toFixed(0)}ms`);
  };

  const onSavePerf = (e: Event) => {
    const d = (e as CustomEvent).detail || {};
    m.encodeMs = d.encodeMs ?? 0;
    m.saveMs = d.saveMs ?? 0;
    m.snapMs = d.snapshotMs ?? 0;
    m.bytes = d.bytes ?? 0;
    if (m.encodeMs + m.saveMs + m.snapMs > 250) {
      log(`slow autosave: enc ${m.encodeMs.toFixed(0)}ms · write ${m.saveMs.toFixed(0)}ms · ver ${m.snapMs.toFixed(0)}ms · ${(m.bytes / 1048576).toFixed(2)}MB`);
    }
  };
  document.addEventListener("hush-notebook-save-perf", onSavePerf);

  const onError = (e: ErrorEvent) => {
    m.errors++;
    log(`ERROR: ${e.message} (${e.filename?.split("/").pop() || "?"}:${e.lineno})`);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    m.errors++;
    log(`UNHANDLED REJECTION: ${String(e.reason).slice(0, 300)}`);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    m.errors++;
    try { log(`console.error: ${args.map((a) => String(a)).join(" ").slice(0, 300)}`); } catch { /* noop */ }
    origConsoleError.apply(console, args);
  };

  // ---------- buttons ----------
  const btnStyle: Partial<CSSStyleDeclaration> = {
    border: "1px solid rgba(255,255,255,0.2)", borderRadius: "6px",
    background: "rgba(255,255,255,0.08)", color: "#e5e7eb",
    fontSize: "11px", padding: "4px 8px", cursor: "pointer",
  };

  let cancelToken: CancelToken | null = null;

  const templateBtn = h("button", {
    text: "Create template", style: btnStyle,
    onClick: () => {
      const created = createTemplate(state);
      log(created
        ? `template: created ${created} letter boxes — handwrite each letter inside its box`
        : "template: boxes already exist (write in them, then Generate text)");
    },
  });

  const generateBtn = h("button", { text: "Generate text", style: btnStyle, onClick: openModal });
  const stopBtn = h("button", {
    text: "Stop", style: { ...btnStyle, display: "none", color: "#fca5a5" },
    onClick: () => { if (cancelToken) cancelToken.cancelled = true; },
  });

  const copyBtn = h("button", {
    text: "Copy log", style: btnStyle,
    onClick: async () => {
      const header = [
        `hush stroke-perf log — ${new Date().toISOString()}`,
        `ua: ${navigator.userAgent}`,
        ...metricRows().map(([k, v]) => `${k}: ${v}`),
        "----",
      ];
      const text = header.concat(logLines).join("\n");
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
      if (!ok) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch { ok = false; }
        ta.remove();
      }
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => { copyBtn.textContent = "Copy log"; }, 1500);
    },
  });

  const clearBtn = h("button", {
    text: "Clear", style: btnStyle,
    onClick: () => { logLines.length = 0; logEl.textContent = ""; },
  });

  const row1 = h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" }, children: [templateBtn, generateBtn, stopBtn] });
  const row2 = h("div", { style: { display: "flex", gap: "6px" }, children: [copyBtn, clearBtn] });

  panel.appendChild(h("div", { text: "Stroke perf harness (temporary)", style: { fontSize: "11px", fontWeight: "700", color: "#fbbf24" } }));
  panel.appendChild(row1);
  panel.appendChild(metricsEl);
  panel.appendChild(logEl);
  panel.appendChild(row2);

  // ---------- generate modal ----------
  function openModal() {
    if (generating) { log("generate: already running (use Stop first)"); return; }
    const overlay = h("div", {
      style: {
        position: "fixed", inset: "0", zIndex: "700",
        background: "rgba(0,0,0,0.4)", display: "flex",
        alignItems: "center", justifyContent: "center",
      },
    });
    const input = h("input", {
      attrs: { type: "number", min: "10", max: "20000", value: "1000" },
      style: {
        width: "110px", fontSize: "13px", padding: "4px 6px",
        borderRadius: "6px", border: "1px solid #4b5563",
        background: "#111827", color: "#e5e7eb",
      },
    }) as HTMLInputElement;
    const start = h("button", {
      text: "Generate", style: { ...btnStyle, background: "#2563eb", border: "none" },
      onClick: () => { overlay.remove(); runGeneration(Math.max(10, Number(input.value) || 1000)); },
    });
    const cancel = h("button", { text: "Cancel", style: btnStyle, onClick: () => overlay.remove() });
    overlay.appendChild(h("div", {
      style: {
        background: "rgba(17,24,39,0.98)", color: "#e5e7eb", borderRadius: "10px",
        padding: "16px", display: "flex", flexDirection: "column", gap: "10px",
        width: "300px", fontFamily: "inherit",
      },
      children: [
        h("div", { text: "Generate handwriting", style: { fontWeight: "700", fontSize: "13px" } }),
        h("div", { text: "Words to generate (paragraphs of ~200 words). Strokes are cloned from your template letters and committed one at a time, like real writing.", style: { fontSize: "11px", color: "#9ca3af", lineHeight: "1.4" } }),
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center" }, children: [h("span", { text: "Words:", style: { fontSize: "12px" } }), input] }),
        h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" }, children: [cancel, start] }),
      ],
    }));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  async function runGeneration(words: number) {
    generating = true;
    cancelToken = createCancelToken();
    stopBtn.style.display = "";
    generateBtn.style.opacity = "0.5";
    try {
      await generateHandwriting(state, { words }, {
        onLog: log,
        onProgress: ({ strokes, words: done, totalWords }) => {
          if (done % 100 === 0) log(`progress: ${done}/${totalWords} words · ${strokes} strokes`);
        },
        onDone: ({ strokes, points, words: done, elapsedMs, cancelled }) => {
          log(`generate ${cancelled ? "stopped" : "done"}: ${done} words · ${strokes} strokes · ${points} pts · ${(elapsedMs / 1000).toFixed(1)}s · ${(strokes / (elapsedMs / 1000)).toFixed(1)} strokes/s`);
        },
      }, cancelToken);
    } catch (e) {
      m.errors++;
      log(`generate crashed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      generating = false;
      cancelToken = null;
      stopBtn.style.display = "none";
      generateBtn.style.opacity = "";
    }
  }

  log("perf panel ready — Create Template, handwrite a–z, then Generate Text");
  root.style.left = `${((state as unknown as { leftInset?: number }).leftInset || 0) + 8}px`;
  renderMetrics();

  // ---------- teardown ----------
  function destroy() {
    cancelAnimationFrame(rafId);
    window.clearInterval(tick);
    document.removeEventListener("hush-notebook-save-perf", onSavePerf);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    console.error = origConsoleError;
    if (cancelToken) cancelToken.cancelled = true;
    delete stateAny.recordHistory;
    delete stateAny.undo;
    delete stateAny.redo;
    root.remove();
  }

  return { el: root, destroy };
}
