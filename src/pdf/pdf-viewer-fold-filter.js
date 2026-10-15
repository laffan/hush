/**
 * The folded view's filter popup: which (type, colour) pairs of
 * annotation make folds, a checkbox each with a swatch and a count,
 * above the toolbar's filter button. The filter itself is
 * pdf-viewer-folds.js's.
 */

const TYPE_LABELS = {
  highlight: "Highlights",
  underline: "Underlines",
  ink: "Handwriting",
  note: "Notes",
  image: "Areas",
  text: "Text boxes",
};
const TYPE_ORDER = ["highlight", "underline", "ink", "note", "image", "text"];

/**
 * @param {object} src
 * @param {function} src.combos  () => Map key → { type, color, count }
 * @param {function} src.active  () => Set of the keys folding now
 * @param {function} src.toggle  (key, on) => void — a pair was ticked or unticked
 */
export function createFoldFilterPopup(src) {
  let popup = null;
  let filterBtnRef = null;
  let hostRef = null;

  function attach(filterBtn, host) {
    filterBtnRef = filterBtn;
    hostRef = host;
    filterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popup) close();
      else open();
    });
  }

  function onDocPointerDown(e) {
    if (!popup || popup.contains(e.target) || filterBtnRef?.contains(e.target)) return;
    close();
  }
  function onDocKeydown(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    if (!hostRef || !filterBtnRef) return;
    const active = src.active();
    popup = document.createElement("div");
    popup.className = "pdf-fold-filter-popup";
    const title = document.createElement("div");
    title.className = "pdf-fold-filter-title";
    title.textContent = "Fold annotations";
    popup.appendChild(title);

    const rank = (t) => (TYPE_ORDER.indexOf(t) === -1 ? 99 : TYPE_ORDER.indexOf(t));
    const combos = [...src.combos().entries()].sort((a, b) =>
      rank(a[1].type) !== rank(b[1].type) ? rank(a[1].type) - rank(b[1].type) : a[1].color < b[1].color ? -1 : 1);
    if (!combos.length) {
      const empty = document.createElement("div");
      empty.className = "pdf-fold-filter-empty";
      empty.textContent = "No annotations yet";
      popup.appendChild(empty);
    }
    for (const [key, c] of combos) {
      const row = document.createElement("label");
      row.className = "pdf-fold-filter-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = active.has(key);
      check.addEventListener("change", () => src.toggle(key, check.checked));
      const swatch = document.createElement("span");
      swatch.className = "pdf-fold-filter-swatch";
      swatch.style.background = c.color || "#ffff00";
      const text = document.createElement("span");
      text.textContent = TYPE_LABELS[c.type] || c.type;
      const count = document.createElement("span");
      count.className = "pdf-fold-filter-count";
      count.textContent = String(c.count);
      row.append(check, swatch, text, count);
      popup.appendChild(row);
    }
    hostRef.appendChild(popup);
    // Anchor above the toolbar, aligned to the filter button, clamped so
    // a narrow pane / stack column can't clip the right edge.
    const btnRect = filterBtnRef.getBoundingClientRect();
    const hostRect = hostRef.getBoundingClientRect();
    const left = Math.max(8, Math.min(btnRect.left - hostRect.left - 8, hostRect.width - popup.offsetWidth - 8));
    popup.style.left = `${left}px`;
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeydown, true);
  }

  function close() {
    if (!popup) return;
    popup.remove();
    popup = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeydown, true);
  }

  return { attach, close };
}
