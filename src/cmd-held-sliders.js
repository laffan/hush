/**
 * Cmd-held over-editor sliders.
 *
 * A thin row pinned to the bottom of the viewport that fades in
 * whenever `body.cmd-held` is set. Surfaces two live controls without
 * leaving the editor:
 *
 *   • Focus mode dimmed opacity (mirrors the Settings > Editor slider).
 *   • Zen Focus font size (mirrors Settings > Editor > Zen Focus).
 *
 * Both sliders write back to `state.settings` and emit `settings-changed`
 * so the existing CSS-var hooks (`--focus-mode-opacity`, `--zen-font-size`)
 * pick up the value on every input frame. Settings remain editable
 * from the Settings window — this is just a faster path.
 */

export function initCmdHeldSliders(state) {
  if (typeof document === "undefined") return;

  const root = document.createElement("div");
  root.className = "cmd-held-sliders";

  const dimGroup = makeSliderGroup({
    label: "Dim",
    min: 0, max: 1, step: 0.05,
    value: clamp01(state.settings.focusModeOpacity ?? 0.5),
    format: (v) => `${Math.round(v * 100)}%`,
    onChange: (v) => state.updateSettings({ focusModeOpacity: clamp01(v) }),
  });

  const zenGroup = makeSliderGroup({
    label: "Zen size",
    min: 18, max: 72, step: 1,
    value: Number(state.settings.zenFocusFontSize) || 30,
    format: (v) => `${Math.round(v)}px`,
    onChange: (v) => state.updateSettings({ zenFocusFontSize: Math.round(v) }),
  });

  root.appendChild(dimGroup.el);
  root.appendChild(zenGroup.el);
  document.body.appendChild(root);

  // Keep the sliders in sync if the user opens Settings and drags the
  // matching slider there — the floating control should reflect the
  // current value the next time the user holds Cmd.
  state.on("settings-changed", () => {
    dimGroup.set(clamp01(state.settings.focusModeOpacity ?? 0.5));
    zenGroup.set(Number(state.settings.zenFocusFontSize) || 30);
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
