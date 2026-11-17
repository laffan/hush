/**
 * Night Vision's two layers — what actually takes the blue off the
 * screen (the mode itself is `night-vision-mode.js`).
 *
 * Two click-through layers over the whole window, children of `<body>`
 * like the post-processing slots and for the same reason: a host element
 * would be its own stacking context, and both effects below would then
 * sample its empty backdrop instead of the page.
 *
 *   1. grey — `backdrop-filter: grayscale(1)`: everything under it is
 *      reduced to its luminance;
 *   2. red  — pure red, `mix-blend-mode: multiply`: the grey is
 *      multiplied by (1, 0, 0), so its luminance lands in the red
 *      channel and green and blue are zero.
 *
 * Only filter functions and a blend mode — no SVG `url()` filter, which
 * WebKit draws off its accelerated path (unreliably over video and other
 * composited layers) and which `backdrop-filter` does not take at all in
 * Safari. Whatever the grey layer misses is still multiplied by the red
 * one: green and blue are zero everywhere the red layer covers.
 *
 * They sit at the very top of the z-index scale (`--z-night-vision`,
 * `--z-night-vision-red`, base.css), over Courier, Write Now's fade and
 * the drag ghost. Styles are inline, with the tokens' values as
 * fallbacks, because the Settings window (its own webview with its own
 * stylesheet) mounts them too (`night-vision-window.js`).
 */
const GREY_ID = "night-vision-grey";
const RED_ID = "night-vision-red";

const BASE = "position:fixed;inset:0;pointer-events:none;margin:0;padding:0;border:0;";

function layer(id, css) {
  const el = document.createElement("div");
  el.id = id;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = BASE + css;
  return el;
}

/** Put the two layers up (once). */
export function mountNightVision() {
  if (typeof document === "undefined" || !document.body) return;
  if (document.getElementById(GREY_ID)) return;
  const grey = layer(GREY_ID,
    "z-index:var(--z-night-vision,2147483646);-webkit-backdrop-filter:grayscale(1);backdrop-filter:grayscale(1);");
  const red = layer(RED_ID,
    "z-index:var(--z-night-vision-red,2147483647);background:#f00;mix-blend-mode:multiply;");
  document.body.append(grey, red);
  document.documentElement.classList.add("night-vision");
}

/** Take them down. */
export function unmountNightVision() {
  if (typeof document === "undefined") return;
  document.getElementById(GREY_ID)?.remove();
  document.getElementById(RED_ID)?.remove();
  document.documentElement.classList.remove("night-vision");
}
