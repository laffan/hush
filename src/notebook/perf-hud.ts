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
interface Stall {
  atMs: number; gapMs: number; parts: [string, number][]; otherMs: number;
  /** Camera annotations added by the HUD's frame monitor: zoom at the
   *  stall, zoom/pan change across the gap, and how long before the
   *  stall the last re-anchor finished (undefined = none seen). Lets a
   *  paste-back report distinguish "stall during pure pan" from "stall
   *  during pinch" from "flush right after a re-anchor". */
  zoom?: number; dz?: number; panPx?: number; sinceReanchorMs?: number;
}

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

  let prevCam = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
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
        const stall = perf.attribute(lastFrameAt, now);
        // Annotate with camera motion across the gap + re-anchor
        // proximity so "flush after a re-anchor" and "stall during a
        // pinch" are distinguishable in the paste-back report.
        const cam = state.camera;
        stall.zoom = cam.zoom;
        stall.dz = cam.zoom - prevCam.zoom;
        stall.panPx = Math.hypot(cam.x - prevCam.x, cam.y - prevCam.y);
        for (let i = perf.spanRing.length - 1; i >= 0; i--) {
          if (perf.spanRing[i].name === "reanchor") {
            stall.sinceReanchorMs = now - perf.spanRing[i].t1;
            break;
          }
        }
        flashUntil = now + 600;
      }
    }
    prevCam = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
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
    else out += "PAN fps – (none in last 30 s)";
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
    lines.push(`== Notebook Perf Report (hud v7) ==`);
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
      const cam = s.zoom !== undefined
        ? ` z${s.zoom.toFixed(2)}${s.dz ? ` Δz${s.dz > 0 ? "+" : ""}${s.dz.toFixed(3)}` : ""} pan${Math.round(s.panPx || 0)}` +
          (s.sinceReanchorMs !== undefined && s.sinceReanchorMs < 3000 ? ` reA←${f1(s.sinceReanchorMs / 1000)}s` : "")
        : "";
      lines.push(`  t+${f1(s.atMs / 1000)}s ${f1(s.gapMs)}ms${cam} → ${parts}${parts ? ", " : ""}other ${f1(s.otherMs)}`);
    }
    lines.push(`ua ${navigator.userAgent}`);
    return lines.join("\n");
  }

  // ---- DOM ----
  const root = document.createElement("div");
  root.className = "nb-perf-hud";
  Object.assign(root.style, {
    // top clears the reserved iOS status-bar band.
    position: "absolute", left: "8px", top: "38px", zIndex: "10000",
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

  // Canvas probe: measures what a full-surface canvas op costs on THIS
  // device — both the JS side and, crucially, the frame gap right
  // after it (WebKit plays canvas display lists back at commit time,
  // so a software-rasterized canvas shows near-zero JS cost and a huge
  // post-op frame gap). The op is an identity self-copy ('copy'
  // composite, zero offset): every pixel is replaced by itself, so
  // it's non-destructive regardless of how the engine implements it.
  // Results land in the "awaited" table as probe:* rows; run it 2-3
  // times while the canvas is idle.
  const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
  const probeBtn = mkBtn("probe", async () => {
    const done = container.querySelector<HTMLCanvasElement>(".drawing-done");
    if (!done || !done.width) { probeBtn.textContent = "no canvas"; return; }
    probeBtn.textContent = "…";
    const ctx = done.getContext("2d")!;
    await nextFrame(); await nextFrame();
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      perf.begin("probe:selfCopy");
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(done, 0, 0);
      ctx.restore();
      perf.end("probe:selfCopy");
      const opEnd = performance.now();
      perf.asyncSpan("probe:selfCopyJs", opEnd - t0);
      // The flush lands between the op and the FIRST frame after it —
      // v2 measured the first→second frame gap and missed it entirely
      // (the round-3 capture's stall log caught the real ~240 ms cost
      // that this row reported as 15 ms).
      const f1t = await nextFrame();
      perf.asyncSpan("probe:opToFrameGap", f1t - opEnd);
      const f2t = await nextFrame();
      perf.asyncSpan("probe:nextFrameGap", f2t - f1t);
    }
    // Small-dirty-region control: replace ONE corner pixel with itself
    // (clip + 'copy' + 1×1 source/dest = exactly non-destructive; the
    // clip is load-bearing — unclipped 'copy' clears the whole surface
    // outside the drawn rect). Shows what a tiny dirty rect on the big
    // surface costs next to a full-surface op.
    {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(0, 0, 1, 1);
      ctx.clip();
      ctx.globalCompositeOperation = "copy";
      const sT0 = performance.now();
      ctx.drawImage(done, 0, 0, 1, 1, 0, 0, 1, 1);
      ctx.restore();
      const sEnd = performance.now();
      const fs = await nextFrame();
      perf.asyncSpan("probe:smallDirtyJs", sEnd - sT0);
      perf.asyncSpan("probe:smallDirtyGap", fs - sEnd);
    }
    // Delta-#29 legs: the two cross-canvas 'copy' draws the readback-
    // free blit uses (helper := done, then done := helper at zero
    // offset — identity overall, non-destructive). If these rows are
    // ~1 frame while probe:opToFrameGap stays ~230 ms, the readback
    // diagnosis and the fix are both confirmed on-device.
    const helper = container.querySelector<HTMLCanvasElement>(".drawing-blit-helper");
    if (helper) {
      const hctx = helper.getContext("2d")!;
      if (helper.width !== done.width) { helper.width = done.width; helper.height = done.height; }
      let t = performance.now();
      hctx.save(); hctx.setTransform(1, 0, 0, 1, 0, 0);
      hctx.globalCompositeOperation = "copy";
      hctx.drawImage(done, 0, 0); hctx.restore();
      let end = performance.now();
      perf.asyncSpan("probe:doneToHelperJs", end - t);
      perf.asyncSpan("probe:doneToHelperGap", (await nextFrame()) - end);
      t = performance.now();
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(helper, 0, 0); ctx.restore();
      end = performance.now();
      perf.asyncSpan("probe:helperToDoneJs", end - t);
      perf.asyncSpan("probe:helperToDoneGap", (await nextFrame()) - end);
    }
    // Stamp-source comparison (delta #30): 300 small drawImages into
    // the helper canvas from (a) a detached-canvas source — mutable, so
    // WebKit may re-upload it per draw — vs (b) an ImageBitmap of the
    // same pixels — immutable, texture-cacheable. This is the strip
    // rebake's workload in miniature; if (a) is ~two hundred ms and (b)
    // is ~a frame, the residual re-anchor stall is explained and the
    // ImageBitmap atlases fix it.
    if (helper) {
      const hctx = helper.getContext("2d")!;
      const src = document.createElement("canvas");
      src.width = 128; src.height = 128;
      const sctx = src.getContext("2d")!;
      sctx.fillStyle = "#345";
      sctx.beginPath(); sctx.arc(64, 64, 60, 0, Math.PI * 2); sctx.fill();
      const stampRun = (image: CanvasImageSource) => {
        for (let i = 0; i < 300; i++) {
          hctx.drawImage(image, 0, 0, 128, 128, (i * 37) % 3800, (i * 53) % 3800, 64, 64);
        }
      };
      let t = performance.now();
      stampRun(src);
      let end = performance.now();
      perf.asyncSpan("probe:stampCanvasJs", end - t);
      perf.asyncSpan("probe:stampCanvasGap", (await nextFrame()) - end);
      try {
        const bmp = await createImageBitmap(src);
        t = performance.now();
        stampRun(bmp);
        end = performance.now();
        perf.asyncSpan("probe:stampBitmapJs", end - t);
        perf.asyncSpan("probe:stampBitmapGap", (await nextFrame()) - end);
        bmp.close();
      } catch { /* no createImageBitmap on this engine */ }
    }
    // Round-6 discriminators. Every earlier "cheap" probe ran on
    // INVISIBLE surfaces (1-2% opacity helper / tile canvases); the
    // ~235 ms re-anchor residual survives with zero strokes, so the
    // remaining suspects are (a) any write to the VISIBLE done canvas,
    // or (b) a write COLLIDING with a wrapper-transform change in the
    // same commit — the one combination unique to re-anchors. Three
    // rows separate them:
    //   probe:doneFillGap      write-only, visible canvas, no transform
    //   probe:doneFillPanGap   same write + 1px wrapper-transform nudge
    //   probe:transformOnlyGap transform nudge alone
    // The write is an 8×8 fill at 0.4% alpha in the far corner of the
    // backing (offscreen margin, invisible even over ink; the next
    // rebake repaints it) — dirties the surface without self-reading.
    {
      const wrapper = container.querySelector<HTMLElement>(".notebook-drawing-wrapper");
      const fill = () => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "rgba(0,0,0,0.004)";
        ctx.fillRect(done.width - 8, done.height - 8, 8, 8);
        ctx.restore();
      };
      let t = performance.now();
      fill();
      let end = performance.now();
      perf.asyncSpan("probe:doneFillJs", end - t);
      perf.asyncSpan("probe:doneFillGap", (await nextFrame()) - end);
      await nextFrame();
      if (wrapper) {
        const savedTransform = wrapper.style.transform;
        fill();
        wrapper.style.transform = savedTransform + " translate(0.51px, 0px)";
        end = performance.now();
        perf.asyncSpan("probe:doneFillPanGap", (await nextFrame()) - end);
        wrapper.style.transform = savedTransform;
        await nextFrame();
        wrapper.style.transform = savedTransform + " translate(0.51px, 0px)";
        end = performance.now();
        perf.asyncSpan("probe:transformOnlyGap", (await nextFrame()) - end);
        wrapper.style.transform = savedTransform;
        await nextFrame();
      }
    }
    // Allocation probe: a fresh same-size surface + first draw.
    const t0 = performance.now();
    const c = document.createElement("canvas");
    c.width = done.width;
    c.height = done.height;
    c.getContext("2d")!.fillRect(0, 0, 8, 8);
    perf.asyncSpan("probe:allocFirstDraw", performance.now() - t0);
    probeBtn.textContent = "probe ✓";
    setTimeout(() => { probeBtn.textContent = "probe"; }, 1500);
  });

  // Tile-cost probe. Round-4C showed full-surface ops on the big canvas
  // carry a ~240 ms commit floor that did NOT scale down with pixel
  // count, while small dirty regions flush cheap — so whether a TILED
  // backing (the round-A plan) is viable hangs on what a full-surface
  // op costs on tile-sized COMPOSITED canvases. This mounts a test
  // canvas per candidate size, fills its full surface twice, and
  // records op→frame gaps as tileProbe:<css px> rows. Cheap floors
  // (<~40 ms) green-light tiles; a flat ~240 ms floor kills them.
  const tileBtn = mkBtn("tiles", async () => {
    tileBtn.textContent = "…";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cssSize of [512, 1024, 2048]) {
      const c = document.createElement("canvas");
      c.width = Math.round(cssSize * dpr);
      c.height = Math.round(cssSize * dpr);
      Object.assign(c.style, {
        position: "absolute", left: "0px", top: "0px",
        width: `${cssSize}px`, height: `${cssSize}px`,
        opacity: "0.02", pointerEvents: "none", zIndex: "1",
      } as Partial<CSSStyleDeclaration>);
      container.appendChild(c);
      const ctx = c.getContext("2d")!;
      await nextFrame(); await nextFrame(); // let attach + first commit settle
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        ctx.fillStyle = i ? "#182838" : "#283848";
        ctx.fillRect(0, 0, c.width, c.height);
        const opEnd = performance.now();
        const f1t = await nextFrame();
        perf.asyncSpan(`tileProbe:${cssSize}:opGap`, f1t - opEnd);
        perf.asyncSpan(`tileProbe:${cssSize}:js`, opEnd - t0);
        await nextFrame();
      }
      c.remove();
      await nextFrame();
    }
    tileBtn.textContent = "tiles ✓";
    setTimeout(() => { tileBtn.textContent = "tiles"; }, 1500);
  });

  // A/B toggle for the drawing layer's SVG overlay — if pan/pinch
  // stalls vanish with the SVG hidden, the compositor is re-rastering
  // its (world-sized) layer. Pen input needs it back on afterwards.
  const svgBtn = mkBtn("svg", () => {
    const svg = container.querySelector<SVGElement>(".notebook-drawing-wrapper svg");
    if (!svg) return;
    const hidden = svg.style.display === "none";
    svg.style.display = hidden ? "" : "none";
    svgBtn.textContent = hidden ? "svg" : "svg✕";
    perf.count(hidden ? "probe:svgShown" : "probe:svgHidden");
  });

  header.style.flexWrap = "wrap";
  header.appendChild(live);
  header.appendChild(toggleBtn);
  header.appendChild(copyBtn);
  header.appendChild(resetBtn);
  header.appendChild(probeBtn);
  header.appendChild(svgBtn);
  header.appendChild(tileBtn);
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
