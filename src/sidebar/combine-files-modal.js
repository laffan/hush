/**
 * "Combine Files" modal.
 *
 * Opened from the multi-select view when every selected item is a Doc.
 * Lets the user name the new document (becomes its H1 title), re-order
 * the source files before they become Hush tab sections, and optionally
 * move the originals to Trash.
 *
 * Reuses the notebook-export-modal (`nxm-*`) shell; combine-specific bits
 * live under `cmb-*` (split-combine.css).
 */

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
function escAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

/**
 * @param state  AppState
 * @param docs   ordered array of `{ fileId, name }` for the selected docs
 */
export function openCombineFilesModal(state, docs) {
  const items = (docs || []).filter((d) => d && d.fileId).map((d) => ({ ...d }));
  if (items.length < 2) return () => {};

  document.querySelectorAll(".cmb-backdrop").forEach((el) => el.remove());
  const backdrop = document.createElement("div");
  backdrop.className = "notebook-export-backdrop cmb-backdrop";
  const modal = document.createElement("div");
  modal.className = "notebook-export-modal cmb-modal";

  const choices = {
    name: "Combined Document",
    deleteOriginals: false,
    order: items.slice(),
  };

  modal.innerHTML = `
    <div class="nxm-title">Combine Files</div>

    <div class="nxm-section">
      <div class="nxm-label">Document name</div>
      <input type="text" class="nxm-filename-input cmb-name-input" value="${escAttr(choices.name)}" />
    </div>

    <div class="nxm-section">
      <div class="nxm-label">Order (top becomes the first section)</div>
      <ul class="cmb-file-list"></ul>
    </div>

    <div class="nxm-section">
      <label class="nxm-checkbox-label">
        <input type="checkbox" class="cmb-delete-originals" />
        Delete originals
      </label>
    </div>

    <div class="nxm-actions">
      <button class="nxm-cancel">Cancel</button>
      <button class="nxm-confirm">Combine</button>
    </div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const nameInput = modal.querySelector(".cmb-name-input");
  const delToggle = modal.querySelector(".cmb-delete-originals");
  const list = modal.querySelector(".cmb-file-list");
  const confirmBtn = modal.querySelector(".nxm-confirm");

  function renderList() {
    list.innerHTML = choices.order.map((d, i) => `
      <li class="cmb-file-row" data-idx="${i}">
        <span class="cmb-drag" data-idx="${i}" aria-label="Drag to reorder">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>
        </span>
        <span class="cmb-file-name">${escHtml(d.name || "Untitled")}</span>
      </li>
    `).join("");
    wireReorder();
  }

  // Pointer-based drag reorder (works on touch too) — mirrors the stack
  // list view. A thin marker line shows the drop position; on release the
  // dragged entry is spliced to the target slot and the list re-renders.
  function wireReorder() {
    list.querySelectorAll(".cmb-drag").forEach((handle) => {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const dragIdx = parseInt(handle.dataset.idx, 10);
        const rows = Array.from(list.querySelectorAll(".cmb-file-row"));
        const dragRow = rows[dragIdx];
        if (!dragRow) return;
        dragRow.classList.add("cmb-row-dragging");

        const computeTarget = (clientY) => {
          for (let j = 0; j < rows.length; j++) {
            const rect = rows[j].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return j;
          }
          return rows.length;
        };

        const onMove = (ev) => {
          const targetIdx = computeTarget(ev.clientY);
          list.querySelectorAll(".cmb-drop").forEach((d) => d.remove());
          if (targetIdx !== dragIdx && targetIdx !== dragIdx + 1) {
            const marker = document.createElement("li");
            marker.className = "cmb-drop";
            list.insertBefore(marker, rows[targetIdx] || null);
          }
        };

        const onUp = (ev) => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          dragRow.classList.remove("cmb-row-dragging");
          list.querySelectorAll(".cmb-drop").forEach((d) => d.remove());
          const targetIdx = computeTarget(ev.clientY);
          if (targetIdx !== dragIdx && targetIdx !== dragIdx + 1) {
            const arr = choices.order;
            const [moved] = arr.splice(dragIdx, 1);
            const insertAt = targetIdx > dragIdx ? targetIdx - 1 : targetIdx;
            arr.splice(insertAt, 0, moved);
            renderList();
          }
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    });
  }

  nameInput.addEventListener("input", () => { choices.name = nameInput.value; });
  delToggle.addEventListener("change", () => { choices.deleteOriginals = delToggle.checked; });

  const cleanup = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); cleanup(); }
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(); });
  modal.querySelector(".nxm-cancel").addEventListener("click", cleanup);

  confirmBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Combining…";
    try {
      state.clearSelectedDocs();
      await state.combineDocsIntoDoc(choices.order.map((d) => d.fileId), {
        name,
        deleteOriginals: choices.deleteOriginals,
      });
      cleanup();
    } catch (err) {
      console.error("Combine files failed:", err);
      confirmBtn.textContent = "Combine failed";
      setTimeout(() => { confirmBtn.textContent = "Combine"; confirmBtn.disabled = false; }, 2000);
    }
  });

  renderList();
  nameInput.focus();
  nameInput.select();
  return cleanup;
}
