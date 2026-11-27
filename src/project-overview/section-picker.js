/**
 * The list of a project's sections that drops down from a selection in
 * the Overview Doc (section-links.js decides when; this draws it and
 * reports the pick).
 *
 * It is mounted on the page at a fixed position under the selection
 * (over it when there is no room below), kept within the Doc's column.
 * A press on it never takes the focus from the editor, so the selection
 * stays selected while you choose.
 * From the keyboard: ↓ / ↑ walk the list, Enter links, Escape puts the
 * list away and leaves the selection as it was.
 */
import { escHtml } from "../sidebar/files-panel-shared.js";
import { sectionTarget } from "../editor/plugins/section-link-syntax.js";

let openCount = 0;

/** Whether a section list is up — the board's Escape leaves it to the
 *  list (board-view.js). */
export const isSectionPickerOpen = () => openCount > 0;

const DOC_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.5L12.5 4.75v9.5h-8.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const PH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.5L12.5 4.75v9.5h-8.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6" stroke-linejoin="round"/></svg>`;

export function createSectionPicker({ view, sections, onPick }) {
  let el = null;
  let range = null;
  let current = null;
  let active = -1;
  let dismissed = null;
  let items = [];

  const keyOf = (r) => `${r.from}:${r.to}`;
  // What the list is kept inside: the Doc's column.
  const bounds = () => view.dom.closest(".po-doc-col") || view.dom;

  function build() {
    const list = sections();
    const rows = [];
    let lastGroups = "";
    for (const s of list) {
      const groups = s.groups || [];
      const sig = groups.map((g) => g.id).join("/");
      if (groups.length && sig !== lastGroups) {
        groups.forEach((g, i) => {
          const depth = Math.max(0, s.depth - groups.length + i);
          rows.push(`<div class="po-picker-group" style="--depth:${depth}">${escHtml(g.name || "Project")}</div>`);
        });
      }
      lastGroups = sig || lastGroups;
      if (!s.target) continue;
      const target = sectionTarget(s.target);
      const name = s.name || (s.placeholder ? "Untitled placeholder" : "Untitled");
      rows.push(`<button type="button" class="po-picker-item${s.placeholder ? " placeholder" : ""}${target === current ? " current" : ""}"`
        + ` style="--depth:${s.depth}" data-target="${escHtml(target)}">`
        + `${s.placeholder ? PH_ICON : DOC_ICON}<span class="po-picker-name">${escHtml(name)}</span>`
        + `${s.placeholder ? `<span class="po-picker-note">not written</span>` : ""}`
        + `${target === current ? `<span class="po-picker-check" aria-label="Linked here">✓</span>` : ""}</button>`);
    }
    el.innerHTML = `<div class="po-picker-head">${current ? "Link to another section" : "Link to a section"}</div>`
      + (rows.length ? `<div class="po-picker-list">${rows.join("")}</div>`
        : `<div class="po-picker-empty">This project has no documents yet.</div>`);
    items = [...el.querySelectorAll(".po-picker-item")];
    active = -1;
    for (const [i, b] of items.entries()) {
      b.addEventListener("pointerenter", () => setActive(i, false));
      b.addEventListener("click", () => pick(b.dataset.target));
    }
  }

  function setActive(i, scroll = true) {
    items[active]?.classList.remove("active");
    active = i;
    const b = items[active];
    if (!b) return;
    b.classList.add("active");
    if (scroll) b.scrollIntoView({ block: "nearest" });
  }

  function place() {
    if (!el || !range) return;
    const start = view.coordsAtPos(range.from, 1);
    const end = view.coordsAtPos(range.to, -1);
    if (!start || !end) { hide(); return; }
    const box = bounds().getBoundingClientRect();
    const margin = 8;
    el.style.maxWidth = Math.max(180, box.width - margin * 2) + "px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(box.left + margin, Math.min(start.left, box.right - w - margin));
    const floor = Math.min(window.innerHeight, box.bottom) - margin;
    let top = end.bottom + 6;
    if (top + h > floor && start.top - h - 6 > Math.max(0, box.top)) top = start.top - h - 6;
    el.style.left = left + "px";
    el.style.top = Math.max(margin, top) + "px";
  }

  const onScroll = () => place();

  function show(r, linkedTarget) {
    const key = keyOf(r);
    if (dismissed === key) return;
    dismissed = null;
    const same = el && range && keyOf(range) === key && current === linkedTarget;
    range = r;
    current = linkedTarget;
    if (!el) {
      el = document.createElement("div");
      el.className = "po-section-picker";
      el.setAttribute("role", "listbox");
      // Choosing must not take the focus — the selection is what gets
      // linked.
      el.addEventListener("pointerdown", (e) => e.preventDefault());
      el.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.appendChild(el);
      view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      openCount++;
    }
    if (!same) build();
    place();
  }

  function hide() {
    if (!el) return;
    el.remove();
    el = null;
    items = [];
    range = null;
    view.scrollDOM.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    openCount--;
  }

  function pick(target) {
    if (!target) return;
    hide();
    onPick(target);
  }

  return {
    show,
    hide,
    /** The selection went away: an Escape'd list may come back for it. */
    forget() { dismissed = null; },
    /** Sections changed under an open list. */
    refresh() { if (el) { build(); place(); } },
    move(d) {
      if (!el || !items.length) return !!el;
      setActive(active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length);
      return true;
    },
    choose() {
      if (!el || active < 0) return false;
      pick(items[active].dataset.target);
      return true;
    },
    dismiss() {
      if (!el) return false;
      dismissed = keyOf(range);
      hide();
      return true;
    },
    destroy: hide,
  };
}
