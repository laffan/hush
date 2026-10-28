/**
 * Campfire Cursor Options — the text's opacity away from the light, the
 * light's brightness and range, whether only the caret's line is lit,
 * and whether the lit text takes the caret's colour. Every change is
 * drawn at once on the doc behind the modal (the backdrop only just
 * dims); Cancel puts back what was there. While the campfire is lit it opens on its options, with Apply
 * in place of Begin and a Turn off beside them.
 *
 * Same shell as the sidebar's modals (`.tree-delete-modal`).
 */
import { LIMITS, readDeskCampfireOptions, isCampfireOn, campfireAvailable } from "./campfire-store.js";
import { previewCampfire, cancelCampfirePreview, beginCampfire, endCampfire } from "./campfire.js";

const SLIDERS = [
  { key: "baseOpacity", label: "Text opacity", step: 0.005, show: (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%` },
  { key: "brightness", label: "Brightness", step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
  { key: "range", label: "Range", step: 0.5, show: (v) => `${v} ln` },
];

export function openCampfireModal(state) {
  const on = isCampfireOn(state);
  // Opens on what this desk last began.
  const draft = readDeskCampfireOptions(state.settings, state.settings?.activeDeskId);
  const available = campfireAvailable(state.settings);

  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop campfire-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal campfire-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">Campfire Cursor Options</div>
    <div class="cf-form">
      ${available ? "" : `<p class="cf-note">Campfire Cursor needs a Block, Underline or Thick Line cursor — choose one in Styles → Cursor. These options are kept for when it can be lit.</p>`}
      ${SLIDERS.map((s) => `
        <label class="el-row">
          <span class="el-label">${s.label}</span>
          <input type="range" data-key="${s.key}" min="${LIMITS[s.key][0]}" max="${LIMITS[s.key][1]}" step="${s.step}" />
          <span class="el-value" data-value="${s.key}"></span>
        </label>`).join("")}
      <label class="cf-check"><input type="checkbox" class="cf-line" /> Only the current line is lit</label>
      <label class="cf-check"><input type="checkbox" class="cf-match" /> Glow matches cursor colour</label>
    </div>
    <div class="tree-delete-modal-btns">
      ${on ? `<button type="button" class="cf-turn-off">Turn off</button><span class="el-spacer"></span>` : ""}
      <button type="button" class="tree-delete-cancel">Cancel</button>
      <button type="button" class="cf-begin" ${available ? "" : "disabled"}>${on ? "Apply" : "Begin"}</button>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const match = modal.querySelector(".cf-match");
  const line = modal.querySelector(".cf-line");

  const sync = () => {
    for (const s of SLIDERS) {
      modal.querySelector(`input[data-key="${s.key}"]`).value = String(draft[s.key]);
      modal.querySelector(`[data-value="${s.key}"]`).textContent = s.show(draft[s.key]);
    }
    match.checked = draft.matchCursor;
    line.checked = draft.currentLine;
    previewCampfire(state, draft);
  };
  sync();

  modal.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener("input", () => { draft[input.dataset.key] = parseFloat(input.value); sync(); });
  });
  match.addEventListener("change", () => { draft.matchCursor = match.checked; sync(); });
  line.addEventListener("change", () => { draft.currentLine = line.checked; sync(); });

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const cancel = () => { close(); cancelCampfirePreview(state); };
  const begin = () => {
    if (!available) return;
    close();
    beginCampfire(state, draft);
  };
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); begin(); }
  }
  document.addEventListener("keydown", onKey, true);

  modal.querySelector(".tree-delete-cancel").addEventListener("click", cancel);
  modal.querySelector(".cf-begin").addEventListener("click", begin);
  modal.querySelector(".cf-turn-off")?.addEventListener("click", () => { close(); endCampfire(state); });
  backdrop.addEventListener("pointerdown", (e) => { if (e.target === backdrop) cancel(); });
  (available ? modal.querySelector(".cf-begin") : modal.querySelector(".tree-delete-cancel")).focus();
}
