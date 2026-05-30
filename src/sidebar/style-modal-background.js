/**
 * Background-image section + JSON export row for the style editor.
 * Split out of style-modal.js to keep that file under the 700-line cap.
 *
 * A style's `backgroundImage` is `{ enabled, src, fit, repeat, blend,
 * opacity }`. `src` is a data-URL so the image rides Dropbox sync and
 * JSON export without a separate asset. The editor applies it as a
 * blended layer behind the text (see style-application.js).
 */
import { escAttr, escHtml } from "./styles-panel-shared.js";

const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

function opt(value, label, selected) {
  return `<option value="${escAttr(value)}"${value === selected ? " selected" : ""}>${escHtml(label)}</option>`;
}

function cap(s) { return s.replace(/(^|[-\s])(\w)/g, (_, p, c) => (p === "-" ? " " : p) + c.toUpperCase()); }

/** Background-image section HTML + a trailing Export row. */
export function renderStyleExtras(draft) {
  const bi = draft.backgroundImage || {};
  const enabled = !!bi.enabled;
  const fit = bi.fit || "cover";
  const repeat = bi.repeat || "no-repeat";
  const blend = bi.blend || "normal";
  const opacity = bi.opacity != null ? bi.opacity : 1;
  const hasSrc = !!bi.src;
  return `
    <div class="style-modal-section">
      <h3 class="style-modal-section-title">Background Image</h3>
      <div class="style-editor-row">
        <label>Enable</label>
        <div class="style-checkbox-group">
          <input type="checkbox" id="style-bg-enable" ${enabled ? "checked" : ""} />
        </div>
      </div>
      <div class="style-bg-fields${enabled ? "" : " style-row-hidden"}">
        <div class="style-editor-row">
          <label>Image</label>
          <div class="style-bg-image-group">
            <button type="button" class="style-bg-choose">${hasSrc ? "Replace…" : "Choose…"}</button>
            ${hasSrc ? `<button type="button" class="style-bg-clear" title="Remove">&times;</button>` : ""}
            <input type="file" id="style-bg-file" accept="image/*" style="display:none" />
          </div>
        </div>
        ${hasSrc ? `<div class="style-bg-preview"><img src="${escAttr(bi.src)}" alt="" /></div>` : ""}
        <div class="style-editor-row">
          <label>Display</label>
          <select id="style-bg-fit">${opt("cover", "Cover", fit)}${opt("contain", "Contain", fit)}${opt("100% 100%", "Stretch", fit)}${opt("auto", "Original", fit)}</select>
        </div>
        <div class="style-editor-row">
          <label>Repeat</label>
          <select id="style-bg-repeat">${opt("no-repeat", "No repeat", repeat)}${opt("repeat", "Tile", repeat)}${opt("repeat-x", "Tile X", repeat)}${opt("repeat-y", "Tile Y", repeat)}</select>
        </div>
        <div class="style-editor-row">
          <label>Blend</label>
          <select id="style-bg-blend">${BLEND_MODES.map((b) => opt(b, cap(b), blend)).join("")}</select>
        </div>
        <div class="style-editor-row">
          <label>Opacity</label>
          <div class="style-slider-group">
            <input type="range" id="style-bg-opacity" min="0" max="1" step="0.05" value="${opacity}" />
            <span class="style-slider-value">${Math.round(opacity * 100)}%</span>
          </div>
        </div>
      </div>
    </div>
    <div class="style-modal-section">
      <button type="button" class="style-modal-export">Export style as JSON</button>
    </div>`;
}

/** Wire the background-image controls + Export button. */
export function bindStyleExtras(backdrop, draft, scheduleSave, render) {
  const ensure = () => (draft.backgroundImage || (draft.backgroundImage = {}));

  const enableEl = backdrop.querySelector("#style-bg-enable");
  if (enableEl) enableEl.addEventListener("change", () => {
    ensure().enabled = enableEl.checked;
    render();
    scheduleSave();
  });

  const chooseBtn = backdrop.querySelector(".style-bg-choose");
  const fileEl = backdrop.querySelector("#style-bg-file");
  if (chooseBtn && fileEl) {
    chooseBtn.addEventListener("click", () => fileEl.click());
    fileEl.addEventListener("change", () => {
      const file = fileEl.files && fileEl.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { ensure().src = String(reader.result || ""); render(); scheduleSave(); };
      reader.readAsDataURL(file);
    });
  }

  const clearBtn = backdrop.querySelector(".style-bg-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { delete ensure().src; render(); scheduleSave(); });

  const fitEl = backdrop.querySelector("#style-bg-fit");
  if (fitEl) fitEl.addEventListener("change", () => { ensure().fit = fitEl.value; scheduleSave(); });
  const repeatEl = backdrop.querySelector("#style-bg-repeat");
  if (repeatEl) repeatEl.addEventListener("change", () => { ensure().repeat = repeatEl.value; scheduleSave(); });
  const blendEl = backdrop.querySelector("#style-bg-blend");
  if (blendEl) blendEl.addEventListener("change", () => { ensure().blend = blendEl.value; scheduleSave(); });
  const opacityEl = backdrop.querySelector("#style-bg-opacity");
  if (opacityEl) opacityEl.addEventListener("input", () => {
    const v = parseFloat(opacityEl.value);
    ensure().opacity = v;
    if (opacityEl.nextElementSibling) opacityEl.nextElementSibling.textContent = Math.round(v * 100) + "%";
    scheduleSave();
  });

  const exportBtn = backdrop.querySelector(".style-modal-export");
  if (exportBtn) exportBtn.addEventListener("click", () => downloadStyleJson(draft));
}

/** Serialize a style draft to a JSON file download (drops the id so an
 *  import always lands as a fresh style). */
export function downloadStyleJson(draft) {
  const style = { ...draft };
  delete style.id;
  delete style._migrated;
  const payload = { format: "hush-style", version: 1, style };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(draft.name || "style").replace(/[^\w.-]+/g, "-") || "style"}.hush-style.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
