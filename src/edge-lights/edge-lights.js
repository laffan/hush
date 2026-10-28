/**
 * Edge Lights — on, off and previewed. The palette rows and the modal
 * come through here; the overlay (and its WebGL) is imported on first use.
 *
 * One overlay per window. The modal previews on the live overlay — the
 * options it shows are drawn as they change, behind it — and Cancel puts
 * back what was there before it opened: the lights as they were, or none.
 */
import { readOptions, readDeskOptions, saveOptions, paletteColors, isEdgeLightsOn } from "./edge-lights-store.js";

let overlay = null;

function resolved(options) {
  const o = readOptions({ edgeLights: options });
  return { ...o, colors: paletteColors(o) };
}

async function show(options) {
  if (overlay) { overlay.update(resolved(options)); return; }
  const { mountEdgeLights } = await import("./edge-lights-overlay.js");
  // A second call may have mounted one while this one was loading.
  if (overlay) { overlay.update(resolved(options)); return; }
  overlay = mountEdgeLights(resolved(options));
}

function hide() {
  const o = overlay;
  overlay = null;
  if (o) void o.stop();
}

/** Draw `options` without committing to them (the modal's preview). */
export function previewEdgeLights(options) {
  return show(options);
}

/** Leave the preview: back to the lights as they were, or to none. */
export function cancelEdgeLightsPreview(state) {
  if (isEdgeLightsOn(state)) void show(readOptions(state.settings));
  else hide();
}

/** Begin (or, while on, re-tune) the lights with `options`, which are
 *  remembered for next time — for this desk, and as the last anywhere. */
export async function beginEdgeLights(state, options) {
  state.runtime.edgeLights = true;
  void saveOptions(state, options, state.settings?.activeDeskId || null);
  await show(options);
}

export function endEdgeLights(state) {
  state.runtime.edgeLights = false;
  hide();
}

/** On with the settings last used on this desk (else the last used
 *  anywhere), or off — triple-tapped ⇧⌘ by default (triple-tap-triggers.js), no
 *  modal in between. */
export function toggleEdgeLights(state) {
  if (isEdgeLightsOn(state)) endEdgeLights(state);
  else void beginEdgeLights(state, readDeskOptions(state.settings, state.settings?.activeDeskId));
}
