/**
 * Caret background layer — an effect that follows the text cursor
 * (sparks / underline glow / flicker bar). Its own layer type rather
 * than a knob on the WebGL layer: it composites, reorders, and blends
 * exactly like any other layer, and a style can carry one without
 * carrying a WebGL effect at all.
 *
 * The shader work lives in caret-effects.js; this is the thin layer
 * adapter — colour, blend mode and opacity, each resolved per
 * appearance.
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

/**
 * Blend mode for the appearance being rendered. Caret effects are drawn
 * as light on a dark ground, so screen is right in dark mode and
 * catastrophic in light — screening anything onto white returns white,
 * which is why the colour pickers used to look like they did nothing at
 * all in the light half. Light therefore defaults to multiply.
 *
 * A pre-split layer's single `blend` seeds the dark side only; the light
 * side starts from the multiply default regardless, because the stored
 * value is the one that was invisible.
 */
function resolveBlend(cfg, appearance) {
  if (appearance === "dark") return cfg.darkBlend || cfg.blend || "screen";
  return cfg.lightBlend || "multiply";
}

/** Layer opacity for the appearance being rendered — the same
 *  per-appearance pair the image and gradient layers carry, and the only
 *  brightness control a caret layer has (the old `intensity` knob folded
 *  into it; see normalizeCaretLayer). */
function resolveOpacity(cfg, appearance) {
  const v = appearance === "dark" ? cfg.darkOpacity : cfg.lightOpacity;
  return v != null ? v : 1;
}

export function mountCaretLayer(host, cfg, appearance, ctx, caretSource) {
  const applyChrome = (c, app) => {
    host.style.mixBlendMode = resolveBlend(c, app);
    host.style.opacity = String(resolveOpacity(c, app));
  };
  applyChrome(cfg, appearance);

  const toEffectCfg = (c, app) => ({
    preset: c.preset || "sparks",
    color: resolveColor(host, c, app),
    height: c.height,
    sparkHeight: c.sparkHeight,
    trailSeconds: c.trailSeconds,
    offsetY: c.offsetY,
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
