/**
 * Image background layer — the direct descendant of the old single
 * "Background Image" section. One absolutely-positioned div painted with
 * the layer's data-URL src; fit / repeat map to background-size /
 * background-repeat, blend to mix-blend-mode, and opacity + invert
 * resolve per appearance (light vs dark each carry their own values,
 * with the legacy single `opacity` as the fallback for both).
 */

function resolveOpacityInvert(cfg, appearance) {
  const isDark = appearance === "dark";
  const legacy = cfg.opacity != null ? cfg.opacity : 1;
  const opacity = isDark
    ? (cfg.darkOpacity != null ? cfg.darkOpacity : legacy)
    : (cfg.lightOpacity != null ? cfg.lightOpacity : legacy);
  const invert = isDark ? !!cfg.darkInvert : !!cfg.lightInvert;
  return { opacity, invert };
}

export function mountImageLayer(host, cfg, appearance) {
  const el = document.createElement("div");
  el.className = "bg-layer bg-layer-image";
  el.style.cssText = "position:absolute;inset:0;pointer-events:none;background-position:center";
  host.appendChild(el);

  function apply(c, app) {
    const { opacity, invert } = resolveOpacityInvert(c, app);
    el.style.backgroundImage = c.src ? `url("${c.src}")` : "none";
    el.style.backgroundSize = c.fit || "cover";
    el.style.backgroundRepeat = c.repeat || "no-repeat";
    el.style.mixBlendMode = c.blend || "normal";
    el.style.opacity = String(opacity);
    el.style.filter = invert ? "invert(1)" : "none";
  }
  apply(cfg, appearance);

  return {
    update(nextCfg, nextAppearance) { apply(nextCfg, nextAppearance); },
    setVisible() {},
    dispose() { el.remove(); },
  };
}
