/**
 * Edge Lights' Distortion fill — the shape bends whatever it lies over
 * instead of adding light to it. The overlay renders the shape as a mask
 * (white at its strength, `u_fill` 1 in edge-lights-shader.js) and hands
 * it here a dozen times a second as an image; this module distorts the
 * page under it.
 *
 *   Blur          a `backdrop-filter` blur on a full-window layer masked
 *                 by the shape — composited on the GPU, so it is cheap.
 *   Liquid glass  refraction (a turbulence displacement map), a little
 *                 extra saturation and light, and
 *   RGB shift     the red and blue channels pulled apart sideways — both
 *                 need to move pixels, which WebKit's `backdrop-filter`
 *                 can't do (it takes no SVG filters), so they are an SVG
 *                 filter on `<body>`: the distorted page composited
 *                 *in* the mask, laid over the page as it is. That is
 *                 heavier than the blur, since the page is filtered each
 *                 time it paints.
 *
 * The opacity option is the strength, from none at 0. The shape's own
 * surface (a glass rim, a frost, colour fringes) is drawn by the overlay
 * canvas over this, so the shape shows even where there is nothing
 * under it to bend.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_ID = "hush-edge-distort";

function channel(values, result) {
  const m = document.createElementNS(SVG_NS, "feColorMatrix");
  m.setAttribute("in", "SourceGraphic");
  m.setAttribute("type", "matrix");
  m.setAttribute("values", values);
  m.setAttribute("result", result);
  return m;
}

function fe(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Build the SVG filter for `kind` ("glass" | "rgb") at `strength` 0..1.
 *  Returns the `<svg>` holder and its `<feImage>` (the mask). */
function buildFilter(kind, strength) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none";
  const filter = fe("filter", {
    id: FILTER_ID, x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
    filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB",
  });
  if (kind === "rgb") {
    const shift = 12 * strength;
    filter.append(
      channel("1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", "r"),
      fe("feOffset", { in: "r", dx: -shift, dy: 0, result: "rShift" }),
      // Where a channel moved away from the window's edge it leaves a
      // strip with none of that channel — a solid bar of the other two —
      // so the unshifted channel fills in underneath.
      fe("feComposite", { in: "rShift", in2: "r", operator: "over", result: "r2" }),
      channel("0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", "g"),
      channel("0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", "b"),
      fe("feOffset", { in: "b", dx: shift, dy: 0, result: "bShift" }),
      fe("feComposite", { in: "bShift", in2: "b", operator: "over", result: "b2" }),
      fe("feBlend", { in: "r2", in2: "g", mode: "screen", result: "rg" }),
      fe("feBlend", { in: "rg", in2: "b2", mode: "screen", result: "warped" }),
    );
  } else {
    filter.append(
      fe("feTurbulence", { type: "fractalNoise", baseFrequency: "0.006 0.009", numOctaves: 2, seed: 7, result: "noise" }),
      fe("feDisplacementMap", {
        in: "SourceGraphic", in2: "noise", scale: 68 * strength,
        xChannelSelector: "R", yChannelSelector: "G", result: "bent",
      }),
      // Glass gathers light: a touch more colour and brightness.
      fe("feColorMatrix", { in: "bent", type: "saturate", values: 1.25, result: "sat" }),
      fe("feComponentTransfer", { in: "sat", result: "warped" }),
    );
    const lift = filter.lastChild;
    for (const f of ["feFuncR", "feFuncG", "feFuncB"]) lift.appendChild(fe(f, { type: "linear", slope: 1.06, intercept: 0.02 }));
  }
  const mask = fe("feImage", {
    x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, preserveAspectRatio: "none", result: "mask",
  });
  filter.append(
    mask,
    fe("feComposite", { in: "warped", in2: "mask", operator: "in", result: "inside" }),
    fe("feComposite", { in: "inside", in2: "SourceGraphic", operator: "over" }),
  );
  svg.appendChild(filter);
  return { svg, filter, mask };
}

/** Mount the distortion for `kind` at `strength`. Returns `{ setMask(url),
 *  update(kind, strength), remove() }`. */
export function mountDistortion(kind, strength) {
  let current = null;
  let maskUrl = "";

  function build(k, s) {
    teardown();
    if (k === "blur") {
      const el = document.createElement("div");
      el.className = "edge-lights-distort";
      const blur = `blur(${(18 * s).toFixed(1)}px)`;
      el.style.backdropFilter = blur;
      el.style.webkitBackdropFilter = blur;
      document.body.appendChild(el);
      current = { kind: k, el };
    } else {
      const f = buildFilter(k, s);
      document.body.appendChild(f.svg);
      document.body.classList.add("edge-lights-distorting");
      current = { kind: k, ...f };
    }
    if (maskUrl) apply(maskUrl);
  }

  function apply(url) {
    if (!current) return;
    if (current.el) {
      const v = `url("${url}")`;
      current.el.style.maskImage = v;
      current.el.style.webkitMaskImage = v;
    } else {
      current.mask.setAttribute("href", url);
      // Older WebKit reads an feImage's source only from xlink:href.
      current.mask.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url);
    }
  }

  function teardown() {
    if (!current) return;
    current.el?.remove();
    current.svg?.remove();
    document.body.classList.remove("edge-lights-distorting");
    current = null;
  }

  const onResize = () => {
    if (!current?.filter) return;
    for (const node of [current.filter, current.mask]) {
      node.setAttribute("width", window.innerWidth);
      node.setAttribute("height", window.innerHeight);
    }
  };
  window.addEventListener("resize", onResize);
  build(kind, strength);

  return {
    setMask(url) { maskUrl = url; apply(url); },
    update(k, s) { build(k, s); },
    remove() { window.removeEventListener("resize", onResize); teardown(); },
  };
}
