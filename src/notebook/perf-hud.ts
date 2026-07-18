/* PERF-HUD (temporary) — on-canvas performance diagnostics overlay.
 *
 * Built to chase the notebook panning lag on-device (iPad has no
 * console). Mounted by notebook-bridge.js on the main canvas; remove
 * by deleting this file and every line tagged `PERF-HUD` (grep for it).
 * See PANNING-FIX.md → "ROUND 3" for how to read the numbers.
 *
 * Two halves:
 *   - a tracer singleton (`perf`) that instrumented call sites feed
 *     with sections (sync spans), async spans, and counters;
 *   - a floating overlay that watches rAF frame gaps, attributes any
 *     stall ≥ 50 ms to the sections that ran inside it, and renders a
 *     live report with a Copy button so results can be pasted back.
 *
 * Sync spans (begin/end) are kept in a ring so a main-thread stall can
 * be broken down into "which instrumented code ran during the gap";
 * whatever isn't covered shows as `other` (GC, WebKit layout/paint,
 * uninstrumented JS). Async spans (awaited work) are listed separately
 * and deliberately excluded from stall attribution — their duration is
 * mostly off-thread.
 */

interface SectionStat { count: number; totalMs: number; maxMs: number; lastMs: number }
interface Span { name: string; t0: number; t1: number }
interface Stall { atMs: number; gapMs: number; parts: [string, number][]; otherMs: number }

const SPAN_RING_MAX = 500;
const STALL_MS = 50;
const STALL_LOG_MAX = 12;

class PerfTracer {
  startedAt = (typeof performance !== "undefined" ? performance.now() : 0);
  sections = new Map<string, SectionStat>();
  asyncSections = new Map<string, SectionStat>();
  counters = new Map<string, number>();
  spanRing: Span[] = [];
  stalls: Stall[] = [];
  onStall: ((s: Stall) => void) | null = null;
  private _open = new Map<string, number>();

  begin(name: string): void {
    this._open.set(name, performance.now());
  }

  end(name: string): void {
    const t0 = this._open.get(name);
    if (t0 === undefined) return;
    this._open.delete(name);
    const t1 = performance.now();
    this._record(this.sections, name, t1 - t0);
    this.spanRing.push({ name, t0, t1 });
    if (this.spanRing.length > SPAN_RING_MAX) this.spanRing.splice(0, this.spanRing.length - SPAN_RING_MAX);
  }

  /** Record awaited work — shown in its own table, never attributed to
   *  frame stalls (the await time is mostly off-thread). */
  asyncSpan(name: string, ms: number): void {
    this._record(this.asyncSections, name, ms);
  }

  count(name: string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  private _record(map: Map<string, SectionStat>, name: string, ms: number): void {
    let s = map.get(name);
    if (!s) { s = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 }; map.set(name, s); }
    s.count++;
    s.totalMs += ms;
    s.lastMs = ms;
    if (ms > s.maxMs) s.maxMs = ms;
  }

  /** Attribute a frame gap [t0, t1] to the sync spans overlapping it. */
  attribute(t0: number, t1: number): Stall {
    const byName = new Map<string, number>();
    let covered = 0;
    for (let i = this.spanRing.length - 1; i >= 0; i--) {
      const s = this.spanRing[i];
      if (s.t1 <= t0) break; // ring is time-ordered; nothing older overlaps
      const clip = Math.min(s.t1, t1) - Math.max(s.t0, t0);
      if (clip <= 0) continue;
      byName.set(s.name, (byName.get(s.name) || 0) + clip);
      covered += clip;
    }
    const parts = [...byName.entries()].sort((a, b) => b[1] - a[1]);
    const gapMs = t1 - t0;
    const stall: Stall = { atMs: t1 - this.startedAt, gapMs, parts, otherMs: Math.max(0, gapMs - covered) };
    this.stalls.push(stall);
    if (this.stalls.length > STALL_LOG_MAX) this.stalls.splice(0, this.stalls.length - STALL_LOG_MAX);
    if (this.onStall) this.onStall(stall);
    return stall;
  }

  reset(): void {
    this.sections.clear();
    this.asyncSections.clear();
    this.counters.clear();
    this.spanRing.length = 0;
    this.stalls.length = 0;
    this.startedAt = performance.now();
  }
}

export const perf = new PerfTracer();
// Window mirror so plain-JS call sites (and manual poking from a remote
// inspector, if one is ever attached) can reach the tracer without an
// import. Optional-chained everywhere it's used.
if (typeof window !== "undefined") {
  (window as unknown as { __nbPerf?: PerfTracer }).__nbPerf = perf;
}

// ---------------------------------------------------------------- overlay

interface HudState {
  shapes: { type: string; points?: unknown[] }[];
  selectedIds: Set<string>;
  camera: { x: number; y: number; zoom: number; rotation?: number };
  addEventListener(t: string, h: EventListener): void;
  removeEventListener(t: string, h: EventListener): void;
}

export interface PerfHudOptions {
  container: HTMLElement;
  state: HudState;
  /** Extra key/value lines for the report (file id, dirty flags…). */
  getExtra?: () => Record<string, unknown>;
}

export interface PerfHudHandle { destroy(): void }

/** Per-second frame buckets so the report can separate idle FPS from
 *  FPS while the camera was actually moving (the number that matters
 *  for pan feel — and, held against the input-event rate, tells the
 *  main-thread story from the compositor story: 60 fps here while the
 *  pan still visibly janks means the main thread is NOT the problem). */
interface SecondBucket { frames: number; camNotifies: number; inputEvents: number; worstGap: number }

export function mountPerfHud(opts: PerfHudOptions): PerfHudHandle {
  const { container, state, getExtra } = opts;

  // ---- frame monitor state ----
  let rafId = 0;
  let lastFrameAt = 0;
  let buckets: SecondBucket[] = [];
  let bucket: SecondBucket = { frames: 0, camNotifies: 0, inputEvents: 0, worstGap: 0 };
  let bucketStarted = 0;
  const gapHisto = { g17: 0, g33: 0, g50: 0, g100: 0, g250: 0, g500: 0, g1000: 0 };
  let flashUntil = 0;

  const onChange = ((e: CustomEvent) => {
    const keys: string[] = e.detail?.keys || [];
    for (const k of keys) {
      if (k === "camera") { bucket.camNotifies++; perf.count("notify:camera"); }
      else if (k === "shapes") perf.count("notify:shapes");
      else perf.count("notify:other");
    }
  }) as EventListener;
  state.addEventListener("change", onChange);

  const onInput = () => { bucket.inputEvents++; };
  container.addEventListener("pointermove", onInput, { passive: true });
  container.addEventListener("touchmove", onInput, { passive: true });

  function frame(now: number) {
    rafId = requestAnimationFrame(frame);
    if (lastFrameAt) {
      const gap = now - lastFrameAt;
      if (gap > 17) gapHisto.g17++;
      if (gap > 33) gapHisto.g33++;
      if (gap > 50) gapHisto.g50++;
      if (gap > 100) gapHisto.g100++;
      if (gap > 250) gapHisto.g250++;
      if (gap > 500) gapHisto.g500++;
      if (gap > 1000) gapHisto.g1000++;
      if (gap > bucket.worstGap) bucket.worstGap = gap;
      if (gap > STALL_MS) {
        perf.attribute(lastFrameAt, now);
        flashUntil = now + 600;
      }
    }
    lastFrameAt = now;
    bucket.frames++;
    if (!bucketStarted) bucketStarted = now;
    if (now - bucketStarted >= 1000) {
      buckets.push(bucket);
      if (buckets.length > 120) buckets.splice(0, buckets.length - 120);
      bucket = { frames: 0, camNotifies: 0, inputEvents: 0, worstGap: 0 };
      bucketStarted = now;
    }
  }
  rafId = requestAnimationFrame(frame);

  // Background tabs stop rAF; don't count the suspension as a stall.
  const onVis = () => { lastFrameAt = 0; };
  document.addEventListener("visibilitychange", onVis);

  // ---- report ----
  const f1 = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1));

  function shapeStats() {
    let draw = 0, text = 0, img = 0, other = 0, pts = 0;
    for (const s of state.shapes) {
      if (s.type === "draw") { draw++; pts += (s.points?.length || 0); }
      else if (s.type === "text") text++;
      else if (s.type === "image") img++;
      else other++;
    }
    return { total: state.shapes.length, draw, text, img, other, pts };
  }

  function fpsLine(): string {
    const recent = buckets.slice(-30);
    if (!recent.length) return "fps: (collecting)";
    const idle = recent.filter((b) => b.camNotifies <= 2);
    const pan = recent.filter((b) => b.camNotifies > 2);
    const avg = (arr: SecondBucket[]) => arr.reduce((a, b) => a + b.frames, 0) / arr.length;
    const worst = (arr: SecondBucket[]) => Math.max(0, ...arr.map((b) => b.worstGap));
    let out = "";
    if (pan.length) out += `PAN fps ${f1(avg(pan))} (worst frame ${f1(worst(pan))}ms, input ${f1(pan.reduce((a, b) => a + b.inputEvents, 0) / pan.length)}/s)`;
    else out += "PAN fps – (no pan yet)";
    if (idle.length) out += ` · idle fps ${f1(avg(idle))}`;
    return out;
  }

  function sectionTable(map: Map<string, SectionStat>): string {
    const rows = [...map.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    if (!rows.length) return "  (none)";
    return rows.map(([n, s]) => `  ${n}  n${s.count} tot${f1(s.totalMs)} max${f1(s.maxMs)} last${f1(s.lastMs)}`).join("\n");
  }

  function buildReport(): string {
    const st = shapeStats();
    const done = container.querySelector<HTMLCanvasElement>(".drawing-done");
    const lines: string[] = [];
    lines.push(`== Notebook Perf Report (hud v1) ==`);
    lines.push(`uptime ${f1((performance.now() - perf.startedAt) / 1000)}s · dpr ${window.devicePixelRatio} · zoom ${state.camera.zoom.toFixed(3)} · sel ${state.selectedIds.size}`);
    lines.push(`shapes ${st.total} (draw ${st.draw} · ${st.pts} pts, text ${st.text}, img ${st.img}, other ${st.other})`);
    if (done) lines.push(`backing ${done.width}×${done.height}px (css ${done.style.width})`);
    if (getExtra) {
      try { lines.push(`extra ${JSON.stringify(getExtra())}`); } catch { /* report must never throw */ }
    }
    lines.push(fpsLine());
    lines.push(`frames> 17:${gapHisto.g17} 33:${gapHisto.g33} 50:${gapHisto.g50} 100:${gapHisto.g100} 250:${gapHisto.g250} 500:${gapHisto.g500} 1000:${gapHisto.g1000}`);
    lines.push(`counters:`);
    const cRows = [...perf.counters.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    lines.push(cRows.length ? cRows.map(([n, v]) => `  ${n} ${v}`).join("\n") : "  (none)");
    lines.push(`sections (sync, ms):`);
    lines.push(sectionTable(perf.sections));
    lines.push(`awaited (off-thread, ms):`);
    lines.push(sectionTable(perf.asyncSections));
    lines.push(`stalls ≥${STALL_MS}ms (last ${STALL_LOG_MAX}):`);
    if (!perf.stalls.length) lines.push("  (none)");
    for (const s of perf.stalls) {
      const parts = s.parts.slice(0, 4).map(([n, ms]) => `${n} ${f1(ms)}`).join(", ");
      lines.push(`  t+${f1(s.atMs / 1000)}s ${f1(s.gapMs)}ms → ${parts}${parts ? ", " : ""}other ${f1(s.otherMs)}`);
    }
    lines.push(`ua ${navigator.userAgent}`);
    return lines.join("\n");
  }

  // ---- DOM ----
  const root = document.createElement("div");
  root.className = "nb-perf-hud";
  Object.assign(root.style, {
    position: "absolute", left: "8px", top: "8px", zIndex: "10000",
    background: "rgba(12,12,16,0.88)", color: "#d6f5d6",
    font: "10px/1.45 ui-monospace, Menlo, monospace",
    borderRadius: "8px", boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
    userSelect: "none", webkitUserSelect: "none", touchAction: "none",
    maxWidth: "min(460px, 86vw)", pointerEvents: "auto",
  } as Partial<CSSStyleDeclaration>);

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", gap: "6px",
    padding: "5px 8px", cursor: "grab", minHeight: "24px",
  } as Partial<CSSStyleDeclaration>);
  const live = document.createElement("span");
  live.textContent = "PERF …";
  live.style.whiteSpace = "nowrap";
  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      font: "inherit", color: "inherit", background: "rgba(255,255,255,0.12)",
      border: "none", borderRadius: "5px", padding: "4px 8px", minHeight: "24px",
      cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    // pointerdown so the tap works mid-gesture on iPad; stopPropagation
    // keeps it from starting a header drag.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", fn);
    return b;
  };
  const body = document.createElement("pre");
  Object.assign(body.style, {
    margin: "0", padding: "0 8px 7px", whiteSpace: "pre-wrap",
    maxHeight: "46vh", overflowY: "auto", display: "none",
    userSelect: "text", webkitUserSelect: "text",
  } as Partial<CSSStyleDeclaration>);

  let expanded = false;
  const toggleBtn = mkBtn("▸", () => {
    expanded = !expanded;
    body.style.display = expanded ? "block" : "none";
    toggleBtn.textContent = expanded ? "▾" : "▸";
  });
  const copyBtn = mkBtn("copy", async () => {
    const report = buildReport();
    let ok = false;
    try {
      const m = await import("@tauri-apps/plugin-clipboard-manager");
      await m.writeText(report);
      ok = true;
    } catch { /* not tauri / plugin missing */ }
    if (!ok) {
      try { await navigator.clipboard.writeText(report); ok = true; } catch { /* denied */ }
    }
    copyBtn.textContent = ok ? "copied!" : "copy failed — long-press text";
    if (!ok) { expanded = true; body.style.display = "block"; toggleBtn.textContent = "▾"; }
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
  });
  const resetBtn = mkBtn("reset", () => {
    perf.reset();
    buckets = [];
    bucket = { frames: 0, camNotifies: 0, inputEvents: 0, worstGap: 0 };
    for (const k of Object.keys(gapHisto)) (gapHisto as Record<string, number>)[k] = 0;
  });

  header.appendChild(live);
  header.appendChild(toggleBtn);
  header.appendChild(copyBtn);
  header.appendChild(resetBtn);
  root.appendChild(header);
  root.appendChild(body);
  container.appendChild(root);

  // Drag by header.
  let dragOff: { x: number; y: number } | null = null;
  header.addEventListener("pointerdown", (e) => {
    dragOff = { x: e.clientX - root.offsetLeft, y: e.clientY - root.offsetTop };
    header.setPointerCapture(e.pointerId);
  });
  header.addEventListener("pointermove", (e) => {
    if (!dragOff) return;
    root.style.left = `${Math.max(0, e.clientX - dragOff.x)}px`;
    root.style.top = `${Math.max(0, e.clientY - dragOff.y)}px`;
  });
  header.addEventListener("pointerup", () => { dragOff = null; });

  // 2 Hz refresh — cheap, and the interval work itself is negligible
  // next to what it's measuring.
  const refresh = setInterval(() => {
    const recent = buckets.slice(-5);
    const fps = recent.length ? recent.reduce((a, b) => a + b.frames, 0) / recent.length : 0;
    const stallN = gapHisto.g50;
    live.textContent = `PERF ${f1(fps)}fps stalls ${stallN}`;
    const flashing = performance.now() < flashUntil;
    root.style.background = flashing ? "rgba(150,20,20,0.92)" : "rgba(12,12,16,0.88)";
    if (expanded) body.textContent = buildReport();
  }, 500);

  return {
    destroy() {
      cancelAnimationFrame(rafId);
      clearInterval(refresh);
      state.removeEventListener("change", onChange);
      container.removeEventListener("pointermove", onInput);
      container.removeEventListener("touchmove", onInput);
      document.removeEventListener("visibilitychange", onVis);
      root.remove();
    },
  };
}
