/**
 * Edge Lights' Blur fill — the shape blurs whatever it lies over instead
 * of adding light to it. The overlay renders the shape as a mask (white
 * at its strength, `u_fill` 1 in edge-lights-shader.js) and hands it
 * here a few times a second as an image; a full-window layer with a
 * `backdrop-filter` blur takes it as its `mask-image`. Composited on the
 * GPU, so it is cheap. The overlay canvas draws a faint frost over the
 * same shape, so it shows even over a plain page.
 *
 * Double-buffered: changing a layer's `mask-image` makes WebKit drop the
 * mask until the new image has loaded, and for that frame or two the
 * layer blurred the whole window (or nothing) — the flicker. So there
 * are two layers: the new mask is decoded first, put on the hidden one,
 * and only then does that one take over.
 *
 * The opacity option is the strength, from none at 0. (Liquid glass and
 * RGB shift lived here as SVG filters on `<body>`: WebKit applied no
 * displacement to HTML that way, and filtering the page on every paint
 * was too slow, so they were dropped.)
 */

/** Mount the blur at `strength` 0..1. Returns `{ setMask(url),
 *  update(strength), remove() }`. */
export function mountBlur(strength) {
  const layers = [0, 1].map(() => {
    const el = document.createElement("div");
    el.className = "edge-lights-distort";
    el.style.visibility = "hidden";
    document.body.appendChild(el);
    return el;
  });
  let front = 0;
  let seq = 0;
  let removed = false;

  function setStrength(s) {
    const blur = `blur(${(18 * s).toFixed(1)}px)`;
    for (const el of layers) {
      el.style.backdropFilter = blur;
      el.style.webkitBackdropFilter = blur;
    }
  }
  setStrength(strength);

  return {
    setMask(url) {
      const mine = ++seq;
      const img = new Image();
      img.src = url;
      const swap = () => {
        // A later mask overtook this one, or the blur went: drop it.
        if (removed || mine !== seq) return;
        const back = layers[1 - front];
        const v = `url("${url}")`;
        back.style.maskImage = v;
        back.style.webkitMaskImage = v;
        // Swapped in one go: the new mask is decoded, so the frame that
        // shows it is the frame the old one goes — never neither, and
        // never both (a blur stacked on a blur).
        back.style.visibility = "visible";
        layers[front].style.visibility = "hidden";
        front = 1 - front;
      };
      (img.decode ? img.decode() : Promise.resolve()).then(swap, swap);
    },
    update(s) { setStrength(s); },
    remove() {
      removed = true;
      for (const el of layers) el.remove();
    },
  };
}
