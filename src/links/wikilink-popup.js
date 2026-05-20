/**
 * Floating wikilink search popup. Triggered when the user types `[[` in
 * a doc or in a notebook text shape; lists every linkable note, narrows
 * by typed query, commits on Enter / click. The popup is anchored to a
 * caller-provided screen point (caret coords in docs; just below the
 * textarea in notebooks).
 *
 * The popup is a thin presentational widget — it reads notes via the
 * caller's `getNotes()` callback so doc and notebook contexts can pre-
 * filter (e.g. exclude the active file from its own search). It owns no
 * state beyond the visible list + highlight index.
 */

import { filterNotes } from "./wikilink-index.js";

/** Mount a wikilink popup. Returns a handle with:
 *    update(query)         — re-filter and re-render
 *    moveSelection(delta)  — bump the highlighted row
 *    commit()              — fire `onPick` with the active row, if any
 *    setAnchor(rect)       — reposition the popup near a new caret point
 *    destroy()             — unmount and detach listeners
 *
 *  Options:
 *    notes      — initial full list of linkable notes
 *    excludeId  — node id to hide (the active note)
 *    onPick     — called with the chosen note when Enter / click
 *    onDismiss  — called when the user types something that aborts the
 *                 search (closing `]]`, Esc, click outside, etc.) — the
 *                 caller is responsible for calling destroy() in
 *                 response if appropriate
 *    anchor     — initial { left, top, bottom } in viewport coords; the
 *                 popup positions itself just below `bottom` and aligns
 *                 its left edge to `left` (flipping above when the
 *                 viewport bottom would clip it)
 *    initialQuery — seed query (popup starts visible if non-empty)
 */
export function openWikilinkPopup(opts) {
  const notes = (opts.notes || []).filter((n) =>
    opts.excludeId ? n.nodeId !== opts.excludeId : true,
  );
  let filtered = filterNotes(notes, opts.initialQuery || "");
  let active = 0;

  const el = document.createElement("div");
  el.className = "wikilink-popup";
  el.setAttribute("role", "listbox");
  document.body.appendChild(el);

  function render() {
    el.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "wikilink-popup-empty";
      empty.textContent = "No matches — press Enter to create.";
      el.appendChild(empty);
      return;
    }
    filtered.forEach((n, i) => {
      const row = document.createElement("div");
      row.className = "wikilink-popup-row" + (i === active ? " active" : "");
      row.setAttribute("role", "option");
      row.dataset.index = String(i);

      const icon = document.createElement("span");
      icon.className = "wikilink-popup-icon";
      icon.textContent = n.type === "notebook" ? "◧" : "—";
      row.appendChild(icon);

      const main = document.createElement("span");
      main.className = "wikilink-popup-main";
      main.textContent = n.name;
      row.appendChild(main);

      if (n.path) {
        const path = document.createElement("span");
        path.className = "wikilink-popup-path";
        path.textContent = n.path;
        row.appendChild(path);
      }

      // Use mousedown so the click fires before the source input's blur
      // tears the popup down. preventDefault keeps focus on the caller.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        active = i;
        commit();
      });
      row.addEventListener("mouseenter", () => {
        active = i;
        // No full re-render — just toggle the active class.
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
    el.style.left = `${Math.max(8, Math.min(rect.left, vw - 360))}px`;
    // Render first so we can measure height; reposition above if needed.
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
    if (picked) opts.onPick?.(picked);
    else opts.onPick?.(null); // null tells the caller to honour the literal typed text
  }

  render();
  if (opts.anchor) position(opts.anchor);

  return {
    el,
    update(query) {
      filtered = filterNotes(notes, query || "");
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
