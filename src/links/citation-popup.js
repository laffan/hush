/**
 * Floating Zotero citation search popup. Triggered when the user types
 * `[@` in a doc — lists the cached Zotero references, narrows by typed
 * query, commits on Enter / click. Mirrors the wikilink popup's handle
 * API and reuses its CSS (with a `citation-popup` modifier class).
 */

import { fuzzySearch } from "../zotero.js";

const MAX_ROWS = 12;

/** Mount a citation popup. Returns the same handle shape as
 *  `openWikilinkPopup`: update(query), moveSelection(delta), commit(),
 *  setAnchor(rect), destroy(), isEmpty().
 *
 *  Options:
 *    refs         — full Zotero reference list ({ key, title, citekey, … })
 *    onPick       — called with the chosen reference (or null on empty commit)
 *    anchor       — initial { left, top, bottom } viewport coords
 *    initialQuery — seed query
 */
export function openCitationPopup(opts) {
  const refs = opts.refs || [];
  let filtered = fuzzySearch(refs, opts.initialQuery || "").slice(0, MAX_ROWS);
  let active = 0;

  const el = document.createElement("div");
  el.className = "wikilink-popup citation-popup";
  el.setAttribute("role", "listbox");
  document.body.appendChild(el);

  function render() {
    el.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "wikilink-popup-empty";
      empty.textContent = "No matching references.";
      el.appendChild(empty);
      return;
    }
    filtered.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "wikilink-popup-row" + (i === active ? " active" : "");
      row.setAttribute("role", "option");
      row.dataset.index = String(i);

      const key = document.createElement("span");
      key.className = "citation-popup-key";
      key.textContent = "@" + (r.citekey || r.key);
      row.appendChild(key);

      const main = document.createElement("span");
      main.className = "wikilink-popup-main";
      main.textContent = r.shortTitle || r.title;
      row.appendChild(main);

      const meta = document.createElement("span");
      meta.className = "wikilink-popup-path";
      meta.textContent = [r.firstAuthor, r.year].filter(Boolean).join(" ");
      row.appendChild(meta);

      // mousedown so the pick fires before the editor's blur.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        active = i;
        commit();
      });
      row.addEventListener("mouseenter", () => {
        active = i;
        for (const child of el.querySelectorAll(".wikilink-popup-row")) {
          child.classList.toggle("active", Number(child.dataset.index) === active);
        }
      });
      el.appendChild(row);
    });
  }

  function position(rect) {
    const margin = 4;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    el.style.left = `${Math.max(8, Math.min(rect.left, vw - 420))}px`;
    el.style.top = `${rect.bottom + margin}px`;
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      const h = el.getBoundingClientRect().height;
      if (rect.bottom + margin + h > vh - 8 && rect.top - margin - h > 8) {
        el.style.top = `${rect.top - margin - h}px`;
      }
      el.style.visibility = "visible";
    });
  }

  function commit() {
    const picked = filtered[active];
    opts.onPick?.(picked || null);
  }

  render();
  if (opts.anchor) position(opts.anchor);

  return {
    el,
    update(query) {
      filtered = fuzzySearch(refs, query || "").slice(0, MAX_ROWS);
      active = 0;
      render();
    },
    moveSelection(delta) {
      if (!filtered.length) return;
      active = (active + delta + filtered.length) % filtered.length;
      for (const child of el.querySelectorAll(".wikilink-popup-row")) {
        child.classList.toggle("active", Number(child.dataset.index) === active);
      }
    },
    commit,
    setAnchor(rect) {
      if (rect) position(rect);
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    isEmpty() {
      return filtered.length === 0;
    },
  };
}
