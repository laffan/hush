/**
 * Caret background layer — an effect that follows the text cursor
 * (sparks / bubbles / ripples / underline glow / HUD / flicker bar).
 * Its own layer type rather than a knob on the WebGL layer: it
 * composites, reorders, and blends exactly like any other layer, and a
 * style can carry one without carrying a WebGL effect at all.
 *
 * The shader work lives in caret-effects.js; this is the thin layer
 * adapter — blend mode on the slot, and colour resolution.
 */
import { createCaretEffect } from "./caret-effects.js";
import { normalizeColor } from "./webgl-utils.js";

const DEFAULT_COLOR = "#9ecbff";

/**
 * The effect's colour for the appearance being rendered.
 *
 * `matchCaret` reads the live `--cursor` custom property off the host,
 * which inherits it from `<html>` in the editor and from the preview
 * pane in the style modal — so the effect tracks whatever the style
 * resolved the caret to, per appearance, with no duplicate colour
 * chain. Otherwise the per-appearance override wins, falling back to
 * the single legacy `color` that caret layers carried before light and
 * dark could diverge.
 */
function resolveColor(host, cfg, appearance) {
  if (cfg.matchCaret) {
    const v = getComputedStyle(host).getPropertyValue("--cursor");
    if (v && v.trim()) return normalizeColor(v, cfg.color || DEFAULT_COLOR);
  }
  const per = appearance === "dark" ? cfg.darkColor : cfg.lightColor;
  return normalizeColor(per || cfg.color || DEFAULT_COLOR, DEFAULT_COLOR);
}

/** Layer opacity for the appearance being rendered — the same
 *  per-appearance pair the image and gradient layers carry. Distinct
 *  from the effect's own `intensity`, which governs how bright and
 *  dense the effect draws itself before the layer is composited. */
function resolveOpacity(cfg, appearance) {
  const v = appearance === "dark" ? cfg.darkOpacity : cfg.lightOpacity;
  return v != null ? v : 1;
}

export function mountCaretLayer(host, cfg, appearance, ctx, caretSource) {
  const applyChrome = (c, app) => {
    host.style.mixBlendMode = c.blend || "screen";
    host.style.opacity = String(resolveOpacity(c, app));
  };
  applyChrome(cfg, appearance);

  const toEffectCfg = (c, app) => ({
    preset: c.preset || "sparks",
    color: resolveColor(host, c, app),
    intensity: c.intensity,
    height: c.height,
    trailSeconds: c.trailSeconds,
    rings: c.rings,
    blobSize: c.blobSize,
    blobSpeed: c.blobSpeed,
    rainbow: c.rainbow,
    antialias: c.antialias,
  });

  const inst = createCaretEffect(host, toEffectCfg(cfg, appearance), caretSource, ctx);

  return {
    update(nextCfg, nextAppearance) {
      applyChrome(nextCfg, nextAppearance);
      inst.update(toEffectCfg(nextCfg, nextAppearance));
    },
    resize(width, height, dpr) { inst.resize(width, height, dpr); },
    setVisible(v) { inst.setVisible(v); },
    dispose() {
      inst.dispose();
      host.style.mixBlendMode = "";
      host.style.opacity = "";
    },
  };
}
