/**
 * The viewer's find bar: ⌘F (or the magnifier in the bottom bar) brings
 * it up over the top right of the pages. Typing searches (after a short
 * pause, pdf-viewer-search.js) and opens a list of the matches under the
 * field — each with its page and a few lines of the text around it, a
 * hundred at a time with "Show more matches" below — where a click shows
 * that match. Enter / ⇧Enter and the arrows step through the matches;
 * Escape closes the list, then the bar (its hits go with it).
 */
import { SEARCH_ICON } from "./pdf-viewer-icons.js";

const DEBOUNCE_MS = 250;
/** Matches listed at a time; "Show more matches" adds as many again. */
const PAGE = 100;

const UP = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10 L8 6 L12 10"/></svg>`;
const DOWN = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 L8 10 L12 6"/></svg>`;
const CLOSE = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4 L12 12 M12 4 L4 12"/></svg>`;

/**
 * @param {HTMLElement} host  Where the bar sits (over the pages)
 * @param {object} search     createPdfSearch's handle
 * @param {function} [onClose] The bar was closed (focus goes back to the pages)
 */
export function createFindBar(host, search, onClose) {
  const bar = document.createElement("div");
  bar.className = "pdf-find-bar";
  bar.style.display = "none";
  bar.innerHTML = `
    <span class="pdf-find-glyph">${SEARCH_ICON}</span>
    <input type="text" class="pdf-find-input" placeholder="Find in this PDF" aria-label="Find in this PDF" spellcheck="false" autocomplete="off">
    <span class="pdf-find-count"></span>
    <button type="button" class="pdf-find-step" data-dir="-1" title="Previous match (⇧Enter)" aria-label="Previous match">${UP}</button>
    <button type="button" class="pdf-find-step" data-dir="1" title="Next match (Enter)" aria-label="Next match">${DOWN}</button>
    <button type="button" class="pdf-find-close" title="Close (Esc)" aria-label="Close">${CLOSE}</button>
    <div class="pdf-find-hits" role="listbox" style="display:none"></div>`;
  host.appendChild(bar);
  const input = bar.querySelector(".pdf-find-input");
  const count = bar.querySelector(".pdf-find-count");
  const list = bar.querySelector(".pdf-find-hits");
  const [prevBtn, nextBtn] = bar.querySelectorAll(".pdf-find-step");

  let status = null;
  let shown = PAGE;
  let listOpen = false;
  let timer = 0;

  const run = (q) => {
    clearTimeout(timer);
    shown = PAGE;
    search.search(q);
  };

  function setListOpen(on) {
    listOpen = on;
    renderList();
  }

  function renderList() {
    const hits = status?.query ? status.hits : [];
    const visible = listOpen && hits.length > 0;
    list.style.display = visible ? "" : "none";
    if (!visible) return;
    const current = status.current;
    list.innerHTML = "";
    hits.slice(0, shown).forEach((h, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pdf-find-hit" + (i === current - 1 ? " current" : "");
      row.dataset.hit = String(i);
      row.setAttribute("role", "option");
      const page = document.createElement("span");
      page.className = "pdf-find-hit-page";
      page.textContent = `p. ${h.page}`;
      const text = document.createElement("span");
      text.className = "pdf-find-hit-text";
      const mark = document.createElement("mark");
      mark.textContent = h.match;
      text.append(h.before, mark, h.after);
      row.append(page, text);
      row.addEventListener("click", () => {
        search.goTo(i);
        setListOpen(false);
      });
      list.appendChild(row);
    });
    if (hits.length > shown) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "pdf-find-more";
      more.textContent = `Show more matches (${hits.length - shown} more)`;
      more.addEventListener("click", () => { shown += PAGE; renderList(); });
      list.appendChild(more);
    }
    list.querySelector(".pdf-find-hit.current")?.scrollIntoView({ block: "nearest" });
  }

  search.onChange((s) => {
    status = s;
    count.textContent = !s.query ? ""
      : s.total ? `${s.current}/${s.total}${s.done ? "" : "+"}`
      : s.done ? "No matches" : "…";
    prevBtn.disabled = nextBtn.disabled = !s.total;
    renderList();
  });

  /** A query the search hasn't run yet (still being typed) is searched
   *  rather than stepped. */
  const step = (dir) => {
    if (status?.query !== input.value.trim()) run(input.value);
    else search.step(dir);
  };

  input.addEventListener("input", () => {
    setListOpen(true);
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), DEBOUNCE_MS);
  });
  input.addEventListener("focus", () => setListOpen(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (listOpen && status?.hits.length) setListOpen(false);
      else close();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      // ⌘F again: select what is there, to type over it.
      e.preventDefault();
      e.stopPropagation();
      input.select();
    }
  });
  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  bar.querySelector(".pdf-find-close").addEventListener("click", () => close());
  // A press outside the bar closes the list (not the bar or its hits).
  const onDocPointerDown = (e) => {
    if (listOpen && !bar.contains(e.target)) setListOpen(false);
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);

  function open() {
    bar.style.display = "";
    input.focus();
    input.select();
  }

  function close() {
    if (bar.style.display === "none") return;
    clearTimeout(timer);
    bar.style.display = "none";
    listOpen = false;
    input.value = "";
    search.clear();
    onClose?.();
  }

  return {
    open,
    close,
    isOpen: () => bar.style.display !== "none",
    destroy() {
      clearTimeout(timer);
      search.onChange(null);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      bar.remove();
    },
  };
}
