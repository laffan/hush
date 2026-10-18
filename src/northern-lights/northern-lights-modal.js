/**
 * The Northern Lights modal — type (Polar or Scuba), colour, saturation,
 * opacity, depth and speed, then Begin or Cancel. Custom's colours are a
 * row of two to six wells, shown while Custom is chosen. Every change is drawn at once on the overlay behind
 * it (the backdrop is kept light so it can be seen); Cancel puts back
 * what was there before. While the lights are on it opens on their
 * options, with Apply in place of Begin and a Turn off beside them.
 *
 * Same shell as the sidebar's modals (`.tree-delete-modal`), so it sits
 * in the app's modal band above the overlay.
 */
import { escHtml } from "../sidebar/files-panel-shared.js";
import { installColorPickers } from "../ui/color-picker.js";
import {
  KINDS, PALETTES, LIMITS, MIN_COLORS, MAX_COLORS, readOptions, paletteColors, nextCustomColor, isNorthernLightsOn,
} from "./northern-lights-store.js";
import {
  previewNorthernLights, cancelNorthernLightsPreview, beginNorthernLights, endNorthernLights,
} from "./northern-lights.js";

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
    <button type="button" class="nl-custom-step" data-step="-1" title="Remove the last colour" ${colors.length <= MIN_COLORS ? "disabled" : ""}>−</button>
    <button type="button" class="nl-custom-step" data-step="1" title="Add a colour" ${colors.length >= MAX_COLORS ? "disabled" : ""}>+</button>`;
}

export function openNorthernLightsModal(state) {
  const on = isNorthernLightsOn(state);
  const draft = readOptions(state.settings);

  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop northern-lights-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal northern-lights-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">Northern Lights</div>
    <label class="nl-row">
      <span class="nl-label">Type</span>
      <select class="nl-kind">${KINDS.map((k) => `<option value="${k.id}">${escHtml(k.name)}</option>`).join("")}</select>
    </label>
    <div class="nl-label">Colour</div>
    <div class="nl-palettes" role="radiogroup" aria-label="Colour">
      ${PALETTES.map((p) => `
        <button type="button" class="nl-palette" role="radio" data-palette="${p.id}" title="${escHtml(p.name)}">
          <span class="nl-swatch" ${p.colors ? `style="${swatchStyle(p.colors)}"` : ""}></span>
          <span class="nl-palette-name">${escHtml(p.name)}</span>
        </button>`).join("")}
    </div>
    <div class="nl-custom-row" hidden></div>
    ${SLIDERS.map((s) => `
      <label class="nl-row">
        <span class="nl-label">${s.label}</span>
        <input type="range" data-key="${s.key}" min="${LIMITS[s.key][0]}" max="${LIMITS[s.key][1]}" step="${s.step}" />
        <span class="nl-value" data-value="${s.key}"></span>
      </label>`).join("")}
    <div class="tree-delete-modal-btns">
      ${on ? `<button type="button" class="nl-turn-off">Turn off</button><span class="nl-spacer"></span>` : ""}
      <button type="button" class="tree-delete-cancel">Cancel</button>
      <button type="button" class="nl-begin">${on ? "Apply" : "Begin"}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const disposePickers = installColorPickers(modal);

  const kind = modal.querySelector(".nl-kind");
  kind.value = draft.kind;
  const customRow = modal.querySelector(".nl-custom-row");
  const renderCustomRow = () => { customRow.innerHTML = customRowHtml(draft.customColors); };
  renderCustomRow();

  const sync = () => {
    modal.querySelectorAll(".nl-palette").forEach((b) => {
      const sel = b.dataset.palette === draft.palette;
      b.classList.toggle("selected", sel);
      b.setAttribute("aria-checked", String(sel));
    });
    modal.querySelector('[data-palette="custom"] .nl-swatch')
      ?.setAttribute("style", swatchStyle(paletteColors({ ...draft, palette: "custom" })));
    customRow.hidden = draft.palette !== "custom";
    for (const s of SLIDERS) {
      modal.querySelector(`input[data-key="${s.key}"]`).value = String(draft[s.key]);
      modal.querySelector(`[data-value="${s.key}"]`).textContent = pct(draft[s.key]);
    }
    void previewNorthernLights(draft);
  };
  sync();

  modal.querySelectorAll(".nl-palette").forEach((b) => {
    b.addEventListener("click", () => {
      draft.palette = b.dataset.palette;
      sync();
    });
  });
  kind.addEventListener("change", () => {
    draft.kind = kind.value;
    sync();
  });
  // Delegated: the wells are rebuilt whenever a colour is added or dropped.
  customRow.addEventListener("input", (e) => {
    const well = e.target.closest?.('input[type="color"]');
    if (!well || !/^#[0-9a-f]{6}$/i.test(well.value)) return;
    draft.customColors = draft.customColors.map((c, i) => (i === +well.dataset.index ? well.value.toLowerCase() : c));
    sync();
  });
  customRow.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".nl-custom-step");
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
  const cancel = () => { close(); cancelNorthernLightsPreview(state); };
  const begin = () => { close(); void beginNorthernLights(state, draft); };
  function onKey(e) {
    // The colour picker, while open, takes its own keys.
    if (document.querySelector(".hush-colorpick")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); begin(); }
  }
  document.addEventListener("keydown", onKey, true);

  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  modal.querySelector(".nl-begin").addEventListener("click", begin);
  modal.querySelector(".nl-turn-off")?.addEventListener("click", () => { close(); endNorthernLights(state); });
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) cancel(); });
  modal.querySelector(".nl-begin").focus();
}
