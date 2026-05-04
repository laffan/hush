/**
 * 2D canvas layer: drifting dust specks + a slow exposure flicker.
 *
 * Painted at a deliberate 12fps — film-stock dust looks better skipping
 * frames than running silky-smooth, and 12fps is ~5x cheaper than 60.
 * The rAF loop is gated on document visibility AND window focus via the
 * ctx.onVisible callback installed by the registry: when the user tabs
 * away the loop stops cold.
 *
 * Blend mode is `difference` so the dust shows up regardless of the
 * underlying theme — bright specks against dark editors, dark specks
 * against light editors. (Earlier `screen` blend with white particles
 * was invisible on light themes; `difference` always produces a
 * high-contrast result.)
 */

const TARGET_FPS = 12;
const FRAME_MS = 1000 / TARGET_FPS;
const DUST_BASE_COUNT = 40; // count scales with intensity (40..160)
const FLICKER_PERIOD_MS = 1700;

export default function mount(host, ctx) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  // `difference` inverts wherever a dust pixel lands: bright specks on
  // dark backgrounds, dark specks on light. Transparent pixels (alpha
  // 0) are no-ops, so empty regions of the canvas leave the editor
  // untouched. This replaces the earlier `screen` mode, which made
  // white dust invisible on light themes.
  canvas.style.mixBlendMode = "difference";
  host.appendChild(canvas);

  const c2d = canvas.getContext("2d", { alpha: true });

  let intensity = clamp(ctx.intensity);
  let particles = [];
  let visible = !document.hidden && document.hasFocus();
  let lastFrame = 0;
  let rafId = 0;

  function resize() {
    const w = ctx.width;
    const h = ctx.height;
    const dpr = ctx.dpr;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedParticles(w, h);
  }

  function seedParticles(w, h) {
    const count = Math.round(DUST_BASE_COUNT + intensity * 120);
    particles = new Array(count);
    for (let i = 0; i < count; i++) {
      particles[i] = randomParticle(w, h);
    }
  }

  function randomParticle(w, h) {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      // Most specks are sub-pixel; a few are bigger lint flecks.
      r: Math.random() < 0.92 ? 0.4 + Math.random() * 0.8 : 1.2 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 0.15,
      vy: 0.08 + Math.random() * 0.18,
      life: Math.random(),
      ttl: 0.6 + Math.random() * 0.6, // seconds-equivalent at 12fps
      a: 0.25 + Math.random() * 0.55,
    };
  }

  function tick(t) {
    rafId = 0;
    if (!visible) return;
    if (t - lastFrame < FRAME_MS) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    lastFrame = t;

    const w = ctx.width;
    const h = ctx.height;
    c2d.clearRect(0, 0, w, h);

    // Slow exposure flicker — multiply globalAlpha by a sine wave around
    // ~0.85 so the entire dust field pulses gently. Period is several
    // seconds so it reads as analog warmth, not seizure-trigger.
    const flicker = 0.7 + 0.3 * Math.sin((t / FLICKER_PERIOD_MS) * Math.PI * 2);
    const baseAlpha = 0.55 + intensity * 0.45; // 0.55..1.0 — bumped from
                                               // 0.4..0.9 so `difference`
                                               // reads at low intensities
    c2d.globalAlpha = baseAlpha * flicker;
    // Pure white maximises the swing under `difference` — every channel
    // inverts to (255 - bg) which always lands far from the bg color.
    c2d.fillStyle = "#ffffff";

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      // Approximate per-frame step ≈ 1 / TARGET_FPS, but we don't need
      // physical accuracy — just consistent drift.
      p.x += p.vx;
      p.y += p.vy;
      p.life += 1 / (TARGET_FPS * p.ttl);
      if (p.life >= 1 || p.y > h + 4 || p.x < -4 || p.x > w + 4) {
        particles[i] = randomParticle(w, -2);
        continue;
      }
      const fade = p.life < 0.2 ? p.life / 0.2
                 : p.life > 0.8 ? (1 - p.life) / 0.2
                 : 1;
      c2d.globalAlpha = baseAlpha * flicker * p.a * fade;
      c2d.beginPath();
      c2d.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c2d.fill();
    }

    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId || !visible) return;
    lastFrame = 0;
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  ctx.onResize = () => { resize(); };
  ctx.onVisible = (v) => {
    visible = v;
    if (v) start(); else stop();
  };

  resize();
  start();

  return {
    update({ intensity: i }) {
      intensity = clamp(i);
      seedParticles(ctx.width, ctx.height);
    },
    dispose() {
      stop();
      canvas.remove();
    },
  };
}

function clamp(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
