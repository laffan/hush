/**
 * Northern Lights — on, off and previewed. The palette rows and the modal
 * come through here; the overlay (and its WebGL) is imported on first use.
 *
 * One overlay per window. The modal previews on the live overlay — the
 * options it shows are drawn as they change, behind it — and Cancel puts
 * back what was there before it opened: the lights as they were, or none.
 */
import { readOptions, saveOptions, paletteColors, isNorthernLightsOn } from "./northern-lights-store.js";

let overlay = null;

function resolved(options) {
  const o = readOptions({ northernLights: options });
  return { ...o, colors: paletteColors(o) };
}

async function show(options) {
  if (overlay) { overlay.update(resolved(options)); return; }
  const { mountNorthernLights } = await import("./northern-lights-overlay.js");
  // A second call may have mounted one while this one was loading.
  if (overlay) { overlay.update(resolved(options)); return; }
  overlay = mountNorthernLights(resolved(options));
}

function hide() {
  const o = overlay;
  overlay = null;
  if (o) void o.stop();
}

/** Draw `options` without committing to them (the modal's preview). */
export function previewNorthernLights(options) {
  return show(options);
}

/** Leave the preview: back to the lights as they were, or to none. */
export function cancelNorthernLightsPreview(state) {
  if (isNorthernLightsOn(state)) void show(readOptions(state.settings));
  else hide();
}

/** Begin (or, while on, re-tune) the lights with `options`, which are
 *  remembered for next time. */
export async function beginNorthernLights(state, options) {
  state.runtime.northernLights = true;
  void saveOptions(state, options);
  await show(options);
}

export function endNorthernLights(state) {
  state.runtime.northernLights = false;
  hide();
}
