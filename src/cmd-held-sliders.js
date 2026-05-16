/**
 * Zen-only quick controls.
 *
 * Two affordances live in this module, both gated to Zen mode:
 *
 *   • A small `^` caret pinned to the bottom-centre of the viewport
 *     that fades in while `body.cmd-held` is set.
 *   • A horizontal pill carrying Dim opacity + Font size sliders that
 *     reveals on caret hover (and stays revealed while the pointer is
 *     on the pill itself).
 *
 * The pill writes back to `state.settings.focusModeOpacity` and
 * `state.settings.zenFocusFontSize` so the same values surfaced in the
 * Settings window update live — and vice versa.
 */

export function initCmdHeldSliders(state) {
  if (typeof document === "undefined") return;

  // Wrapper hosts both the caret and the pill so the `:hover` rule on
  // the wrap can keep the pill open while the pointer is anywhere
  // inside the column.
  const wrap = document.createElement("div");
  wrap.className = "cmd-held-sliders-wrap";

  const caret = document.createElement("div");
  caret.className = "cmd-held-sliders-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "︿";
  wrap.appendChild(caret);

  const pill = document.createElement("div");
  pill.className = "cmd-held-sliders";

  const dimGroup = makeSliderGroup({
    label: "Dim",
    min: 0, max: 1, step: 0.05,
    value: clamp01(state.settings.focusModeOpacity ?? 0.5),
    format: (v) => `${Math.round(v * 100)}%`,
    onChange: (v) => state.updateSettings({ focusModeOpacity: clamp01(v) }),
  });

  const fontGroup = makeSliderGroup({
    label: "Font",
    min: 18, max: 72, step: 1,
    value: Number(state.settings.zenFocusFontSize) || 30,
    format: (v) => `${Math.round(v)}px`,
    onChange: (v) => state.updateSettings({ zenFocusFontSize: Math.round(v) }),
  });

  pill.appendChild(dimGroup.el);
  pill.appendChild(fontGroup.el);
  wrap.appendChild(pill);
  document.body.appendChild(wrap);

  state.on("settings-changed", () => {
    dimGroup.set(clamp01(state.settings.focusModeOpacity ?? 0.5));
    fontGroup.set(Number(state.settings.zenFocusFontSize) || 30);
  });
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function makeSliderGroup({ label, min, max, step, value, format, onChange }) {
  const el = document.createElement("div");
  el.className = "cmd-held-slider-group";

  const lbl = document.createElement("span");
  lbl.className = "cmd-held-slider-label";
  lbl.textContent = label;

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const readout = document.createElement("span");
  readout.className = "cmd-held-slider-readout";
  readout.textContent = format(value);

  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    readout.textContent = format(v);
    onChange(v);
  });

  // Stop pointer events from bubbling so dragging the slider doesn't
  // trigger drag-selects or other window-level pointer listeners.
  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  el.appendChild(lbl);
  el.appendChild(input);
  el.appendChild(readout);

  return {
    el,
    set(v) {
      // Skip while the user is actively dragging — the input event is
      // already firing for every frame, no need to overwrite from
      // outside and risk a snap.
      if (document.activeElement === input) return;
      input.value = String(v);
      readout.textContent = format(v);
    },
  };
}
