/**
 * The Edge Lights modal's left rail — saved presets, as the style editor
 * lists styles. A row loads its settings into the modal (and so onto the
 * lights behind it); the row whose settings are the ones on screen is
 * marked. Double-click a name to rename it; × deletes, after a second
 * press on the same ×. The + at the foot names the current settings.
 *
 * Naming, renaming and confirming all happen in the rail itself rather
 * than in the app's prompt and confirm modals: those clear every modal of
 * this kind (`.tree-delete-modal-backdrop`) when they open, this one
 * included.
 */
import { escHtml, escAttrValue } from "../sidebar/files-panel-shared.js";
import { readPresets, savePresets, sameOptions, describeOptions, paletteColors } from "./edge-lights-store.js";

const newId = () => `elp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function chipStyle(options) {
  return `background: linear-gradient(135deg, ${paletteColors(options).join(", ")})`;
}

/** Mount the rail into `rail`. `getDraft()` is the modal's current
 *  settings; `onPick(options)` loads a preset's. Returns `refresh()`, for
 *  the modal to call whenever its settings change. */
export function mountPresetRail(rail, state, { getDraft, onPick }) {
  rail.innerHTML = `
    <div class="el-rail-title">Presets</div>
    <div class="el-rail-list" role="listbox" aria-label="Presets"></div>
    <div class="el-rail-naming" hidden>
      <input type="text" class="el-rail-name" placeholder="Preset name" aria-label="Preset name" />
    </div>
    <button type="button" class="el-rail-add" title="Save the current settings as a preset">+</button>`;
  const list = rail.querySelector(".el-rail-list");
  const naming = rail.querySelector(".el-rail-naming");
  const nameInput = rail.querySelector(".el-rail-name");
  const addBtn = rail.querySelector(".el-rail-add");
  let armedDelete = null;
  let renaming = null;

  const presets = () => readPresets(state.settings);
  const write = (next) => { void savePresets(state, next); render(); };

  // The rows are rebuilt only when what they show changes (a preset
  // added, renamed or deleted, a rename or delete in progress); the
  // modal calls back on every change of its settings, which only moves
  // the "current" mark. Rebuilding on every call replaced the row under
  // the first click of a double-click, so the second never reached it.
  let shape = "";
  function render() {
    const draft = getDraft();
    const items = presets();
    const nextShape = JSON.stringify([items, renaming, armedDelete]);
    if (nextShape !== shape) {
      shape = nextShape;
      list.innerHTML = items.length
        ? items.map((p) => {
          const name = renaming === p.id
            ? `<input type="text" class="el-rail-rename" value="${escAttrValue(p.name)}" aria-label="Preset name" />`
            : `<span class="el-rail-row-name">${escHtml(p.name)}</span>`;
          return `<div class="el-rail-row" role="option" data-id="${escAttrValue(p.id)}" title="${escAttrValue(describeOptions(p.options))}">
            <span class="el-rail-chip" style="${chipStyle(p.options)}"></span>
            ${name}
            <button type="button" class="el-rail-delete${armedDelete === p.id ? " armed" : ""}" data-id="${escAttrValue(p.id)}"
              title="${armedDelete === p.id ? "Press again to delete" : "Delete preset"}">${armedDelete === p.id ? "Delete" : "×"}</button>
          </div>`;
        }).join("")
        : `<div class="el-rail-empty">Save the settings you like with +.</div>`;
      const field = list.querySelector(".el-rail-rename");
      if (field) { field.focus(); field.select(); }
    }
    for (const row of list.querySelectorAll(".el-rail-row")) {
      const p = items.find((x) => x.id === row.dataset.id);
      const current = !!p && sameOptions(p.options, draft);
      row.classList.toggle("current", current);
      row.setAttribute("aria-selected", String(current));
    }
  }

  function startNaming() {
    naming.hidden = false;
    addBtn.hidden = true;
    nameInput.value = describeOptions(getDraft());
    nameInput.focus();
    nameInput.select();
  }
  function stopNaming() {
    naming.hidden = true;
    addBtn.hidden = false;
  }
  function commitNaming() {
    const name = nameInput.value.trim();
    stopNaming();
    if (!name) return;
    write([...presets(), { id: newId(), name, options: { ...getDraft() } }]);
  }
  function commitRename(field) {
    const id = renaming;
    renaming = null;
    const name = field.value.trim();
    if (!name) { render(); return; }
    write(presets().map((p) => (p.id === id ? { ...p, name } : p)));
  }

  addBtn.addEventListener("click", startNaming);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitNaming(); }
    else if (e.key === "Escape") { e.preventDefault(); stopNaming(); }
  });
  nameInput.addEventListener("blur", () => { if (!naming.hidden) commitNaming(); });

  list.addEventListener("click", (e) => {
    const del = e.target.closest(".el-rail-delete");
    if (del) {
      if (armedDelete === del.dataset.id) {
        armedDelete = null;
        write(presets().filter((p) => p.id !== del.dataset.id));
      } else {
        armedDelete = del.dataset.id;
        render();
      }
      return;
    }
    if (e.target.closest(".el-rail-rename")) return;
    const row = e.target.closest(".el-rail-row");
    const preset = row && presets().find((p) => p.id === row.dataset.id);
    if (preset) onPick({ ...preset.options });
  });
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".el-rail-row");
    if (!row || e.target.closest(".el-rail-delete")) return;
    renaming = row.dataset.id;
    render();
  });
  list.addEventListener("keydown", (e) => {
    const field = e.target.closest(".el-rail-rename");
    if (!field) return;
    if (e.key === "Enter") { e.preventDefault(); commitRename(field); }
    else if (e.key === "Escape") { e.preventDefault(); renaming = null; render(); }
  });
  list.addEventListener("focusout", (e) => {
    if (e.target.closest?.(".el-rail-rename") && renaming) commitRename(e.target);
  });
  // An armed × stands down once the pointer leaves its row.
  list.addEventListener("pointerout", (e) => {
    if (!armedDelete) return;
    const row = e.target.closest?.(".el-rail-row");
    if (row && !row.contains(e.relatedTarget)) { armedDelete = null; render(); }
  });

  render();
  return render;
}
