/**
 * Edge Lights' Blur fill — the shape blurs whatever it lies over instead
 * of adding light to it. The overlay renders the shape as two masks a
 * few times a second (edge-lights-shader.js, `u_fill` 1 and 4) and hands
 * them here as images; full-window layers with a `backdrop-filter` blur
 * take them as their `mask-image`. Composited on the GPU, so cheap. The
 * overlay canvas draws a faint frost over the same shape, so it shows
 * even over a plain page.
 *
 * **Two bands**, so it reads as a blur that deepens towards the edge
 * rather than the page faded over a blurred copy of itself: a light blur
 * over the shape's whole reach, and the full blur over its core, laid
 * over it — in the core the two add up (a blur of a blur). The masks are
 * mostly solid, with a short soft edge, so almost nowhere does sharp
 * page show through blurred page.
 *
 * **Double-buffered, for real**: each band is a pair of layers. A new
 * mask goes on the pair's back layer, which is kept rendered at a
 * near-zero opacity — WebKit doesn't compute the backdrop of a hidden
 * layer, so swapping in one that had been `visibility: hidden` showed a
 * frame or two of no blur, the flicker — and once its image is decoded
 * and two frames have been drawn with it, front and back trade opacity
 * in one go.
 *
 * The opacity option is the blur's strength, from none at 0.
 */

/** A back layer's opacity: drawn (so its backdrop is ready), not seen. */
const BACK = "0.002";

/** Mount the blur at `strength` 0..1. Returns `{ setMasks(outerUrl,
 *  coreUrl), update(strength), remove() }`. */
export function mountBlur(strength) {
  const band = (cls) => {
    // Both start as back layers: with no mask yet, a shown one would
    // blur the whole window until the first arrives.
    const layers = [0, 1].map(() => {
      const el = document.createElement("div");
      el.className = `edge-lights-distort ${cls}`;
      el.style.opacity = BACK;
      document.body.appendChild(el);
      return el;
    });
    return { layers, front: 0 };
  };
  // Outer first: the core is laid over it, so it blurs what the outer
  // band already blurred.
  const bands = [band("edge-lights-blur-outer"), band("edge-lights-blur-core")];
  let removed = false;

  function setStrength(s) {
    const core = 4 + 22 * s;
    const radii = [core * 0.35, core];
    bands.forEach((b, i) => {
      const f = s > 0 ? `blur(${radii[i].toFixed(1)}px)` : "none";
      for (const el of b.layers) {
        el.style.backdropFilter = f;
        el.style.webkitBackdropFilter = f;
      }
    });
  }
  setStrength(strength);

  const frames = (n) => new Promise((r) => {
    const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const decoded = (url) => {
    const img = new Image();
    img.src = url;
    return (img.decode ? img.decode() : Promise.resolve()).catch(() => {});
  };

  // One swap at a time, always finished: a mask that arrives meanwhile
  // waits (the newest replacing any already waiting) rather than
  // cancelling it — on a slow frame rate a cancelled swap is overtaken by
  // the next mask every time, and the blur never shows.
  let busy = false;
  let waiting = null;

  async function swapIn(urls) {
    await Promise.all(urls.map(decoded));
    if (removed) return;
    bands.forEach((b, i) => {
      const back = b.layers[1 - b.front];
      const v = `url("${urls[i]}")`;
      back.style.maskImage = v;
      back.style.webkitMaskImage = v;
    });
    // Let the back layers draw with their new masks before showing them.
    await frames(2);
    if (removed) return;
    for (const b of bands) {
      b.layers[1 - b.front].style.opacity = "1";
      b.layers[b.front].style.opacity = BACK;
      b.front = 1 - b.front;
    }
  }

  return {
    async setMasks(outerUrl, coreUrl) {
      waiting = [outerUrl, coreUrl];
      if (busy) return;
      busy = true;
      try {
        while (waiting && !removed) {
          const urls = waiting;
          waiting = null;
          await swapIn(urls);
        }
      } finally { busy = false; }
    },
    update(s) { setStrength(s); },
    remove() {
      removed = true;
      for (const b of bands) for (const el of b.layers) el.remove();
    },
  };
}
