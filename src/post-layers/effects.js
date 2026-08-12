/**
 * The seven post-processing effects. Each is a tiny mount function with
 * the same contract:
 *
 *     mount(slot, layer, ctx) → { update(layer), dispose() }
 *
 * `slot` is the effect's own absolutely/fixed-positioned element, already
 * placed in the stack by index.js. `ctx.scope` is the element the two
 * effects that reach *outside* their slot act on — `document.body` for a
 * fullscreen apply, the preview pane for the style modal's scoped one.
 *
 * Three families:
 *   - painted overlays (vignette, scan lines, tint) — a background on the
 *     slot plus a mix-blend-mode, zero runtime cost once composited;
 *   - backdrop filters (grayscale, sepia) — the slot filters whatever is
 *     painted beneath it, which is why the slots are siblings in the root
 *     stacking context rather than children of one host (a host would
 *     isolate them and every blend/filter would sample its own empty
 *     backdrop instead of the page);
 *   - reach-out effects (glow, opacity) — glow puts a text-shadow on the
 *     real editor glyphs through an injected rule, and opacity fades the
 *     whole window by way of the document element. Both restore
 *     everything they touched on dispose.
 */

const GLOW_RULES_ID = "post-layer-glow-rules";
const GLOW_SCOPE_CLASS = "post-layer-glow-active";
const VAR_GLOW = "--post-layer-glow";
const VAR_HALO = "--post-layer-halo";

const GLOW_RULES_CSS = `
.${GLOW_SCOPE_CLASS} .cm-content,
.${GLOW_SCOPE_CLASS} .style-preview-content,
.${GLOW_SCOPE_CLASS} .style-preview-cursor-demo {
  text-shadow:
    0 0 var(${VAR_GLOW}, 4px) currentColor,
    0 0 var(${VAR_HALO}, 12px) currentColor;
  -webkit-font-smoothing: antialiased;
}
`;

function num(v, fallback) {
  return (typeof v === "number" && !Number.isNaN(v)) ? v : fallback;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, num(v, 0)));
}

/** "#rgb" / "#rrggbb" → "r,g,b" decimal triplet. */
function rgbCsv(hex) {
  const h = String(hex || "").replace("#", "");
  const expand = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = parseInt(expand.slice(0, 2), 16) || 0;
  const g = parseInt(expand.slice(2, 4), 16) || 0;
  const b = parseInt(expand.slice(4, 6), 16) || 0;
  return `${r},${g},${b}`;
}

/** Both vendor spellings — WebKit still wants the prefixed property. */
function setBackdropFilter(el, value) {
  el.style.setProperty("-webkit-backdrop-filter", value);
  el.style.setProperty("backdrop-filter", value);
}

function clearSlot(slot) {
  slot.style.background = "";
  slot.style.opacity = "";
  slot.style.mixBlendMode = "";
  slot.style.removeProperty("-webkit-backdrop-filter");
  slot.style.removeProperty("backdrop-filter");
}

/** Painted-overlay and backdrop-filter effects share this shell: `paint`
 *  writes the slot's look from the layer, and teardown is always the same
 *  full scrub. */
function simpleEffect(slot, layer, paint) {
  const apply = (l) => {
    clearSlot(slot);
    paint(slot, l);
    if (l.blend && l.blend !== "normal") slot.style.mixBlendMode = l.blend;
  };
  apply(layer);
  return { update: apply, dispose: () => clearSlot(slot) };
}

function mountVignette(slot, layer) {
  return simpleEffect(slot, layer, (el, l) => {
    const strength = clamp01(num(l.strength, 0.5));
    // Spread widens the darkened band inward: 0 hugs the corners, 1
    // reaches most of the way to the centre.
    const inner = (80 - clamp01(num(l.spread, 0.45)) * 70).toFixed(1);
    el.style.background =
      `radial-gradient(circle at center, transparent ${inner}%, rgba(${rgbCsv(l.color || "#000000")},${strength.toFixed(3)}) 100%)`;
  });
}

function mountScanlines(slot, layer) {
  return simpleEffect(slot, layer, (el, l) => {
    const alpha = clamp01(num(l.opacity, 0.15)).toFixed(3);
    const period = Math.max(2, Math.round(num(l.spacing, 2)));
    const rgb = rgbCsv(l.color || "#000000");
    el.style.background = `repeating-linear-gradient(
      to bottom,
      rgba(0,0,0,0) 0,
      rgba(0,0,0,0) ${period - 1}px,
      rgba(${rgb},${alpha}) ${period - 1}px,
      rgba(${rgb},${alpha}) ${period}px
    )`;
  });
}

function mountTint(slot, layer) {
  return simpleEffect(slot, layer, (el, l) => {
    el.style.background = l.color || "#f0a860";
    el.style.opacity = String(clamp01(num(l.amount, 0.35)));
  });
}

function mountGrayscale(slot, layer) {
  return simpleEffect(slot, layer, (el, l) => {
    setBackdropFilter(el, `grayscale(${clamp01(num(l.amount, 1)).toFixed(3)})`);
  });
}

function mountSepia(slot, layer) {
  return simpleEffect(slot, layer, (el, l) => {
    setBackdropFilter(el, `sepia(${clamp01(num(l.amount, 1)).toFixed(3)})`);
  });
}

/** Text glow. Reaches the real glyphs (`.cm-content`) and the modal
 *  preview's text through one injected rule; the radii ride CSS custom
 *  properties on the scope so a slider drag retunes them without any
 *  re-render. The slot itself stays empty. */
function mountGlow(slot, layer, ctx) {
  if (!document.getElementById(GLOW_RULES_ID)) {
    const el = document.createElement("style");
    el.id = GLOW_RULES_ID;
    el.textContent = GLOW_RULES_CSS;
    document.head.appendChild(el);
  }
  const scope = ctx.scope;
  scope.classList.add(GLOW_SCOPE_CLASS);

  const apply = (l) => {
    // Knob values 0..1 map to 0..30 px (tight) and 0..50 px (soft).
    scope.style.setProperty(VAR_GLOW, `${(clamp01(num(l.glow, 0.4)) * 30).toFixed(2)}px`);
    scope.style.setProperty(VAR_HALO, `${(clamp01(num(l.halo, 0.6)) * 50).toFixed(2)}px`);
  };
  apply(layer);

  return {
    update: apply,
    dispose() {
      // Wrapped individually so a stale reference in one step can't
      // strand the cleanup of the others — this is the pull-the-plug path.
      try { scope.classList.remove(GLOW_SCOPE_CLASS); } catch (_) {}
      try { scope.style.removeProperty(VAR_GLOW); } catch (_) {}
      try { scope.style.removeProperty(VAR_HALO); } catch (_) {}
      try { document.getElementById(GLOW_RULES_ID)?.remove(); } catch (_) {}
    },
  };
}

/**
 * Window opacity. Fullscreen, this fades `<html>` itself — the Tauri
 * window is created transparent and neither `html` nor `body` paints a
 * background, so the whole UI (chrome, editor, and the rest of the post
 * stack alike) turns translucent against the desktop behind it. That is
 * the point: it is the *window's* opacity, not another overlay. Where the
 * scene itself is opaque (iOS), the same fade reveals the scene's own
 * background instead of the desktop.
 *
 * A scoped preview has no window to fade, so it dims the preview pane's
 * own content instead — every child of the pane except the layer hosts,
 * which must keep painting at full strength or the preview would darken
 * itself twice.
 */
function mountOpacity(slot, layer, ctx) {
  const scoped = !!ctx.container;
  const targets = [];

  const collect = () => {
    if (!scoped) return [document.documentElement];
    return [...ctx.container.children].filter(el =>
      !el.classList.contains("post-layer-slot") && el.id !== "background-layers-host");
  };

  const apply = (l) => {
    const v = String(Math.max(0, Math.min(1, num(l.amount, 0.9))));
    for (const el of collect()) {
      if (!targets.includes(el)) targets.push(el);
      el.style.opacity = v;
    }
  };
  apply(layer);

  return {
    update: apply,
    dispose() {
      for (const el of targets) {
        try { el.style.removeProperty("opacity"); } catch (_) {}
      }
      targets.length = 0;
    },
  };
}

const MOUNTS = {
  vignette: mountVignette,
  glow: mountGlow,
  scanlines: mountScanlines,
  opacity: mountOpacity,
  tint: mountTint,
  grayscale: mountGrayscale,
  sepia: mountSepia,
};

export function mountPostEffect(slot, layer, ctx) {
  const fn = MOUNTS[layer && layer.type];
  return fn ? fn(slot, layer, ctx) : null;
}

/** Everything a panic cleanup has to unwind that isn't a slot element. */
export function scrubPostArtifacts() {
  document.getElementById(GLOW_RULES_ID)?.remove();
  document.querySelectorAll("." + GLOW_SCOPE_CLASS).forEach(el => {
    el.classList.remove(GLOW_SCOPE_CLASS);
    el.style.removeProperty(VAR_GLOW);
    el.style.removeProperty(VAR_HALO);
  });
  document.documentElement.style.removeProperty("opacity");
}
