/**
 * Campfire Cursor — on, off and previewed. The palette's toggle and the
 * options modal come through here; the editor side (the mask under the
 * caret, the glow, the blink sync) is editor/plugins/campfire.js.
 *
 * The options go on the root as CSS properties (styles/campfire.css
 * reads them) and `body.campfire-on` switches the mask on. If the caret
 * stops being one Hush draws — a style with the system caret — the
 * campfire goes out, since there is no glow left to see by.
 */
import { readCampfireOptions, saveCampfireOptions, isCampfireOn, campfireAvailable } from "./campfire-store.js";
import { setCampfire } from "../editor/plugins/campfire.js";

let watching = false;

async function toast(message, kind = "info") {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, kind);
}

/** Draw `options` (resolved), or nothing for null. */
function apply(options) {
  const root = document.documentElement.style;
  document.body.classList.toggle("campfire-on", !!options);
  if (!options) {
    for (const p of ["--cf-base", "--cf-peak", "--cf-plateau", "--cf-mid", "--cf-range"]) root.removeProperty(p);
    setCampfire(null);
    return;
  }
  const b = options.brightness;
  // Above 1 the fully lit middle widens; the rim stays soft.
  const plateau = Math.max(0, Math.min(60, (b - 1) * 50));
  root.setProperty("--cf-base", String(options.baseOpacity));
  root.setProperty("--cf-peak", String(Math.min(1, b)));
  root.setProperty("--cf-plateau", `${plateau}%`);
  root.setProperty("--cf-mid", `${plateau + (100 - plateau) * 0.45}%`);
  root.setProperty("--cf-range", String(options.range));
  setCampfire(options);
}

function watch(state) {
  if (watching) return;
  watching = true;
  const check = () => {
    if (isCampfireOn(state) && !campfireAvailable(state.settings)) {
      endCampfire(state);
      void toast("Campfire Cursor is off — it needs a Block, Underline or Thick Line cursor");
    }
  };
  state.on("settings-changed", check);
  state.on("style-changed", check);
}

const UNAVAILABLE = "Campfire Cursor needs a Block, Underline or Thick Line cursor (Styles → Cursor)";

/** Draw `options` without committing to them (the modal's preview). */
export function previewCampfire(state, options) {
  if (!campfireAvailable(state.settings)) return;
  apply(readCampfireOptions({ campfire: options }));
}

/** Leave the preview: back to the campfire as it was, or to none. */
export function cancelCampfirePreview(state) {
  apply(isCampfireOn(state) ? readCampfireOptions(state.settings) : null);
}

/** Light the campfire with `options` (remembered), or say why it can't
 *  be lit. Returns whether it is lit. */
export function beginCampfire(state, options = readCampfireOptions(state.settings)) {
  if (!campfireAvailable(state.settings)) { void toast(UNAVAILABLE); return false; }
  state.runtime.campfire = true;
  void saveCampfireOptions(state, options);
  apply(readCampfireOptions({ campfire: options }));
  watch(state);
  return true;
}

export function endCampfire(state) {
  state.runtime.campfire = false;
  apply(null);
}

export function toggleCampfire(state) {
  if (isCampfireOn(state)) endCampfire(state);
  else beginCampfire(state);
}
