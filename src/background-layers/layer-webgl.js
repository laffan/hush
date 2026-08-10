/**
 * WebGL2 background layer — hosts one effect from the effects registry
 * (the modules under shader-layer/layers/, unchanged) plus an optional
 * caret-effect canvas stacked over it in the same layer slot.
 *
 * The effect modules were written against shader-layer's ctx contract
 * (width/height/dpr + onResize / onVisible setters), so this builds a
 * compatible per-layer ctx rather than teaching the modules a new one.
 */
import { findEffect, resolveEffectOptions } from "./effects-registry.js";
import { createCaretEffect } from "./caret-effects.js";

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

export async function mountWebglLayer(host, cfg, appearance, ctx, caretSource) {
  let effectId = cfg.effectId || "webgl-neon-bloom";
  let effectCtx = buildEffectCtx(cfg.intensity, resolveEffectOptions(effectId, cfg.options), ctx.width, ctx.height, ctx.dpr);
  let instance = null;
  let caret = null;
  let disposed = false;
  let visible = true;

  async function mountEffect() {
    const reg = findEffect(effectId);
    if (!reg) return;
    const mod = await reg.load();
    if (disposed) return;
    instance = await mod.default(host, effectCtx);
    // The module may stamp its preferred blend on the host (neon bloom
    // sets "screen"); the layer's own blend choice wins.
    applyBlend(cfg);
  }

  function applyBlend(c) {
    host.style.mixBlendMode = c.blend || "screen";
  }

  function syncCaret(c) {
    const preset = c.caretEffect && c.caretEffect !== "none" ? c.caretEffect : null;
    if (!preset) {
      if (caret) { caret.dispose(); caret = null; }
      return;
    }
    const caretCfg = { preset, color: c.caretColor, intensity: c.caretIntensity };
    if (caret) caret.update(caretCfg);
    else caret = createCaretEffect(host, caretCfg, caretSource, effectCtx);
  }

  await mountEffect();
  syncCaret(cfg);

  return {
    async update(nextCfg, _appearance) {
      applyBlend(nextCfg);
      const nextId = nextCfg.effectId || "webgl-neon-bloom";
      const fullOptions = resolveEffectOptions(nextId, nextCfg.options);
      if (nextId !== effectId) {
        effectId = nextId;
        try { instance?.dispose?.(); } catch (_) {}
        instance = null;
        effectCtx.intensity = typeof nextCfg.intensity === "number" ? nextCfg.intensity : 0.5;
        effectCtx.options = fullOptions;
        await mountEffect();
        if (!visible) effectCtx._onVisible?.(false);
      } else {
        instance?.update?.({
          intensity: typeof nextCfg.intensity === "number" ? nextCfg.intensity : 0.5,
          options: fullOptions,
        });
      }
      syncCaret(nextCfg);
    },
    resize(width, height, dpr) {
      effectCtx.width = width;
      effectCtx.height = height;
      effectCtx.dpr = dpr || 1;
      effectCtx._onResize?.(effectCtx);
      caret?.resize(width, height, dpr);
    },
    setVisible(v) {
      visible = v;
      effectCtx._onVisible?.(v);
      caret?.setVisible(v);
    },
    dispose() {
      disposed = true;
      try { instance?.dispose?.(); } catch (_) {}
      if (caret) { caret.dispose(); caret = null; }
      host.style.mixBlendMode = "";
    },
  };
}
