/**
 * WebGL2 background layer — hosts one effect from the effects registry
 * (the modules under shader-layer/layers/, unchanged).
 *
 * The effect modules were written against shader-layer's ctx contract
 * (width/height/dpr + onResize / onVisible setters), so this builds a
 * compatible per-layer ctx rather than teaching the modules a new one.
 */
import { findEffect, resolveEffectOptions } from "./effects-registry.js";

function buildEffectCtx(intensity, options, width, height, dpr) {
  const ctx = {
    intensity: typeof intensity === "number" ? Math.max(0, Math.min(1, intensity)) : 0.5,
    options: options || {},
    dpr: dpr || 1,
    width,
    height,
    _onResize: null,
    _onVisible: null,
  };
  Object.defineProperty(ctx, "onResize", { set(fn) { ctx._onResize = fn; } });
  Object.defineProperty(ctx, "onVisible", { set(fn) { ctx._onVisible = fn; } });
  return ctx;
}

export async function mountWebglLayer(host, cfg, appearance, ctx) {
  let effectId = cfg.effectId || "webgl-neon-bloom";
  // Tracks the newest config so a remount (effect swap) re-applies the
  // *current* blend — the mount-time cfg goes stale after the first
  // update, and the effect module's own dispose() clears the host's
  // blend on its way out.
  let current = cfg;
  const effectCtx = buildEffectCtx(cfg.intensity, resolveEffectOptions(effectId, cfg.options), ctx.width, ctx.height, ctx.dpr);
  let instance = null;
  let disposed = false;
  let visible = true;

  function applyBlend() {
    host.style.mixBlendMode = current.blend || "screen";
  }

  async function mountEffect() {
    const reg = findEffect(effectId);
    if (!reg) return;
    const mod = await reg.load();
    if (disposed) return;
    instance = await mod.default(host, effectCtx);
    // The module may stamp its preferred blend on the host (neon bloom
    // sets "screen"); the layer's own blend choice wins.
    applyBlend();
  }

  await mountEffect();

  return {
    async update(nextCfg) {
      current = nextCfg;
      applyBlend();
      const nextId = nextCfg.effectId || "webgl-neon-bloom";
      const fullOptions = resolveEffectOptions(nextId, nextCfg.options);
      effectCtx.intensity = typeof nextCfg.intensity === "number" ? nextCfg.intensity : 0.5;
      effectCtx.options = fullOptions;
      if (nextId !== effectId) {
        effectId = nextId;
        try { instance?.dispose?.(); } catch (_) {}
        instance = null;
        await mountEffect();
        if (!visible) effectCtx._onVisible?.(false);
      } else {
        instance?.update?.({ intensity: effectCtx.intensity, options: fullOptions });
      }
    },
    resize(width, height, dpr) {
      effectCtx.width = width;
      effectCtx.height = height;
      effectCtx.dpr = dpr || 1;
      effectCtx._onResize?.(effectCtx);
    },
    setVisible(v) {
      visible = v;
      effectCtx._onVisible?.(v);
    },
    dispose() {
      disposed = true;
      try { instance?.dispose?.(); } catch (_) {}
      host.style.mixBlendMode = "";
    },
  };
}
