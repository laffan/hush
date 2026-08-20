/**
 * Floating Zotero citation search popup. Triggered when the user types
 * `[@` in a doc. Unlike the wikilink popup (where the query lives in
 * the document), this one carries its own search input — focus jumps
 * into it on open so the user can fuzzy-search by title, author, year,
 * or citekey exactly like the Insert Reference modal. Enter / click
 * commits, Esc or a click outside dismisses.
 */

import { fuzzySearch } from "../zotero.js";

const MAX_ROWS = 12;

/** Mount a citation popup. Returns a handle:
 *    moveSelection(delta) — bump the highlighted row
 *    commit()             — fire `onPick` with the active row
 *    setAnchor(rect)      — reposition near a new caret point
 *    destroy()            — unmount and detach listeners
 *
 *  Options:
 *    refs         — full Zotero reference list ({ key, title, citekey, … })
 *    onPick       — called with the chosen reference on commit
 *    onDismiss    — called when the user aborts (Esc / click outside);
 *                   the caller closes the popup and restores focus
 *    anchor       — initial { left, top, bottom } viewport coords
 *    initialQuery — seeds the search input (anything typed after `[@`
 *                   before the popup opened)
 */
export function openCitationPopup(opts) {
  const refs = opts.refs || [];
  let filtered = fuzzySearch(refs, opts.initialQuery || "").slice(0, MAX_ROWS);
  let active = 0;

  const el = document.createElement("div");
  el.className = "wikilink-popup citation-popup";
  document.body.appendChild(el);

  const inputRow = document.createElement("div");
  inputRow.className = "citation-popup-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "citation-popup-input";
  input.placeholder = "Search Zotero library...";
  input.value = opts.initialQuery || "";
  inputRow.appendChild(input);
  el.appendChild(inputRow);

  const results = document.createElement("div");
  results.className = "citation-popup-results";
  results.setAttribute("role", "listbox");
  el.appendChild(results);

  function render() {
    results.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "wikilink-popup-empty";
      empty.textContent = "No matching references.";
      results.appendChild(empty);
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

      // mousedown so the pick fires before the input's blur.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        active = i;
        commit();
      });
      row.addEventListener("mouseenter", () => {
        active = i;
        for (const child of results.querySelectorAll(".wikilink-popup-row")) {
          child.classList.toggle("active", Number(child.dataset.index) === active);
        }
      });
      results.appendChild(row);
    });
  }

  function moveSelection(delta) {
    if (!filtered.length) return;
    active = (active + delta + filtered.length) % filtered.length;
    for (const child of results.querySelectorAll(".wikilink-popup-row")) {
      const isActive = Number(child.dataset.index) === active;
      child.classList.toggle("active", isActive);
      if (isActive) child.scrollIntoView({ block: "nearest" });
    }
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
      // Focus only lands once the popup is actually rendered: the
      // flip-above measurement above parks it at `visibility: hidden`
      // for a frame, and `focus()` on a non-rendered element is a
      // no-op — which is how the caret used to stay in the document
      // and every keystroke went on widening the `[@…` instead of
      // filtering the list.
      focusInput();
    });
  }

  /** Put the caret in the search field, at the end of any seeded
   *  query. Safe to call repeatedly; a no-op once the popup is gone. */
  function focusInput() {
    if (!el.isConnected) return;
    if (document.activeElement === input) return; // don't yank a mid-word caret
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function commit() {
    const picked = filtered[active];
    if (picked) opts.onPick?.(picked);
    else opts.onDismiss?.();
  }

  input.addEventListener("input", () => {
    filtered = fuzzySearch(refs, input.value || "").slice(0, MAX_ROWS);
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); opts.onDismiss?.(); }
  });

  // Click outside aborts — deferred a tick so the mousedown that may
  // have caused the popup to open doesn't immediately dismiss it.
  function onDocMousedown(e) {
    if (!el.contains(e.target)) opts.onDismiss?.();
  }
  setTimeout(() => document.addEventListener("mousedown", onDocMousedown), 0);

  render();
  if (opts.anchor) position(opts.anchor);
  // `position` re-focuses after the popup is visible; this first call
  // covers the anchorless case (nothing hides the popup, so it takes
  // effect immediately).
  focusInput();

  return {
    el,
    moveSelection,
    commit,
    setAnchor(rect) {
      if (rect) position(rect);
    },
    destroy() {
      document.removeEventListener("mousedown", onDocMousedown);
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
