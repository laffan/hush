/**
 * The Edge Lights modal — shape (Polar, Scuba, Thrum, Thrum Dark), fill
 * (Colors, a Blur of what the shape lies over, or an Animation of
 * particles), colour, saturation, opacity (the blur's strength),
 * depth and speed, then Begin or Cancel, with the
 * saved presets in a rail on the left (edge-lights-presets.js). Custom's
 * colours are a row of two to six wells, shown while Custom is chosen.
 * Every change is drawn at once on the overlay behind it (the backdrop is
 * kept light so it can be seen); Cancel puts back what was there before. While the lights are on it opens on their
 * options, with Apply in place of Begin and a Turn off beside them.
 *
 * Same shell as the sidebar's modals (`.tree-delete-modal`), so it sits
 * in the app's modal band above the overlay.
 */
import { escHtml } from "../sidebar/files-panel-shared.js";
import { installColorPickers } from "../ui/color-picker.js";
import {
  KINDS, FILLS, ANIMATIONS, PALETTES, LIMITS, MIN_COLORS, MAX_COLORS,
  readDeskOptions, paletteColors, nextCustomColor, isEdgeLightsOn,
} from "./edge-lights-store.js";
import {
  previewEdgeLights, cancelEdgeLightsPreview, beginEdgeLights, endEdgeLights,
} from "./edge-lights.js";
import { mountPresetRail } from "./edge-lights-presets.js";

const SLIDERS = [
  { key: "saturation", label: "Saturation", step: 0.01 },
  { key: "opacity", label: "Opacity", step: 0.01 },
  { key: "depth", label: "Depth", step: 0.01 },
  { key: "speed", label: "Speed", step: 0.01 },
];

const pct = (v) => `${Math.round(v * 100)}%`;

function swatchStyle(colors) {
  return `background: linear-gradient(135deg, ${colors.join(", ")})`;
}

/** The custom palette's wells, with + and − to add or drop a colour. */
function customRowHtml(colors) {
  return `${colors.map((c, i) => `<input type="color" data-index="${i}" value="${c}" aria-label="Colour ${i + 1}" />`).join("")}
    <button type="button" class="el-custom-step" data-step="-1" title="Remove the last colour" ${colors.length <= MIN_COLORS ? "disabled" : ""}>−</button>
    <button type="button" class="el-custom-step" data-step="1" title="Add a colour" ${colors.length >= MAX_COLORS ? "disabled" : ""}>+</button>`;
}

export function openEdgeLightsModal(state) {
  const on = isEdgeLightsOn(state);
  // Opens on what this desk last began (the lights in use, while on).
  const draft = readDeskOptions(state.settings, state.settings?.activeDeskId);

  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop edge-lights-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal edge-lights-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title el-title">Edge Lights</div>
    <div class="el-columns">
    <div class="el-rail"></div>
    <div class="el-form">
    <label class="el-row">
      <span class="el-label">Shape</span>
      <select class="el-kind">${KINDS.map((k) => `<option value="${k.id}">${escHtml(k.name)}</option>`).join("")}</select>
    </label>
    <label class="el-row">
      <span class="el-label">Fill</span>
      <select class="el-fill">${FILLS.map((f) => `<option value="${f.id}">${escHtml(f.name)}</option>`).join("")}</select>
    </label>
    <label class="el-row el-fill-sub" data-for="animation">
      <span class="el-label">Animation</span>
      <select class="el-animation">${ANIMATIONS.map((a) => `<option value="${a.id}">${escHtml(a.name)}</option>`).join("")}</select>
    </label>
    <label class="el-row el-fill-sub" data-for="animation">
      <span class="el-label el-size-label">Flake size</span>
      <input type="range" class="el-size" min="${LIMITS.flakeSize[0]}" max="${LIMITS.flakeSize[1]}" step="0.05" />
      <span class="el-value el-size-value"></span>
    </label>
    <div class="el-label el-colour-label">Colour</div>
    <div class="el-palettes" role="radiogroup" aria-label="Colour">
      ${PALETTES.map((p) => `
        <button type="button" class="el-palette" role="radio" data-palette="${p.id}" title="${escHtml(p.name)}">
          <span class="el-swatch" ${p.colors ? `style="${swatchStyle(p.colors)}"` : ""}></span>
          <span class="el-palette-name">${escHtml(p.name)}</span>
        </button>`).join("")}
    </div>
    <div class="el-custom-row" hidden></div>
    ${SLIDERS.map((s) => `
      <label class="el-row" data-row="${s.key}">
        <span class="el-label">${s.label}</span>
        <input type="range" data-key="${s.key}" min="${LIMITS[s.key][0]}" max="${LIMITS[s.key][1]}" step="${s.step}" />
        <span class="el-value" data-value="${s.key}"></span>
      </label>`).join("")}
    <div class="tree-delete-modal-btns">
      ${on ? `<button type="button" class="el-turn-off">Turn off</button><span class="el-spacer"></span>` : ""}
      <button type="button" class="tree-delete-cancel">Cancel</button>
      <button type="button" class="el-begin">${on ? "Apply" : "Begin"}</button>
    </div>
    </div>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const disposePickers = installColorPickers(modal);

  const refreshRail = mountPresetRail(modal.querySelector(".el-rail"), state, {
    getDraft: () => draft,
    // A preset replaces every setting; Object.assign keeps `draft` the
    // one object the closures here hold.
    onPick: (options) => {
      Object.assign(draft, options);
      kind.value = draft.kind;
      renderCustomRow();
      sync();
    },
  });

  const kind = modal.querySelector(".el-kind");
  kind.value = draft.kind;
  const fill = modal.querySelector(".el-fill");
  const animation = modal.querySelector(".el-animation");
  const customRow = modal.querySelector(".el-custom-row");
  const size = modal.querySelector(".el-size");
  // Snow's flakes and Hyperspace's rays keep a size each.
  const sizeKey = () => (draft.animation === "snow" ? "flakeSize" : "raySize");
  const renderCustomRow = () => { customRow.innerHTML = customRowHtml(draft.customColors); };
  renderCustomRow();

  const sync = () => {
    fill.value = draft.fill;
    animation.value = draft.animation;
    modal.querySelectorAll(".el-fill-sub").forEach((row) => { row.hidden = row.dataset.for !== draft.fill; });
    modal.querySelector(".el-size-label").textContent = draft.animation === "snow" ? "Flake size" : "Ray size";
    size.value = String(draft[sizeKey()]);
    modal.querySelector(".el-size-value").textContent = `${draft[sizeKey()].toFixed(1)}×`;
    // A blur has no colour: the palette goes, and opacity is how
    // strongly it blurs what is under it.
    const blurring = draft.fill === "blur";
    modal.querySelector(".el-colour-label").hidden = blurring;
    modal.querySelector(".el-palettes").hidden = blurring;
    modal.querySelector('[data-row="saturation"]').hidden = blurring;
    modal.querySelector('[data-row="opacity"] .el-label').textContent = blurring ? "Strength" : "Opacity";
    modal.querySelectorAll(".el-palette").forEach((b) => {
      const sel = b.dataset.palette === draft.palette;
      b.classList.toggle("selected", sel);
      b.setAttribute("aria-checked", String(sel));
    });
    modal.querySelector('[data-palette="custom"] .el-swatch')
      ?.setAttribute("style", swatchStyle(paletteColors({ ...draft, palette: "custom" })));
    customRow.hidden = blurring || draft.palette !== "custom";
    for (const s of SLIDERS) {
      modal.querySelector(`input[data-key="${s.key}"]`).value = String(draft[s.key]);
      modal.querySelector(`[data-value="${s.key}"]`).textContent = pct(draft[s.key]);
    }
    refreshRail?.();
    void previewEdgeLights(draft);
  };
  sync();

  modal.querySelectorAll(".el-palette").forEach((b) => {
    b.addEventListener("click", () => {
      draft.palette = b.dataset.palette;
      sync();
    });
  });
  kind.addEventListener("change", () => {
    draft.kind = kind.value;
    sync();
  });
  size.addEventListener("input", () => { draft[sizeKey()] = parseFloat(size.value); sync(); });
  for (const [el, key] of [[fill, "fill"], [animation, "animation"]]) {
    el.addEventListener("change", () => { draft[key] = el.value; sync(); });
  }
  // Delegated: the wells are rebuilt whenever a colour is added or dropped.
  customRow.addEventListener("input", (e) => {
    const well = e.target.closest?.('input[type="color"]');
    if (!well || !/^#[0-9a-f]{6}$/i.test(well.value)) return;
    draft.customColors = draft.customColors.map((c, i) => (i === +well.dataset.index ? well.value.toLowerCase() : c));
    sync();
  });
  customRow.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".el-custom-step");
    if (!btn) return;
    const list = draft.customColors;
    draft.customColors = +btn.dataset.step > 0
      ? [...list, nextCustomColor(list)].slice(0, MAX_COLORS)
      : list.slice(0, Math.max(MIN_COLORS, list.length - 1));
    renderCustomRow();
    sync();
  });
  modal.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener("input", () => {
      draft[input.dataset.key] = parseFloat(input.value);
      sync();
    });
  });

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    disposePickers();
    backdrop.remove();
  };
  const cancel = () => { close(); cancelEdgeLightsPreview(state); };
  const begin = () => { close(); void beginEdgeLights(state, draft); };
  function onKey(e) {
    // The colour picker, while open, takes its own keys, and so do the
    // rail's name fields.
    if (document.querySelector(".hush-colorpick")) return;
    if (e.target.closest?.(".el-rail input")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); begin(); }
  }
  document.addEventListener("keydown", onKey, true);

  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  modal.querySelector(".el-begin").addEventListener("click", begin);
  modal.querySelector(".el-turn-off")?.addEventListener("click", () => { close(); endEdgeLights(state); });
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) cancel(); });
  modal.querySelector(".el-begin").focus();
}
