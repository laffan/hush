/**
 * Caret background layer — an effect that follows the text cursor
 * (sparks / bubbles / ripples). Its own layer type rather than a knob
 * on the WebGL layer: it composites, reorders, and blends exactly like
 * any other layer, and a style can carry one without carrying a WebGL
 * effect at all.
 *
 * The shader work lives in caret-effects.js; this is the thin layer
 * adapter (blend mode on the slot, config passthrough).
 */
import { createCaretEffect } from "./caret-effects.js";

export function mountCaretLayer(host, cfg, appearance, ctx, caretSource) {
  host.style.mixBlendMode = cfg.blend || "screen";

  const toEffectCfg = (c) => ({
    preset: c.preset || "sparks",
    color: c.color,
    intensity: c.intensity,
  });

  const inst = createCaretEffect(host, toEffectCfg(cfg), caretSource, ctx);

  return {
    update(nextCfg) {
      host.style.mixBlendMode = nextCfg.blend || "screen";
      inst.update(toEffectCfg(nextCfg));
    },
    resize(width, height, dpr) { inst.resize(width, height, dpr); },
    setVisible(v) { inst.setVisible(v); },
    dispose() {
      inst.dispose();
      host.style.mixBlendMode = "";
    },
  };
}
