/**
 * The bookmark UI shared by PDFs and notebooks — one look and one set of
 * controls for both:
 *
 *  - the ribbon icon and the eight-colour palette
 *  - the list popup (a row per bookmark: colour, name, edit, delete,
 *    ⌘-drag out as a link) with **Add Bookmark** at its foot
 *  - the name + colour editor, and the colour-only palette a stamped
 *    notebook bookmark opens from its icon
 *  - the stamp: while one is armed, the pointer is the ribbon and the
 *    next click on the surface places a bookmark there
 *
 * What a bookmark *is* stays with each surface: a PDF's live on its
 * registry entry as page fractions (`pdf/pdf-bookmarks.js`), a
 * notebook's are world points on the canvas (`notebook/bookmarks.ts`).
 * This module only draws and reports; every change goes back through the
 * callbacks. Plain DOM with no app state, so the notebook bundle can use
 * it too (see bookmark-ui.d.ts).
 *
 * One popup is open at a time, across both surfaces.
 */

export const BOOKMARK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12V21l-6-4.4L6 21z"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5 16.5 4 5 15.5z"/></svg>`;

// Mirrors the sidebar ROW_COLORS swatches so the palette reads familiar.
export const BOOKMARK_COLORS = [
  "#ef5350", "#ff9800", "#ffeb3b", "#4caf50",
  "#00bcd4", "#42a5f5", "#ab47bc", "#ec407a",
];

/** The ribbon, filled in `color` — the stamped marker and list rows. */
export function bookmarkGlyph(color, size = 16) {
  const c = escAttr(color || BOOKMARK_COLORS[0]);
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M6 3.5h12V21l-6-4.4L6 21z" fill="${c}"/></svg>`;
}

/** The pointer while a stamp is armed: the ribbon, hot spot at its
 *  centre (where the bookmark's point lands). */
export const BOOKMARK_STAMP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M6 3.5h12V21l-6-4.4L6 21z" fill="#ef5350" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
)}") 11 11, crosshair`;

export function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
function escAttr(str) { return escHtml(str).replace(/"/g, "&quot;"); }

// ===== Popup plumbing (one open at a time) =====

let _popupEl = null;
let _popupCleanup = null;

export function closeBookmarkPopup() {
  if (_popupCleanup) { _popupCleanup(); _popupCleanup = null; }
  if (_popupEl) { _popupEl.remove(); _popupEl = null; }
}

export function isBookmarkPopupOpen(el) {
  return !!_popupEl && (!el || _popupEl === el);
}

/** A zero-size anchor at a screen point, for popups that open at the
 *  pointer rather than off an element. */
export function pointAnchor(x, y) {
  return {
    getBoundingClientRect: () => ({
      left: x, right: x, top: y, bottom: y, width: 0, height: 0, x, y,
    }),
  };
}

export function mountBookmarkPopup(el, anchor) {
  closeBookmarkPopup();
  _popupEl = el;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  let left = Math.min(r.left, window.innerWidth - w - 8);
  if (left < 8) left = 8;
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;

  const onDown = (e) => { if (_popupEl && !_popupEl.contains(e.target)) closeBookmarkPopup(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeBookmarkPopup(); }
  };
  // Defer one frame so the opening click doesn't instantly close it.
  // `pointerdown`, not `mousedown`: iOS delivers the synthetic
  // `mousedown` hundreds of ms after `touchend`, well past that frame,
  // so a touch-opened popup would dismiss itself on the very tap that
  // opened it (README-TECHNICAL, Platform gotchas).
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  _popupCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

function swatchesHtml(active) {
  return `<div class="pdf-bm-colors">
    ${BOOKMARK_COLORS.map((c) => `<button type="button" class="pdf-bm-swatch${c === active ? " active" : ""}" data-color="${c}" style="--bm-color:${c}" title="${c}"></button>`).join("")}
  </div>`;
}

// ===== Name + colour editor =====

/**
 * @param {object} o
 * @param {{getBoundingClientRect(): DOMRect}} o.anchor
 * @param {string} o.title
 * @param {string} [o.name]
 * @param {string} [o.color]
 * @param {string} o.saveLabel
 * @param {(name: string, color: string) => void} o.onSave
 * @param {() => void} [o.onDelete]  Shows a Delete button.
 */
export function openBookmarkEditor({ anchor, title, name = "", color, saveLabel, onSave, onDelete }) {
  const el = document.createElement("div");
  el.className = "pdf-bm-popover";
  let chosen = color || BOOKMARK_COLORS[0];
  el.innerHTML = `
    <div class="pdf-bm-popover-title">${escHtml(title)}</div>
    <input type="text" class="pdf-bm-name" placeholder="Bookmark name" value="${escAttr(name)}" />
    ${swatchesHtml(chosen)}
    <div class="pdf-bm-actions">
      ${onDelete ? `<button type="button" class="pdf-bm-btn pdf-bm-delete">Delete</button>` : ""}
      <span class="pdf-bm-actions-spacer"></span>
      <button type="button" class="pdf-bm-btn pdf-bm-cancel">Cancel</button>
      <button type="button" class="pdf-bm-btn pdf-bm-save">${escHtml(saveLabel)}</button>
    </div>
  `;
  mountBookmarkPopup(el, anchor);

  const nameInput = el.querySelector(".pdf-bm-name");
  el.querySelectorAll(".pdf-bm-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      chosen = sw.dataset.color;
      el.querySelectorAll(".pdf-bm-swatch").forEach((s) => s.classList.toggle("active", s === sw));
    });
  });
  const save = () => {
    const value = nameInput.value;
    closeBookmarkPopup();
    onSave(value, chosen);
  };
  el.querySelector(".pdf-bm-save").addEventListener("click", save);
  el.querySelector(".pdf-bm-cancel").addEventListener("click", () => closeBookmarkPopup());
  el.querySelector(".pdf-bm-delete")?.addEventListener("click", () => {
    closeBookmarkPopup();
    onDelete?.();
  });
  nameInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); save(); }
  });
  nameInput.focus();
  nameInput.select();
}

// ===== Colour palette (a stamped bookmark's icon) =====

/**
 * The palette on its own — a click on a swatch applies it and closes.
 * `actions` add small text buttons under the swatches (Copy link,
 * Delete).
 * @param {object} o
 * @param {{getBoundingClientRect(): DOMRect}} o.anchor
 * @param {string} [o.color]
 * @param {(color: string) => void} o.onPick
 * @param {{label: string, danger?: boolean, run: () => void}[]} [o.actions]
 */
export function openBookmarkColorPalette({ anchor, color, onPick, actions = [] }) {
  const el = document.createElement("div");
  el.className = "pdf-bm-popover bm-palette";
  el.innerHTML = `
    ${swatchesHtml(color)}
    ${actions.length ? `<div class="pdf-bm-actions">${actions.map((a, i) =>
      `<button type="button" class="pdf-bm-btn${a.danger ? " pdf-bm-delete" : ""}" data-i="${i}">${escHtml(a.label)}</button>`).join("")}</div>` : ""}
  `;
  mountBookmarkPopup(el, anchor);
  el.querySelectorAll(".pdf-bm-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      closeBookmarkPopup();
      onPick(sw.dataset.color);
    });
  });
  el.querySelectorAll(".pdf-bm-btn[data-i]").forEach((b) => {
    b.addEventListener("click", () => {
      closeBookmarkPopup();
      actions[Number(b.dataset.i)]?.run();
    });
  });
}

// ===== List popup =====

let _openList = null;

/**
 * @param {object} o
 * @param {{getBoundingClientRect(): DOMRect}} o.anchor
 * @param {string} o.key  Identifies the bookmark set (a file id), so a
 *        change to it can rebuild an open list in place.
 * @param {() => object[]} o.getItems  `{ id, name, color }` and whatever
 *        the callbacks need.
 * @param {(bm: object) => string} [o.meta]  Right-hand caption (a page).
 * @param {(bm: object) => void} o.onPick
 * @param {(bm: object, rowRect: DOMRect) => void} [o.onEdit]
 * @param {(bm: object) => void | Promise<void>} o.onDelete
 * @param {(bm: object) => string | null} [o.linkText]  Markdown link a
 *        ⌘-drag of the row carries into a Doc.
 * @param {() => void} [o.onAdd]  Shows **Add Bookmark** at the foot.
 */
export function openBookmarkListPopup(o) {
  const el = document.createElement("div");
  el.className = "pdf-bm-popup";

  const rebuild = () => {
    const items = o.getItems() || [];
    const rows = items.length
      ? items.map((bm) => `
        <div class="pdf-bm-row" data-bm-id="${escAttr(bm.id)}">
          <span class="bm-row-icon">${bookmarkGlyph(bm.color, 14)}</span>
          <span class="pdf-bm-row-name">${escHtml(bm.name || "Untitled")}</span>
          ${o.meta ? `<span class="pdf-bm-row-page">${escHtml(o.meta(bm) || "")}</span>` : ""}
          ${o.onEdit ? `<button type="button" class="pdf-bm-row-btn pdf-bm-row-edit" title="Edit bookmark">${EDIT_ICON}</button>` : ""}
          <button type="button" class="pdf-bm-row-btn pdf-bm-row-delete" title="Delete bookmark">×</button>
        </div>`).join("")
      : `<div class="pdf-bm-empty">No bookmarks yet.</div>`;
    el.innerHTML = rows + (o.onAdd
      ? `<button type="button" class="bm-add-row">${BOOKMARK_ICON}<span>Add Bookmark</span></button>`
      : "");

    el.querySelectorAll(".pdf-bm-row").forEach((row) => {
      const bm = items.find((b) => b.id === row.dataset.bmId);
      if (!bm) return;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".pdf-bm-row-btn")) return;
        closeBookmarkPopup();
        o.onPick(bm);
      });
      // ⌘-drag a row out as a markdown deep link — drops into any doc
      // editor or notebook canvas via the shared text-drag pipeline.
      row.addEventListener("pointerdown", async (e) => {
        if (!o.linkText) return;
        const { isCmdHeld } = await import("../cmd-button.js");
        if (!(e.metaKey || e.ctrlKey || isCmdHeld())) return;
        const text = o.linkText(bm);
        if (!text) return;
        e.preventDefault();
        e.stopPropagation();
        const { startTextDrag } = await import("../pane/text-drag.js");
        closeBookmarkPopup();
        startTextDrag({ text, initialEvent: e });
      });
      row.querySelector(".pdf-bm-row-edit")?.addEventListener("click", (e) => {
        e.stopPropagation();
        o.onEdit(bm, row.getBoundingClientRect());
      });
      row.querySelector(".pdf-bm-row-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        await o.onDelete(bm);
        rebuild();
      });
    });
    el.querySelector(".bm-add-row")?.addEventListener("click", () => {
      closeBookmarkPopup();
      o.onAdd();
    });
  };

  rebuild();
  mountBookmarkPopup(el, o.anchor);
  _openList = { key: o.key, rebuild, el };
  return { rebuild };
}

/** Rebuild the open list if it shows `key`'s bookmarks. */
export function refreshBookmarkList(key) {
  if (!_openList || _openList.key !== key) return;
  if (!isBookmarkPopupOpen(_openList.el)) { _openList = null; return; }
  _openList.rebuild();
}

// ===== The stamp =====

let _stamp = null;

/**
 * Arm the stamp: the pointer becomes the ribbon (`body.bookmark-stamping-
 * <prefix>`, the key's prefix — each surface's CSS decides where the
 * cursor shows) until the surface
 * reports a placement (`endBookmarkStamp`), Escape is pressed, or another
 * stamp is armed. `key` says which surface may take the click.
 * @param {string} key
 * @param {() => void} [onCancel]
 */
export function startBookmarkStamp(key, onCancel) {
  endBookmarkStamp(true);
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    endBookmarkStamp(true);
  };
  window.addEventListener("keydown", onKey, true);
  // `bookmark-stamping-pdf` / `-nb`: the key's prefix, so a surface's
  // cursor rule only lights up for its own stamp.
  const cls = `bookmark-stamping-${String(key).split(":")[0]}`;
  document.body.classList.add(cls);
  _stamp = { key, onCancel, onKey, cls };
}

/** The key of the armed stamp, or null. */
export function bookmarkStampKey() {
  return _stamp ? _stamp.key : null;
}

/** Disarm. `cancelled` runs the arming surface's onCancel. */
export function endBookmarkStamp(cancelled = false) {
  const s = _stamp;
  if (!s) return;
  _stamp = null;
  window.removeEventListener("keydown", s.onKey, true);
  document.body.classList.remove(s.cls);
  if (cancelled) s.onCancel?.();
}

/** ⌘-drag a bookmark out as a markdown link — into a Doc or onto a
 *  canvas, through the shared text-drag pipeline. */
export async function startBookmarkLinkDrag(text, initialEvent) {
  const { startTextDrag } = await import("../pane/text-drag.js");
  closeBookmarkPopup();
  startTextDrag({ text, initialEvent });
}
