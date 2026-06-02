/**
 * Quick-control pill that surfaces in Zen Focus mode (and is reused
 * by Selection Focus via a sibling wrap mounted inside that overlay).
 *
 * Two affordances live in this module:
 *
 *   • A small `^` caret pinned to the bottom-centre of the viewport
 *     that fades in while the cursor is near the bottom of the window
 *     (body class `sliders-near-bottom`, toggled by the proximity
 *     tracker installed below).
 *   • A horizontal pill carrying Dim opacity + Font size sliders that
 *     reveals on caret hover (and stays revealed while the pointer is
 *     on the pill itself).
 *
 * The pill writes back to `state.settings.focusModeOpacity` and
 * `state.settings.zenFocusFontSize` so the same values surfaced in the
 * Settings window update live — and vice versa.
 */

/** Vertical band — measured from the bottom edge — within which the
 *  caret/pill reveals on mousemove. Sits comfortably above the macOS
 *  Dock without forcing the user to chase the edge. */
const NEAR_BOTTOM_PX = 200;

/** Install a single mousemove listener that toggles
 *  `body.sliders-near-bottom` based on cursor proximity to the bottom
 *  of the viewport. CSS gates every Zen / Selection-Focus pill on
 *  that class, so neither pill paints chrome over the editor unless
 *  the user is already aiming at it. */
function installNearBottomTracker() {
  if (typeof window === "undefined") return;
  if (window.__hushSlidersNearBottomTrackerInstalled) return;
  window.__hushSlidersNearBottomTrackerInstalled = true;
  let isNear = false;
  const update = (clientY) => {
    const threshold = window.innerHeight - NEAR_BOTTOM_PX;
    const shouldBeNear = clientY >= threshold;
    if (shouldBeNear === isNear) return;
    isNear = shouldBeNear;
    document.body.classList.toggle("sliders-near-bottom", isNear);
  };
  window.addEventListener("mousemove", (e) => update(e.clientY), { passive: true });
  // Pointer can leave the window (alt-tab, dragged tab) — reset so the
  // caret doesn't stay lit when the cursor isn't actually down there.
  window.addEventListener("mouseleave", () => { isNear = false; document.body.classList.remove("sliders-near-bottom"); });
}

export function initCmdHeldSliders(state) {
  if (typeof document === "undefined") return;
  installNearBottomTracker();

  // Wrapper hosts both the caret and the pill so the `:hover` rule on
  // the wrap can keep the pill open while the pointer is anywhere
  // inside the column.
  const wrap = document.createElement("div");
  wrap.className = "cmd-held-sliders-wrap";

  const caret = document.createElement("div");
  caret.className = "cmd-held-sliders-caret";
  caret.setAttribute("aria-hidden", "true");
  // Sharper-than-unicode chevron — apex angle ≈ 60° so it reads as the
  // tip of an up-arrow rather than the flat `︿` glyph.
  caret.innerHTML = `<svg viewBox="0 0 16 10" width="16" height="10" aria-hidden="true">
    <path d="M2 9 L8 1.5 L14 9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  </svg>`;
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

  const windowGroup = makeWindowChipGroup({
    value: normalizeWindow(state.settings.zenFocusWindow),
    onChange: (v) => state.updateSettings({ zenFocusWindow: v }),
  });

  pill.appendChild(dimGroup.el);
  pill.appendChild(fontGroup.el);
  pill.appendChild(windowGroup.el);
  wrap.appendChild(pill);
  document.body.appendChild(wrap);

  state.on("settings-changed", () => {
    dimGroup.set(clamp01(state.settings.focusModeOpacity ?? 0.5));
    fontGroup.set(Number(state.settings.zenFocusFontSize) || 30);
    windowGroup.set(normalizeWindow(state.settings.zenFocusWindow));
  });
}

function normalizeWindow(raw) {
  const n = Number(raw);
  if (n === 3) return 3;
  if (n === 5) return 5;
  if (n === 7) return 7;
  return 1;
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

/** Window chip group — four numeric chips (1 / 3 / 5 / 7) with a
 *  circle outline on the active pick. */
function makeWindowChipGroup({ value, onChange }) {
  const el = document.createElement("div");
  el.className = "cmd-held-slider-group cmd-held-window-group";

  const lbl = document.createElement("span");
  lbl.className = "cmd-held-slider-label";
  lbl.textContent = "Window";
  el.appendChild(lbl);

  const chips = document.createElement("div");
  chips.className = "cmd-held-window-chips";

  const btns = [];
  for (const n of [1, 3, 5, 7]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cmd-held-window-chip";
    btn.dataset.value = String(n);
    btn.textContent = String(n);
    if (n === value) btn.classList.add("active");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onChange(n);
      for (const b of btns) b.classList.toggle("active", Number(b.dataset.value) === n);
    });
    btns.push(btn);
    chips.appendChild(btn);
  }
  el.appendChild(chips);

  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  return {
    el,
    set(v) {
      for (const b of btns) b.classList.toggle("active", Number(b.dataset.value) === v);
    },
  };
}
